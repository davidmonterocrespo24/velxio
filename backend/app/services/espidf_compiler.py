from __future__ import annotations
"""
ESP-IDF Compilation Service for ESP32 targets.

Replaces arduino-cli for ESP32/ESP32-C3 compilation.  User Arduino sketches
are compiled using ESP-IDF (with optional Arduino-as-component) to produce
firmware that boots reliably in the lcgamboa QEMU fork.

The key difference vs arduino-cli: ESP-IDF gives control over bootloader,
sdkconfig, and flash mapping — all of which must be QEMU-compatible.

Two compilation modes:
  1. Arduino-as-component: Full Arduino API (WiFi.h, WebServer.h, etc.)
     compiled through idf.py.  Requires ARDUINO_ESP32_PATH env var.
  2. Pure ESP-IDF: Translates common Arduino patterns to ESP-IDF C APIs.
     Fallback when Arduino component is not installed.
"""
import asyncio
import base64
import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Location of the ESP-IDF project template (relative to this file)
_TEMPLATE_DIR = Path(__file__).parent / 'esp-idf-template'

# Static IP that matches slirp DHCP range (first client = x.x.x.15)
_STATIC_IP = '192.168.4.15'
_GATEWAY_IP = '192.168.4.2'
_NETMASK = '255.255.255.0'

# SSID the QEMU WiFi AP broadcasts
_QEMU_WIFI_SSID = 'Velxio-GUEST'


class ESPIDFCompiler:
    """Compile Arduino sketches using ESP-IDF for QEMU-compatible output."""

    def __init__(self):
        self.idf_path = os.environ.get('IDF_PATH', '')
        self.arduino_path = os.environ.get('ARDUINO_ESP32_PATH', '')
        self.has_arduino = bool(self.arduino_path) and os.path.isdir(self.arduino_path)

        # Try common locations on Windows dev machines
        if not self.idf_path:
            for candidate in [
                r'C:\Espressif\frameworks\esp-idf-v4.4.7',
                r'C:\esp\esp-idf',
                '/opt/esp-idf',
            ]:
                if os.path.isdir(candidate):
                    self.idf_path = candidate
                    break

        # Auto-detect Arduino-as-component if not explicitly set
        if self.idf_path and not self.has_arduino:
            for candidate in [
                r'C:\Espressif\components\arduino-esp32',
                os.path.join(self.idf_path, '..', 'components', 'arduino-esp32'),
                '/opt/arduino-esp32',
            ]:
                if os.path.isdir(candidate):
                    self.arduino_path = os.path.abspath(candidate)
                    self.has_arduino = True
                    break

        if self.idf_path:
            logger.info(f'[espidf] IDF_PATH={self.idf_path}')
            if self.has_arduino:
                logger.info(f'[espidf] Arduino component: yes ({self.arduino_path})')
            else:
                logger.info('[espidf] Arduino component: no (pure ESP-IDF fallback)')
        else:
            logger.warning('[espidf] IDF_PATH not set — ESP-IDF compilation unavailable')

    @property
    def available(self) -> bool:
        """Whether ESP-IDF toolchain is available."""
        return bool(self.idf_path) and os.path.isdir(self.idf_path)

    def _is_esp32c3(self, board_fqbn: str) -> bool:
        """Return True if FQBN targets ESP32-C3 (RISC-V)."""
        return 'esp32c3' in board_fqbn or 'esp32-c3' in board_fqbn

    def _idf_target(self, board_fqbn: str) -> str:
        """Map FQBN to IDF_TARGET."""
        if self._is_esp32c3(board_fqbn):
            return 'esp32c3'
        # Default to esp32 (Xtensa) for all other ESP32 variants
        return 'esp32'

    def _detect_wifi_usage(self, code: str) -> bool:
        """Check if sketch uses WiFi."""
        return bool(re.search(r'#include\s*[<"]WiFi\.h[">]|WiFi\.begin\(', code))

    def _detect_webserver_usage(self, code: str) -> bool:
        """Check if sketch uses WebServer."""
        return bool(re.search(
            r'#include\s*[<"]WebServer\.h[">]|#include\s*[<"]ESP8266WebServer\.h[">]|WebServer\s+\w+',
            code
        ))

    def _translate_sketch_to_espidf(self, sketch_code: str) -> str:
        """
        Translate an Arduino WiFi+WebServer sketch to pure ESP-IDF C code.

        This handles the common pattern:
          - WiFi.begin("ssid", "pass") → esp_wifi_start() with static IP
          - WebServer server(80) + server.on("/", handler) → esp_http_server
          - digitalWrite/pinMode → gpio_set_level/gpio_set_direction

        Returns C source code for sketch_translated.c
        """
        uses_wifi = self._detect_wifi_usage(sketch_code)
        uses_webserver = self._detect_webserver_usage(sketch_code)

        # Extract route handlers from server.on() calls
        routes = []
        handler_bodies = {}
        if uses_webserver:
            # Match: server.on("/path", handler_func)
            # or:    server.on("/path", HTTP_GET, handler_func)
            for m in re.finditer(
                r'server\.on\(\s*"([^"]+)"\s*,\s*(?:HTTP_\w+\s*,\s*)?(\w+)\s*\)',
                sketch_code
            ):
                routes.append((m.group(1), m.group(2)))

            # Extract handler function bodies
            # Match: void handler_name() { ... server.send(...) ... }
            handler_bodies = {}
            for m in re.finditer(
                r'void\s+(\w+)\s*\(\s*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}',
                sketch_code,
                re.DOTALL
            ):
                fname = m.group(1)
                body = m.group(2)
                # Extract server.send() content
                send_match = re.search(
                    r'server\.send\s*\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"',
                    body
                )
                if not send_match:
                    # Try multi-line string or variable
                    send_match = re.search(
                        r'server\.send\s*\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\w+)',
                        body
                    )
                if send_match:
                    handler_bodies[fname] = {
                        'status': send_match.group(1),
                        'content_type': send_match.group(2),
                        'content': send_match.group(3),
                    }

        # Build the translated C source
        lines = []
        lines.append('/* Auto-translated from Arduino sketch to ESP-IDF */')
        lines.append('')

        if uses_wifi:
            lines.append(f'#define WIFI_SSID "{_QEMU_WIFI_SSID}"')
            lines.append('#define WIFI_PASS ""')
            lines.append(f'#define STATIC_IP "{_STATIC_IP}"')
            lines.append(f'#define GATEWAY_IP "{_GATEWAY_IP}"')
            lines.append(f'#define NETMASK "{_NETMASK}"')
            lines.append('')

        # Generate HTML content variables from handler bodies
        for fname, info in handler_bodies.items():
            content = info['content']
            if content.startswith('"') or content.startswith("'"):
                content = content.strip('"').strip("'")
            lines.append(f'static const char *{fname}_html = "{content}";')
        lines.append('')

        # Generate ESP-IDF HTTP handlers
        if uses_webserver:
            for path, handler_name in routes:
                info = handler_bodies.get(handler_name, {})
                ct = info.get('content_type', 'text/html')
                lines.append(f'static esp_err_t {handler_name}_handler(httpd_req_t *req) {{')
                lines.append(f'    httpd_resp_set_type(req, "{ct}");')
                if handler_name in handler_bodies:
                    lines.append(f'    return httpd_resp_send(req, {handler_name}_html, HTTPD_RESP_USE_STRLEN);')
                else:
                    lines.append(f'    return httpd_resp_send(req, "OK", 2);')
                lines.append('}')
                lines.append('')

        # Generate webserver start function
        if uses_webserver:
            lines.append('static void start_webserver(void) {')
            lines.append('    httpd_config_t config = HTTPD_DEFAULT_CONFIG();')
            lines.append('    httpd_handle_t server = NULL;')
            lines.append('    if (httpd_start(&server, &config) == ESP_OK) {')
            for path, handler_name in routes:
                uri_var = handler_name + '_uri'
                lines.append(f'        httpd_uri_t {uri_var} = {{')
                lines.append(f'            .uri = "{path}",')
                lines.append(f'            .method = HTTP_GET,')
                lines.append(f'            .handler = {handler_name}_handler')
                lines.append(f'        }};')
                lines.append(f'        httpd_register_uri_handler(server, &{uri_var});')
            lines.append('    }')
            lines.append('}')
            lines.append('')

        # WiFi event handler + init
        if uses_wifi:
            lines.append('static EventGroupHandle_t s_wifi_event_group;')
            lines.append('#define WIFI_CONNECTED_BIT BIT0')
            lines.append('')
            lines.append('static void wifi_event_handler(void *arg, esp_event_base_t base,')
            lines.append('                               int32_t id, void *data) {')
            lines.append('    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START)')
            lines.append('        esp_wifi_connect();')
            lines.append('    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED)')
            lines.append('        esp_wifi_connect();')
            lines.append('    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP)')
            lines.append('        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);')
            lines.append('}')
            lines.append('')
            lines.append('static void wifi_init_sta(void) {')
            lines.append('    s_wifi_event_group = xEventGroupCreate();')
            lines.append('    esp_netif_init();')
            lines.append('    esp_event_loop_create_default();')
            lines.append('    esp_netif_t *sta = esp_netif_create_default_wifi_sta();')
            lines.append('    esp_netif_dhcpc_stop(sta);')
            lines.append('    esp_netif_ip_info_t ip_info;')
            lines.append('    ip_info.ip.addr = ipaddr_addr(STATIC_IP);')
            lines.append('    ip_info.gw.addr = ipaddr_addr(GATEWAY_IP);')
            lines.append('    ip_info.netmask.addr = ipaddr_addr(NETMASK);')
            lines.append('    esp_netif_set_ip_info(sta, &ip_info);')
            lines.append('    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();')
            lines.append('    esp_wifi_init(&cfg);')
            lines.append('    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,')
            lines.append('        &wifi_event_handler, NULL, NULL);')
            lines.append('    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,')
            lines.append('        &wifi_event_handler, NULL, NULL);')
            lines.append('    wifi_config_t wifi_config = {')
            lines.append('        .sta = {')
            lines.append('            .ssid = WIFI_SSID,')
            lines.append('            .password = WIFI_PASS,')
            lines.append('            .threshold.authmode = WIFI_AUTH_OPEN,')
            lines.append('        },')
            lines.append('    };')
            lines.append('    esp_wifi_set_mode(WIFI_MODE_STA);')
            lines.append('    esp_wifi_set_config(WIFI_IF_STA, &wifi_config);')
            lines.append('    esp_wifi_start();')
            lines.append('}')
            lines.append('')

        # app_main
        lines.append('void app_main(void) {')
        if uses_wifi:
            lines.append('    esp_err_t ret = nvs_flash_init();')
            lines.append('    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {')
            lines.append('        nvs_flash_erase();')
            lines.append('        nvs_flash_init();')
            lines.append('    }')
            lines.append('    wifi_init_sta();')
            lines.append('    vTaskDelay(pdMS_TO_TICKS(3000));')
        if uses_webserver:
            lines.append('    start_webserver();')
        lines.append('    while (1) {')
        lines.append('        vTaskDelay(pdMS_TO_TICKS(1000));')
        lines.append('    }')
        lines.append('}')

        return '\n'.join(lines) + '\n'

    def _build_env(self, idf_target: str) -> dict:
        """Build environment dict for ESP-IDF subprocess."""
        env = os.environ.copy()
        env['IDF_PATH'] = self.idf_path
        env['IDF_TARGET'] = idf_target

        if self.has_arduino:
            env['ARDUINO_ESP32_PATH'] = self.arduino_path

        # On Windows, ESP-IDF uses its own Python venv
        if os.name == 'nt':
            py_venv = os.path.join(
                os.path.dirname(self.idf_path), '..',
                'python_env', 'idf4.4_py3.10_env'
            )
            # Also try the standard Espressif location
            if not os.path.isdir(py_venv):
                py_venv = r'C:\Espressif\python_env\idf4.4_py3.10_env'

            if os.path.isdir(py_venv):
                py_scripts = os.path.join(py_venv, 'Scripts')
                env['PATH'] = py_scripts + os.pathsep + env.get('PATH', '')
                env['VIRTUAL_ENV'] = py_venv

            # Add ESP-IDF tools to PATH
            tools_path = os.environ.get('IDF_TOOLS_PATH', r'C:\Users\David\.espressif')
            if os.path.isdir(tools_path):
                # Add all tool bin dirs
                for tool_dir in Path(tools_path).glob('tools/*/*/bin'):
                    env['PATH'] = str(tool_dir) + os.pathsep + env['PATH']
                # Xtensa toolchain
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp32-elf/*/xtensa-esp32-elf/bin'):
                    env['PATH'] = str(tc_dir) + os.pathsep + env['PATH']
                for tc_dir in Path(tools_path).glob('tools/riscv32-esp-elf/*/riscv32-esp-elf/bin'):
                    env['PATH'] = str(tc_dir) + os.pathsep + env['PATH']
        else:
            # Linux/Docker: source export.sh environment
            tools_path = os.environ.get('IDF_TOOLS_PATH', os.path.expanduser('~/.espressif'))
            env['IDF_TOOLS_PATH'] = tools_path

        return env

    def _merge_flash_image(self, build_dir: Path, is_c3: bool) -> Path:
        """Merge bootloader + partitions + app into 4MB flash image."""
        FLASH_SIZE = 4 * 1024 * 1024
        flash = bytearray(b'\xff' * FLASH_SIZE)

        bootloader_offset = 0x0000 if is_c3 else 0x1000

        # ESP-IDF build output paths
        bootloader = build_dir / 'bootloader' / 'bootloader.bin'
        partitions = build_dir / 'partition_table' / 'partition-table.bin'
        app = build_dir / 'velxio-sketch.bin'

        if not app.exists():
            # Try alternate names
            for pattern in ['*.bin']:
                candidates = [f for f in build_dir.glob(pattern)
                              if 'bootloader' not in f.name and 'partition' not in f.name]
                if candidates:
                    app = candidates[0]
                    break

        files_found = {
            'bootloader': bootloader.exists(),
            'partitions': partitions.exists(),
            'app': app.exists(),
        }
        logger.info(f'[espidf] Merge files: {files_found}')

        if not all(files_found.values()):
            missing = [k for k, v in files_found.items() if not v]
            raise FileNotFoundError(f'Missing binaries for merge: {missing}')

        for offset, path in [
            (bootloader_offset, bootloader),
            (0x8000, partitions),
            (0x10000, app),
        ]:
            data = path.read_bytes()
            flash[offset:offset + len(data)] = data
            logger.info(f'[espidf] Placed {path.name} at 0x{offset:04X} ({len(data)} bytes)')

        merged_path = build_dir / 'merged_flash.bin'
        merged_path.write_bytes(bytes(flash))
        logger.info(f'[espidf] Merged flash image: {merged_path.stat().st_size} bytes')
        return merged_path

    async def compile(self, files: list[dict], board_fqbn: str) -> dict:
        """
        Compile Arduino sketch using ESP-IDF.

        Returns dict compatible with ArduinoCLIService.compile():
            success, binary_content (base64), binary_type, stdout, stderr, error
        """
        if not self.available:
            return {
                'success': False,
                'error': 'ESP-IDF toolchain not found. Set IDF_PATH environment variable.',
                'stdout': '',
                'stderr': '',
            }

        idf_target = self._idf_target(board_fqbn)
        is_c3 = self._is_esp32c3(board_fqbn)

        logger.info(f'[espidf] Compiling for {idf_target} (FQBN: {board_fqbn})')
        logger.info(f'[espidf] Files: {[f["name"] for f in files]}')

        with tempfile.TemporaryDirectory(prefix='espidf_') as temp_dir:
            project_dir = Path(temp_dir) / 'project'

            # Copy template
            shutil.copytree(_TEMPLATE_DIR, project_dir)

            # Get sketch content
            main_content = ''
            for f in files:
                if f['name'].endswith('.ino'):
                    main_content = f['content']
                    break
            if not main_content and files:
                main_content = files[0]['content']

            # Auto-fix missing channel argument in WiFi.begin for QEMU compatibility
            # QEMU's mock WiFi AP is on channel 6, and active scanning hangs the simulator.
            # Match WiFi.begin(...) without a channel, catching both literals and variables.
            # 1 arg: WiFi.begin(ssid) -> WiFi.begin(ssid, "", 6)
            main_content = re.sub(
                r'WiFi\.begin\s*\(\s*([^,]+?)\s*\)',
                r'WiFi.begin(\1, "", 6)',
                main_content
            )
            # 2 args: WiFi.begin(ssid, pass) -> WiFi.begin(ssid, pass, 6)
            # Exclude matching if the second arg is obviously an int channel (which is wrong but possible)
            # We match if there are exactly two args. We have to be careful with commas.
            main_content = re.sub(
                r'WiFi\.begin\s*\(\s*([^,]+?)\s*,\s*([^,]+?)\s*\)',
                r'WiFi.begin(\1, \2, 6)',
                main_content
            )
            
            # Since QEMU's AP accepts any SSID (as long as it's on channel 6),
            # we let the user use Velxio-GUEST or whatever they want.

            if self.has_arduino:
                # Arduino-as-component mode: copy sketch as .cpp
                sketch_cpp = project_dir / 'main' / 'sketch.ino.cpp'
                # Prepend Arduino.h if not already included
                if '#include' not in main_content or 'Arduino.h' not in main_content:
                    main_content = '#include "Arduino.h"\n' + main_content
                sketch_cpp.write_text(main_content, encoding='utf-8')

                # Copy additional files (.h, .cpp)
                for f in files:
                    if not f['name'].endswith('.ino'):
                        (project_dir / 'main' / f['name']).write_text(
                            f['content'], encoding='utf-8'
                        )

                # Remove the pure-C main to avoid conflict
                main_c = project_dir / 'main' / 'main.c'
                if main_c.exists():
                    main_c.unlink()
                sketch_translated = project_dir / 'main' / 'sketch_translated.c'
                if sketch_translated.exists():
                    sketch_translated.unlink()
            else:
                # Pure ESP-IDF mode: translate sketch
                translated = self._translate_sketch_to_espidf(main_content)
                (project_dir / 'main' / 'sketch_translated.c').write_text(
                    translated, encoding='utf-8'
                )

                # Remove Arduino main.cpp to avoid conflict
                main_cpp = project_dir / 'main' / 'main.cpp'
                if main_cpp.exists():
                    main_cpp.unlink()

            # Build using cmake + ninja (more portable than idf.py on Windows)
            build_dir = project_dir / 'build'
            build_dir.mkdir(exist_ok=True)

            env = self._build_env(idf_target)

            # Step 1: cmake configure
            cmake_cmd = [
                'cmake',
                '-G', 'Ninja',
                '-Wno-dev',
                f'-DIDF_TARGET={idf_target}',
                '-DCMAKE_BUILD_TYPE=Release',
                f'-DSDKCONFIG_DEFAULTS={project_dir / "sdkconfig.defaults"}',
                str(project_dir),
            ]

            logger.info(f'[espidf] cmake: {" ".join(cmake_cmd)}')

            def _run_cmake():
                return subprocess.run(
                    cmake_cmd,
                    cwd=str(build_dir),
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=120,
                )

            try:
                cmake_result = await asyncio.to_thread(_run_cmake)
            except subprocess.TimeoutExpired:
                return {
                    'success': False,
                    'error': 'ESP-IDF cmake configure timed out (120s)',
                    'stdout': '',
                    'stderr': '',
                }

            if cmake_result.returncode != 0:
                logger.error(f'[espidf] cmake failed:\n{cmake_result.stderr}')
                return {
                    'success': False,
                    'error': 'ESP-IDF cmake configure failed',
                    'stdout': cmake_result.stdout,
                    'stderr': cmake_result.stderr,
                }

            # Step 2: ninja build
            ninja_cmd = ['ninja']
            logger.info('[espidf] Building with ninja...')

            def _run_ninja():
                return subprocess.run(
                    ninja_cmd,
                    cwd=str(build_dir),
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=300,
                )

            try:
                ninja_result = await asyncio.to_thread(_run_ninja)
            except subprocess.TimeoutExpired:
                return {
                    'success': False,
                    'error': 'ESP-IDF build timed out (300s)',
                    'stdout': '',
                    'stderr': '',
                }

            all_stdout = cmake_result.stdout + '\n' + ninja_result.stdout
            all_stderr = cmake_result.stderr + '\n' + ninja_result.stderr

            # Filter out expected but ugly warnings from stderr (e.g. absent git, cmake deprecation)
            filtered_stderr_lines = []
            for line in all_stderr.splitlines():
                if 'fatal: not a git repository' in line:
                    continue
                if 'CMake Deprecation Warning' in line:
                    continue
                if 'Compatibility with CMake' in line:
                    continue
                filtered_stderr_lines.append(line)
            all_stderr = '\n'.join(filtered_stderr_lines)

            if ninja_result.returncode != 0:
                logger.error(f'[espidf] ninja build failed:\n{ninja_result.stderr}')
                return {
                    'success': False,
                    'error': 'ESP-IDF build failed',
                    'stdout': all_stdout,
                    'stderr': all_stderr,
                }

            # Step 3: Merge binaries into flash image
            try:
                merged_path = self._merge_flash_image(build_dir, is_c3)
            except FileNotFoundError as exc:
                return {
                    'success': False,
                    'error': f'Binary merge failed: {exc}',
                    'stdout': all_stdout,
                    'stderr': all_stderr,
                }

            binary_b64 = base64.b64encode(merged_path.read_bytes()).decode('ascii')
            logger.info(f'[espidf] Compilation successful — {len(binary_b64) // 1024} KB (base64)')

            return {
                'success': True,
                'hex_content': None,
                'binary_content': binary_b64,
                'binary_type': 'bin',
                'stdout': all_stdout,
                'stderr': all_stderr,
            }


# Singleton instance
espidf_compiler = ESPIDFCompiler()

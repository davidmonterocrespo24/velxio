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

# SSID the QEMU WiFi AP broadcasts.
# Must match one of the access_point_info entries in esp32_wifi_ap.c
# (the lcgamboa QEMU fork). "Espressif" is on channel 5 in that array.
_QEMU_WIFI_SSID = 'Espressif'
_QEMU_WIFI_CHANNEL = 5


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

    def _normalize_wifi_for_qemu(self, code: str) -> str:
        """
        Normalize WiFi SSID/password/channel in Arduino sketches for QEMU.

        QEMU's WiFi AP broadcasts _QEMU_WIFI_SSID on _QEMU_WIFI_CHANNEL with open auth.
        This method rewrites the user's sketch so that:
          - Any SSID string literal → _QEMU_WIFI_SSID
          - Password → "" (open auth)
          - Channel → _QEMU_WIFI_CHANNEL
        The user's editor still shows their original code; only the compiled
        binary is modified.
        """
        if not self._detect_wifi_usage(code):
            return code

        # 1) Replace SSID variable definitions:
        #    const char* ssid = "anything" → _QEMU_WIFI_SSID
        #    char ssid[] = "anything"      → _QEMU_WIFI_SSID
        #    #define WIFI_SSID "anything"   → _QEMU_WIFI_SSID
        code = re.sub(
            r'((?:const\s+)?char\s*\*?\s*ssid\s*\[?\]?\s*=\s*)"[^"]*"',
            rf'\1"{_QEMU_WIFI_SSID}"',
            code,
            flags=re.IGNORECASE
        )
        code = re.sub(
            r'(#define\s+\w*SSID\w*\s+)"[^"]*"',
            rf'\1"{_QEMU_WIFI_SSID}"',
            code,
            flags=re.IGNORECASE
        )

        # 2) Normalize WiFi.begin() calls:
        #    WiFi.begin("X")           → WiFi.begin(_QEMU_WIFI_SSID, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin("X", "pass")   → WiFi.begin(_QEMU_WIFI_SSID, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin(ssid, pass, N) → WiFi.begin(ssid, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin(ssid)          → WiFi.begin(ssid, "", _QEMU_WIFI_CHANNEL)

        def _rewrite_wifi_begin(m: re.Match) -> str:
            args = m.group(1)
            parts = [a.strip() for a in args.split(',')]
            ssid_arg = parts[0]
            # If SSID is a string literal, force to _QEMU_WIFI_SSID
            if ssid_arg.startswith('"'):
                ssid_arg = f'"{_QEMU_WIFI_SSID}"'
            return f'WiFi.begin({ssid_arg}, "", {_QEMU_WIFI_CHANNEL})'

        code = re.sub(
            r'WiFi\.begin\s*\(([^)]+)\)',
            _rewrite_wifi_begin,
            code
        )

        logger.info('[espidf] WiFi normalized: SSID→%s, channel→%d, open auth', _QEMU_WIFI_SSID, _QEMU_WIFI_CHANNEL)
        return code

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

    def _find_arduino_libraries_dir(self) -> Path | None:
        """Find the Arduino global user-libraries directory (installed via arduino-cli)."""
        candidates = [
            Path.home() / 'Arduino' / 'libraries',
            Path.home() / 'Documents' / 'Arduino' / 'libraries',
            Path('/root/Arduino/libraries'),              # Docker / CI as root
            Path('/home/user/Arduino/libraries'),
            Path('/Arduino/libraries'),
        ]
        # Also check arduino-cli's data directory
        for base in [
            Path.home() / '.arduino15',
            Path('/root/.arduino15'),
            Path('/home/user/.arduino15'),
        ]:
            candidates.append(base / 'libraries')

        for c in candidates:
            if c.is_dir():
                logger.info(f'[espidf] Arduino libraries dir: {c}')
                return c
        logger.warning('[espidf] Arduino libraries dir not found')
        return None

    # Headers that will NEVER appear in any Arduino library directory:
    #   - C/C++ standard library headers
    #   - Arduino core API types compiled directly into arduino-esp32 (not installable)
    #
    # Everything else (Wire.h, SPI.h, WiFi.h, Adafruit_GFX.h, …) is resolved
    # dynamically: user-installed libs → IDF component; arduino-esp32 bundled
    # libs → skip (already compiled in); not found → warning.
    _BUILTIN_HEADERS = frozenset({
        # C/C++ standard library
        'math.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'string.h', 'stdarg.h',
        'stddef.h', 'stdbool.h', 'float.h', 'limits.h', 'assert.h',
        # Arduino core types — part of arduino-esp32 source, not installable libraries
        'Arduino.h', 'HardwareSerial.h', 'Stream.h', 'Print.h', 'WString.h',
        'pgmspace.h', 'IPAddress.h',
    })

    # Core arduino-esp32 bundled libraries — already compiled into the IDF component,
    # must NOT be duplicated as separate user_libs components.
    _CORE_ESP32_LIBS: frozenset[str] = frozenset({
        'Wire', 'SPI', 'WiFi', 'EEPROM', 'SD', 'FS',
        'LittleFS', 'SPIFFS', 'WebServer', 'HTTPClient',
        'WiFiClientSecure', 'BluetoothSerial', 'BLE',
        'Preferences', 'Update', 'Ticker',
    })

    def _resolve_library_components(
        self,
        ext_headers: list[str],
        arduino_libs: Path | None,
        esp32_libs: Path | None,
        arduino_comp_name: str,
        user_libs_dir: Path,
    ) -> tuple[list[str], dict[str, str]]:
        """
        BFS over ext_headers (and transitive includes) to discover all external
        Arduino libraries and merge them into a single 'user_libs_all' IDF component.

        All library files are copied flat into one directory, so every header is
        visible to every other header and source file without any cross-component
        REQUIRES propagation — which is unreliable in ESP-IDF 4.x for deeply
        nested transitive dependencies.

        Search priority per header:
          1. arduino_libs (user-installed via Library Manager) → merge into component
          2. esp32_libs   (bundled with arduino-esp32) → skip core libs (Wire, SPI, …);
             merge non-core libs (e.g. Adafruit libs shipped with arduino-esp32)
          3. not found → warning only

        Returns:
            component_names  — ['user_libs_all'] if any lib found, else []
            header_to_comp   — every resolved header → 'user_libs_all'
        """
        logger.info(f'[espidf] ext_headers detected: {ext_headers}')
        logger.info(f'[espidf] arduino_libs: {arduino_libs}')
        logger.info(f'[espidf] esp32_libs: {esp32_libs}')

        comp_dir = user_libs_dir / 'user_libs_all'
        comp_dir.mkdir(exist_ok=True)

        cpp_files: list[str] = []
        seen_names: set[str] = set()
        header_to_comp: dict[str, str] = {}
        found_any = False

        headers_to_resolve: list[str] = list(ext_headers)
        resolved_headers: set[str] = set()

        while headers_to_resolve:
            header = headers_to_resolve.pop(0)
            if header in resolved_headers:
                continue
            resolved_headers.add(header)

            src_root = (
                self._find_library_for_header(header, arduino_libs)
                if arduino_libs and arduino_libs.is_dir()
                else None
            )

            if src_root is None and esp32_libs and esp32_libs.is_dir():
                esp32_root = self._find_library_for_header(header, esp32_libs)
                if esp32_root:
                    lib_name = esp32_root.parent.name if esp32_root.name == 'src' else esp32_root.name
                    if lib_name in self._CORE_ESP32_LIBS:
                        logger.debug(f'[espidf] <{header}> is bundled core lib "{lib_name}", skipping')
                    else:
                        logger.info(f'[espidf] <{header}> found in esp32_libs as "{lib_name}", merging')
                        src_root = esp32_root

            if src_root:
                lib_dir_name = src_root.parent.name if src_root.name == 'src' else src_root.name
                logger.info(f'[espidf] Merging "{lib_dir_name}" into user_libs_all for <{header}>')
                found_any = True
                header_to_comp[header] = 'user_libs_all'

                # Copy all source files flat into the merged component directory.
                # First-writer wins for name conflicts (rare across Arduino libs).
                for pattern in ('*.h', '*.cpp', '*.c', 'src/*.h', 'src/*.cpp', 'src/*.c'):
                    glob_root = src_root.parent if pattern.startswith('src/') else src_root
                    for f in glob_root.glob(pattern):
                        if not f.is_file():
                            continue
                        if f.name not in seen_names:
                            shutil.copy2(f, comp_dir / f.name)
                            seen_names.add(f.name)
                        if f.suffix in ('.cpp', '.c') and f.name not in cpp_files:
                            cpp_files.append(f.name)

                # Also handle libraries that use an src/ subdirectory layout.
                src_sub = (src_root / 'src') if (src_root / 'src').is_dir() else None
                if src_sub is None and (src_root.parent / 'src').is_dir():
                    src_sub = src_root.parent / 'src'
                if src_sub:
                    for f in src_sub.glob('**/*'):
                        if not f.is_file() or f.suffix not in ('.h', '.cpp', '.c'):
                            continue
                        if f.name not in seen_names:
                            shutil.copy2(f, comp_dir / f.name)
                            seen_names.add(f.name)
                        if f.suffix in ('.cpp', '.c') and f.name not in cpp_files:
                            cpp_files.append(f.name)

                # Scan newly copied headers for transitive includes.
                for lib_file in comp_dir.glob('*.h'):
                    try:
                        lib_content = lib_file.read_text(encoding='utf-8', errors='ignore')
                        for th in self._detect_external_includes(lib_content):
                            if th not in resolved_headers:
                                headers_to_resolve.append(th)
                    except OSError:
                        pass
            else:
                logger.warning(f'[espidf] Library for <{header}> not found — build may fail')

        if not found_any:
            return [], {}

        srcs_line = 'SRCS ' + ' '.join(f'"{f}"' for f in sorted(cpp_files)) if cpp_files else ''
        cmake_content = (
            '# Auto-generated by Velxio — all user libraries merged into one component.\n'
            '# Single flat directory: every header sees every other header without\n'
            '# cross-component REQUIRES propagation.\n'
            'idf_component_register(\n'
            f'    {srcs_line}\n'
            '    INCLUDE_DIRS "."\n'
            f'    REQUIRES {arduino_comp_name}\n'
            ')\n'
        )
        (comp_dir / 'CMakeLists.txt').write_text(cmake_content, encoding='utf-8')
        logger.info(
            f'[espidf] user_libs_all: {len(cpp_files)} source files, '
            f'{len(header_to_comp)} resolved headers'
        )
        return ['user_libs_all'], header_to_comp

    def _detect_external_includes(self, code: str) -> list[str]:
        """Return library header names that are likely from external libraries."""
        headers = []
        for m in re.finditer(r'#\s*include\s*<([^>]+)>', code):
            h = m.group(1)
            if h in self._BUILTIN_HEADERS:
                continue
            # Skip paths with / (esp-idf internal headers like freertos/FreeRTOS.h)
            if '/' in h:
                continue
            # Skip headers that look like esp-idf internal (prefix pattern)
            if re.match(r'^(esp_|driver/|soc/|hal/|nvs|rom/)', h):
                continue
            headers.append(h)
        return headers

    def _find_library_for_header(self, header: str, libs_dir: Path) -> Path | None:
        """
        Search libs_dir for a library that provides `header`.
        Returns the source root of the library (root or src/ subdirectory).
        """
        for lib_dir in sorted(libs_dir.iterdir()):
            if not lib_dir.is_dir():
                continue
            for src_root in [lib_dir, lib_dir / 'src']:
                if (src_root / header).exists():
                    return src_root
        return None

    def _create_idf_component(
        self,
        header: str,
        src_root: Path,
        user_libs_dir: Path,
        arduino_comp_name: str,
    ) -> str:
        """
        Create a proper ESP-IDF component for a library in user_libs_dir.

        Each library becomes user_libs/<comp_name>/ with its own CMakeLists.txt
        that calls idf_component_register(). This is the correct ESP-IDF way to
        include third-party code and properly handles include paths so that
        internal library includes like #include "utility/xyz.h" work correctly.

        Returns the component directory name (used in REQUIRES of main).
        """
        # Sanitise name: use the library directory name, not the header name
        # src_root may be the library root OR lib/src/ — handle both cases
        lib_dir_name = src_root.parent.name if src_root.name == 'src' else src_root.name
        safe_name = re.sub(r'[^A-Za-z0-9_]', '_', lib_dir_name)
        comp_dir = user_libs_dir / safe_name
        comp_dir.mkdir(parents=True, exist_ok=True)

        # Preserve the original library layout for actual buildable library code
        # while skipping repo-only content such as examples, tests, and CI files.
        lib_root = src_root.parent if src_root.name == 'src' else src_root
        include_dirs: set[str] = {'.'}
        cpp_files: set[str] = set()
        copied_any = False

        has_src_layout = (lib_root / 'src').is_dir()
        excluded_dirs = {
            '.git',
            '.github',
            '.vscode',
            '__pycache__',
            'docs',
            'doc',
            'example',
            'examples',
            'test',
            'tests',
            'extras',
            'ci',
            'fuzz',
            'fuzzing',
            'benchmark',
            'benchmarks',
        }

        def should_include(relative_path: Path) -> bool:
            parts = relative_path.parts
            if any(part.lower() in excluded_dirs for part in parts[:-1]):
                return False
            if relative_path.suffix not in ('.h', '.hpp', '.c', '.cpp'):
                return False

            if has_src_layout:
                return parts[0] == 'src' or len(parts) == 1

            return len(parts) == 1 or parts[0].lower() == 'utility'

        for f in lib_root.rglob('*'):
            if not f.is_file():
                continue
            rel_path = f.relative_to(lib_root)
            if not should_include(rel_path):
                continue
            dest = comp_dir / rel_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            copied_any = True
            include_dirs.add(str(rel_path.parent).replace('\\', '/'))
            if f.suffix in ('.cpp', '.c'):
                cpp_files.add(str(rel_path).replace('\\', '/'))

        if not copied_any:
            raise ValueError(f'No buildable source files found in library {lib_dir_name}')

        # Generate CMakeLists.txt for this component
        include_dirs.discard('.')
        ordered_include_dirs = ['.'] + sorted(d for d in include_dirs if d and d != '.')

        if cpp_files:
            srcs_line = 'SRCS ' + ' '.join(f'"{f}"' for f in sorted(cpp_files))
        else:
            srcs_line = '# header-only library'

        include_dirs_line = 'INCLUDE_DIRS ' + ' '.join(
            f'"{include_dir}"' for include_dir in ordered_include_dirs
        )

        cmake_content = (
            f'# Auto-generated by Velxio for library: {lib_dir_name}\n'
            f'idf_component_register(\n'
            f'    {srcs_line}\n'
            f'    {include_dirs_line}\n'
            f'    REQUIRES {arduino_comp_name}\n'
            f')\n'
        )
        (comp_dir / 'CMakeLists.txt').write_text(cmake_content, encoding='utf-8')

        logger.info(
            f'[espidf] Created IDF component "{safe_name}" for <{header}>'
            f' ({len(cpp_files)} source file(s))'
        )
        return safe_name

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
            # Linux/Docker: explicitly add toolchain bin dirs to PATH so cmake
            # can find the cross-compilers even when the process wasn't started
            # with export.sh (e.g. after a uvicorn restart or in tests).
            tools_path = os.environ.get('IDF_TOOLS_PATH', os.path.expanduser('~/.espressif'))
            env['IDF_TOOLS_PATH'] = tools_path
            if os.path.isdir(tools_path):
                extra_paths: list[str] = []
                # Xtensa toolchain (ESP32, ESP32-S3)
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp32-elf/*/xtensa-esp32-elf/bin'):
                    extra_paths.append(str(tc_dir))
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp-elf/*/xtensa-esp-elf/bin'):
                    extra_paths.append(str(tc_dir))
                # RISC-V toolchain (ESP32-C3)
                for tc_dir in Path(tools_path).glob('tools/riscv32-esp-elf/*/riscv32-esp-elf/bin'):
                    extra_paths.append(str(tc_dir))
                # ESP-IDF host tools (esptool, partition_table, etc.)
                for tool_dir in Path(tools_path).glob('tools/*/*/bin'):
                    extra_paths.append(str(tool_dir))
                if extra_paths:
                    env['PATH'] = os.pathsep.join(extra_paths) + os.pathsep + env.get('PATH', '')

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

            # ── QEMU WiFi compatibility ──────────────────────────────────────
            # QEMU's WiFi AP broadcasts "Velxio-GUEST" on channel 6.
            # We normalize ANY user SSID → "Velxio-GUEST", enforce channel 6,
            # and use open auth (empty password) so the connection always works.
            # Detect WiFi BEFORE normalization so the flag reflects the original sketch.
            has_wifi = self._detect_wifi_usage(main_content)
            main_content = self._normalize_wifi_for_qemu(main_content)

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

                # ── Resolve external Arduino libraries as IDF components ──────
                # arduino-cli installs libraries in ~/Arduino/libraries/ but the
                # ESP-IDF build system does not scan that path. We create a
                # user_libs/ directory where each external library becomes a
                # proper ESP-IDF component with its own CMakeLists.txt and
                # INCLUDE_DIRS. The root CMakeLists.txt (template) adds user_libs
                # to EXTRA_COMPONENT_DIRS so ESP-IDF discovers them automatically.
                ext_headers = self._detect_external_includes(main_content)
                component_names: list[str] = []
                # arduino-esp32 component name (directory basename of ARDUINO_ESP32_PATH)
                arduino_comp_name = Path(self.arduino_path).name if self.arduino_path else 'arduino-esp32'

                if ext_headers:
                    user_libs_dir = project_dir / 'user_libs'
                    user_libs_dir.mkdir(exist_ok=True)

                    esp32_libs   = Path(self.arduino_path) / 'libraries' if self.arduino_path else None
                    arduino_libs = self._find_arduino_libraries_dir()

                    component_names, _ = self._resolve_library_components(
                        ext_headers, arduino_libs, esp32_libs,
                        arduino_comp_name, user_libs_dir,
                    )

                # Patch main/CMakeLists.txt — REQUIRES and INCLUDE_DIRS for user_libs_all.
                # The single merged component means one entry covers all external headers.
                if component_names:  # always ['user_libs_all'] when any lib was found
                    cmake_path = project_dir / 'main' / 'CMakeLists.txt'
                    cmake_text = cmake_path.read_text(encoding='utf-8')

                    for old_req in [r'REQUIRES ${_arduino_comp_name}', f'REQUIRES {arduino_comp_name}']:
                        if old_req in cmake_text:
                            cmake_text = cmake_text.replace(
                                old_req, f'{old_req} user_libs_all'
                            )
                            break

                    cmake_text = cmake_text.replace(
                        'INCLUDE_DIRS "."',
                        'INCLUDE_DIRS "." "../user_libs/user_libs_all"',
                    )

                    cmake_path.write_text(cmake_text, encoding='utf-8')
                    logger.info('[espidf] Patched main CMakeLists: REQUIRES += user_libs_all, INCLUDE_DIRS += user_libs_all')
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
                # Extract the actual compiler errors from ninja's stdout.
                # Ninja prints failed job blocks in stdout:
                #   FAILED: path/to/file.obj
                #   <compiler command>
                #   sketch.ino.cpp:5:10: fatal error: DHT.h: No such file or directory
                #   compilation terminated.
                #   ninja: build stopped: subcommand failed.
                stdout_lines = ninja_result.stdout.split('\n')
                error_lines: list[str] = []
                in_failed_block = False
                for line in stdout_lines:
                    stripped = line.strip()
                    if stripped.startswith('FAILED:') or stripped == 'ninja: build stopped: subcommand failed.':
                        in_failed_block = True
                        error_lines.append(line)
                        continue
                    # Next [N/M] progress line ends the block
                    if in_failed_block and stripped.startswith('[') and '/' in stripped and ']' in stripped:
                        in_failed_block = False
                    if in_failed_block:
                        error_lines.append(line)
                    elif ': error:' in line or 'fatal error:' in line.lower():
                        # Explicit compiler error outside a FAILED block
                        error_lines.append(line)

                extracted = '\n'.join(l for l in error_lines if l.strip())

                # First non-FAILED, non-command error line → short summary for toolbar
                summary = 'ESP-IDF build failed'
                for l in error_lines:
                    s = l.strip()
                    if s and not s.startswith('FAILED:') and not s.startswith('ninja:') and not s.startswith('/') and 'error:' in s.lower():
                        summary = s
                        break
                if summary == 'ESP-IDF build failed' and error_lines:
                    # Fall back to first non-empty error line
                    for l in error_lines:
                        if l.strip() and not l.strip().startswith('FAILED:'):
                            summary = l.strip()
                            break

                # Put extracted errors in stderr so the console highlights them
                combined_stderr = (extracted + '\n\n' + all_stderr).strip() if extracted else all_stderr

                logger.error(f'[espidf] ninja build failed (stdout):\n{ninja_result.stdout[-4000:]}')
                logger.error(f'[espidf] ninja build failed (stderr):\n{ninja_result.stderr[-2000:]}')
                return {
                    'success': False,
                    'error': summary,
                    'stdout': all_stdout,
                    'stderr': combined_stderr,
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
            logger.info(f'[espidf] Compilation successful — {len(binary_b64) // 1024} KB (base64), has_wifi={has_wifi}')

            return {
                'success': True,
                'hex_content': None,
                'binary_content': binary_b64,
                'binary_type': 'bin',
                'has_wifi': has_wifi,
                'stdout': all_stdout,
                'stderr': all_stderr,
            }


# Singleton instance
espidf_compiler = ESPIDFCompiler()

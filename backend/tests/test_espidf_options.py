"""Unit tests for ESP-IDF compiler option normalisation, sdkconfig rendering,
and partition CSV rendering. These touch pure-Python helpers only — no
toolchain or QEMU involvement — so they run anywhere pytest does.
"""
from __future__ import annotations

import os

import pytest

from app.services.espidf_compiler import ESPIDFCompiler


@pytest.fixture
def compiler() -> ESPIDFCompiler:
    return ESPIDFCompiler()


# ── _normalize_options ────────────────────────────────────────────────────


def test_normalize_options_fills_defaults(compiler: ESPIDFCompiler) -> None:
    opts = compiler._normalize_options(None, idf_target='esp32')
    assert opts['partitionScheme'] == 'huge_app'
    assert opts['cpuFreqMHz'] == 240
    assert opts['flashMode'] == 'dio'
    assert opts['flashSize'] == '4MB'
    assert opts['psram'] == 'disabled'
    assert opts['coreDebugLevel'] == 'none'
    assert opts['arduinoRunsOnCore'] == 1
    assert opts['eventsRunOnCore'] == 1


def test_normalize_options_keeps_explicit_values(compiler: ESPIDFCompiler) -> None:
    opts = compiler._normalize_options(
        {'partitionScheme': 'min_spiffs', 'flashMode': 'qio', 'cpuFreqMHz': 80},
        idf_target='esp32',
    )
    assert opts['partitionScheme'] == 'min_spiffs'
    assert opts['flashMode'] == 'qio'
    assert opts['cpuFreqMHz'] == 80
    # Unspecified field still falls back to default
    assert opts['flashSize'] == '4MB'


def test_normalize_options_rejects_unknown_enum(compiler: ESPIDFCompiler) -> None:
    with pytest.raises(ValueError, match='partitionScheme'):
        compiler._normalize_options(
            {'partitionScheme': 'fake_scheme'}, idf_target='esp32',
        )


def test_normalize_options_strips_psram_on_c3(compiler: ESPIDFCompiler) -> None:
    opts = compiler._normalize_options(
        {'psram': 'enabled'}, idf_target='esp32c3',
    )
    # C3 has no external PSRAM controller — silently disabled.
    assert opts['psram'] == 'disabled'


def test_normalize_options_downgrades_opi_psram_off_s3(compiler: ESPIDFCompiler) -> None:
    # OPI PSRAM only exists on S3. On classic Xtensa we downgrade to 'enabled'
    # so the user doesn't get a stuck build after switching board family.
    opts = compiler._normalize_options(
        {'psram': 'opi'}, idf_target='esp32',
    )
    assert opts['psram'] == 'enabled'


def test_normalize_options_keeps_opi_on_s3(compiler: ESPIDFCompiler) -> None:
    opts = compiler._normalize_options(
        {'psram': 'opi'}, idf_target='esp32s3',
    )
    assert opts['psram'] == 'opi'


def test_normalize_options_ignores_unknown_keys(compiler: ESPIDFCompiler) -> None:
    # Forward-compat: a future frontend field shouldn't crash the backend.
    opts = compiler._normalize_options(
        {'futureField': 'something', 'cpuFreqMHz': 160},
        idf_target='esp32',
    )
    assert 'futureField' not in opts
    assert opts['cpuFreqMHz'] == 160


# ── _render_partition_csv ─────────────────────────────────────────────────


def test_render_partition_csv_known_schemes(compiler: ESPIDFCompiler) -> None:
    for scheme in ('huge_app', 'default', 'min_spiffs', 'no_ota', 'no_fs'):
        csv = compiler._render_partition_csv(scheme)
        assert '# Name' in csv
        assert 'app' in csv  # at least one app partition
        # Parser round-trips the data
        entries = compiler._parse_partition_csv(csv)
        assert any(e['type'] == 'app' for e in entries), \
            f'{scheme} must have at least one app partition'


def test_render_partition_csv_unknown_falls_back(compiler: ESPIDFCompiler) -> None:
    # Should not crash — defensive fallback to huge_app.
    csv = compiler._render_partition_csv('never_existed')
    assert 'app' in csv


def test_partition_huge_app_layout(compiler: ESPIDFCompiler) -> None:
    """huge_app must keep app0 at 0x10000 with 0x300000 size — matches the
    historical Velxio layout, so projects without options remain bit-for-bit
    compatible after upgrade.
    """
    entries = compiler._parse_partition_csv(
        compiler._render_partition_csv('huge_app')
    )
    apps = [e for e in entries if e['type'] == 'app']
    assert len(apps) == 1
    assert apps[0]['offset'] == 0x10000
    assert apps[0]['size'] == 0x300000


def test_partition_min_spiffs_has_two_ota_apps(compiler: ESPIDFCompiler) -> None:
    entries = compiler._parse_partition_csv(
        compiler._render_partition_csv('min_spiffs')
    )
    apps = [e for e in entries if e['type'] == 'app']
    assert len(apps) == 2
    subtypes = {a['subtype'] for a in apps}
    assert subtypes == {'ota_0', 'ota_1'}


def test_partition_no_fs_has_no_filesystem(compiler: ESPIDFCompiler) -> None:
    csv = compiler._render_partition_csv('no_fs')
    assert compiler._find_filesystem_partition(csv) is None


def test_partition_default_has_spiffs(compiler: ESPIDFCompiler) -> None:
    csv = compiler._render_partition_csv('default')
    fs = compiler._find_filesystem_partition(csv)
    assert fs is not None
    assert fs['subtype'] == 'spiffs'
    assert fs['size'] > 0


# ── _render_sdkconfig ─────────────────────────────────────────────────────


def test_render_sdkconfig_emits_partition_custom(compiler: ESPIDFCompiler) -> None:
    # The template lives next to the compiler module.
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options(None, idf_target='esp32')
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_PARTITION_TABLE_CUSTOM=y' in text
    assert 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"' in text


def test_render_sdkconfig_flash_mode_exclusive(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options({'flashMode': 'qio'}, idf_target='esp32')
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_ESPTOOLPY_FLASHMODE_QIO=y' in text
    assert 'CONFIG_ESPTOOLPY_FLASHMODE_DIO=n' in text


def test_render_sdkconfig_psram_off_emits_disabled(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options(None, idf_target='esp32')
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_SPIRAM=n' in text


def test_render_sdkconfig_psram_opi_for_s3(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options({'psram': 'opi'}, idf_target='esp32s3')
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_SPIRAM=y' in text
    assert 'CONFIG_SPIRAM_MODE_OCT=y' in text


def test_render_sdkconfig_cpu_freq(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options({'cpuFreqMHz': 160}, idf_target='esp32')
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_160=y' in text
    assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240=n' in text
    assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160' in text


def test_render_sdkconfig_enables_mbedtls_psk(compiler: ESPIDFCompiler) -> None:
    # arduino-esp32's WiFiClientSecure/ssl_client.cpp guards its whole body on a
    # PSK key-exchange being enabled. Without it the object compiles empty and
    # any WiFiClientSecure / HTTPClient.begin() sketch fails to link with
    # "undefined reference to start_ssl_client".
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options(None, idf_target='esp32')
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_MBEDTLS_PSK_MODES=y' in text
    assert 'CONFIG_MBEDTLS_KEY_EXCHANGE_PSK=y' in text


def test_render_sdkconfig_enables_fatfs_long_names(compiler: ESPIDFCompiler) -> None:
    # ESP-IDF's FatFs defaults to 8.3 names only. The Arduino IDE's core
    # (esp32-arduino-lib-builder defconfig.common) turns long names on, so a
    # sketch doing SD.open("/MUSIC/tracklist.txt") works on the board and
    # must work here: the microSD card image stores that file as
    # TRACKL~1.TXT + VFAT long-name entries, which only an LFN-aware FatFs
    # matches by its real name.
    from app.services.espidf_compiler import _TEMPLATE_DIR
    for target in ('esp32', 'esp32s3', 'esp32c3'):
        opts = compiler._normalize_options(None, idf_target=target)
        text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
        assert 'CONFIG_FATFS_LFN_STACK=y' in text
        assert 'CONFIG_FATFS_API_ENCODING_UTF_8=y' in text
        assert 'CONFIG_FATFS_CODEPAGE_850=y' in text
        assert 'CONFIG_FATFS_USE_LABEL=y' in text


def test_render_sdkconfig_debug_level_verbose(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options(
        {'coreDebugLevel': 'verbose'}, idf_target='esp32',
    )
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_ARDUHAL_LOG_DEFAULT_LEVEL=5' in text


def test_render_sdkconfig_arduino_running_core(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options(
        {'arduinoRunsOnCore': 0, 'eventsRunOnCore': 0}, idf_target='esp32',
    )
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR)
    assert 'CONFIG_ARDUINO_RUNNING_CORE=0' in text
    assert 'CONFIG_ARDUINO_EVENT_RUNNING_CORE=0' in text
    # The integers above are derived (no prompt): Kconfig ignores them. The
    # choice symbols are what put setup()/loop() and the events on core 0.
    assert 'CONFIG_ARDUINO_RUN_CORE0=y' in text
    assert 'CONFIG_ARDUINO_EVENT_RUN_CORE0=y' in text
    assert 'CONFIG_ARDUINO_RUN_CORE1=y' not in text


def test_render_sdkconfig_arduino_running_core_default_is_core_1(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    text = compiler._render_sdkconfig(compiler._normalize_options(None, idf_target='esp32s3'), _TEMPLATE_DIR,
                                      idf_target='esp32s3', use_idf5=True, arduino_mode=True)
    assert 'CONFIG_ARDUINO_RUN_CORE1=y' in text
    assert 'CONFIG_ARDUINO_EVENT_RUN_CORE1=y' in text


# ── _parse_partition_csv ──────────────────────────────────────────────────


def test_parse_partition_csv_handles_comments_and_blanks(compiler: ESPIDFCompiler) -> None:
    csv = (
        '# Comment\n'
        '\n'
        'nvs,      data, nvs,     0x9000,  0x5000,\n'
        'app0,     app,  ota_0,   0x10000, 0x100000,\n'
    )
    entries = compiler._parse_partition_csv(csv)
    assert len(entries) == 2
    assert entries[0]['name'] == 'nvs'
    assert entries[0]['offset'] == 0x9000
    assert entries[1]['name'] == 'app0'
    assert entries[1]['size'] == 0x100000


def test_find_filesystem_partition_prefers_spiffs(compiler: ESPIDFCompiler) -> None:
    csv = (
        'app0,     app,  ota_0,   0x10000, 0x100000,\n'
        'spiffs,   data, spiffs,  0x290000,0x160000,\n'
    )
    fs = compiler._find_filesystem_partition(csv)
    assert fs is not None
    assert fs['name'] == 'spiffs'
    assert fs['offset'] == 0x290000


# ── ESP32-C6 target support ───────────────────────────────────────────────


def test_idf_target_maps_c6_fqbn(compiler: ESPIDFCompiler) -> None:
    # Before this mapping existed, esp32:esp32:esp32c6 silently fell through
    # to the 'esp32' (Xtensa LX6) target.
    assert compiler._idf_target('esp32:esp32:esp32c6') == 'esp32c6'
    # Existing families are unaffected.
    assert compiler._idf_target('esp32:esp32:esp32') == 'esp32'
    assert compiler._idf_target('esp32:esp32:esp32c3') == 'esp32c3'
    assert compiler._idf_target('esp32:esp32:esp32s3') == 'esp32s3'


def test_normalize_options_strips_psram_on_c6(compiler: ESPIDFCompiler) -> None:
    opts = compiler._normalize_options(
        {'psram': 'enabled'}, idf_target='esp32c6',
    )
    # C6 has no external PSRAM controller — silently disabled, like C3.
    assert opts['psram'] == 'disabled'


def test_normalize_options_clamps_cpu_freq_on_c6(compiler: ESPIDFCompiler) -> None:
    # The historical default (240 MHz) exceeds the C6's 160 MHz maximum.
    opts = compiler._normalize_options(None, idf_target='esp32c6')
    assert opts['cpuFreqMHz'] == 160
    # A valid lower value is kept as-is.
    opts = compiler._normalize_options({'cpuFreqMHz': 80}, idf_target='esp32c6')
    assert opts['cpuFreqMHz'] == 80


def test_render_sdkconfig_c6_adapts_to_idf5(compiler: ESPIDFCompiler) -> None:
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options(None, idf_target='esp32c6')
    text = compiler._render_sdkconfig(opts, _TEMPLATE_DIR, idf_target='esp32c6')
    # Arduino component / classic-BT / PSRAM symbols don't exist in a C6
    # pure-IDF v5.x build — they must be dropped, not emitted as unknowns.
    assert 'CONFIG_ARDUHAL_' not in text
    assert 'CONFIG_ARDUINO_RUNNING_CORE' not in text
    assert 'CONFIG_AUTOSTART_ARDUINO' not in text
    assert 'CONFIG_BT_ENABLED' not in text
    assert 'CONFIG_SPIRAM' not in text
    assert 'CONFIG_ESPTOOLPY_FLASHFREQ_26M' not in text
    assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240' not in text
    # IDF 5.0 split ESP_TASK_WDT into _EN (compile) + _INIT (auto-start):
    # the API must link (sketches call esp_task_wdt_add) but never auto-run.
    assert 'CONFIG_ESP_TASK_WDT_EN=y' in text
    assert 'CONFIG_ESP_TASK_WDT_INIT=n' in text
    assert 'CONFIG_ESP_TASK_WDT=n' not in text
    # The clamped CPU frequency is rendered.
    assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_160=y' in text
    # Non-C6 rendering is unchanged (regression guard).
    esp32_opts = compiler._normalize_options(None, idf_target='esp32')
    esp32_text = compiler._render_sdkconfig(esp32_opts, _TEMPLATE_DIR)
    assert 'CONFIG_ARDUHAL_LOG_DEFAULT_LEVEL=0' in esp32_text
    assert 'CONFIG_ESP_TASK_WDT=n' in esp32_text


def test_bootloader_offsets_per_target(compiler: ESPIDFCompiler) -> None:
    # Classic ESP32/S2 boot from 0x1000; S3/C3/C6 (and newer) from 0x0.
    offsets = compiler._BOOTLOADER_OFFSETS
    assert offsets.get('esp32', 0x0) == 0x1000
    assert offsets.get('esp32s2', 0x0) == 0x1000
    for target in ('esp32s3', 'esp32c3', 'esp32c6'):
        assert offsets.get(target, 0x0) == 0x0


def test_arduino_supports_target_requires_3x_core_for_c6(
    compiler: ESPIDFCompiler,
) -> None:
    # esp32c6 needs the 3.x core (IDF 5.x based); the 2.x core can never
    # build it. Classic targets build with either core.
    compiler.has_arduino = True       # 2.x core present
    compiler.has_arduino5 = False     # no 3.x core
    assert compiler._arduino_supports_target('esp32') is True
    assert compiler._arduino_supports_target('esp32c3') is True
    assert compiler._arduino_supports_target('esp32c6') is False

    compiler.has_arduino5 = True      # 3.x core present -> C6 buildable
    assert compiler._arduino_supports_target('esp32c6') is True

    # No core at all -> nothing Arduino-buildable.
    compiler.has_arduino = False
    compiler.has_arduino5 = False
    assert compiler._arduino_supports_target('esp32') is False
    assert compiler._arduino_supports_target('esp32c6') is False


def test_arduino_path_for_picks_core_by_idf_major(
    compiler: ESPIDFCompiler,
) -> None:
    compiler.arduino_path = r'C:\v2\arduino-esp32'
    compiler.arduino5_path = r'C:\v5\arduino-esp32'
    assert compiler._arduino_path_for(use_idf5=True) == r'C:\v5\arduino-esp32'
    assert compiler._arduino_path_for(use_idf5=False) == r'C:\v2\arduino-esp32'
    # Falls back to whichever exists when the preferred one is absent.
    compiler.arduino5_path = ''
    assert compiler._arduino_path_for(use_idf5=True) == r'C:\v2\arduino-esp32'
    compiler.arduino5_path = r'C:\v5\arduino-esp32'
    compiler.arduino_path = ''
    assert compiler._arduino_path_for(use_idf5=False) == r'C:\v5\arduino-esp32'


def test_contains_app_main_detection(compiler: ESPIDFCompiler) -> None:
    assert compiler._contains_app_main('void app_main(void) { }')
    assert compiler._contains_app_main('void  app_main () {\n}')
    # Arduino sketches and mere mentions must not match.
    assert not compiler._contains_app_main('void setup() {} void loop() {}')
    assert not compiler._contains_app_main('// call app_main() later')


def test_use_idf5_policy(
    compiler: ESPIDFCompiler, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """IDF v5 is the default toolchain for the family; v4.4 remains only
    where the arduino-esp32 2.x core forces it (and as the no-v5 fallback).
    """
    monkeypatch.delenv('VELXIO_ARDUINO_IDF5', raising=False)
    compiler.idf5_path = str(tmp_path)  # pretend a v5 install exists

    # esp32c6 requires v5 regardless of mode.
    assert compiler._use_idf5('esp32c6', arduino_mode=False) is True
    # Pure-IDF builds default to v5 for the whole family.
    for target in ('esp32', 'esp32s3', 'esp32c3'):
        assert compiler._use_idf5(target, arduino_mode=False) is True

    # Arduino sketches without a 3.x core fall back to v4.4 (2.x core).
    compiler.has_arduino5 = False
    for target in ('esp32', 'esp32s3', 'esp32c3'):
        assert compiler._use_idf5(target, arduino_mode=True) is False
    # With a 3.x core present, Arduino builds move to v5 by default.
    compiler.has_arduino5 = True
    for target in ('esp32', 'esp32s3', 'esp32c3'):
        assert compiler._use_idf5(target, arduino_mode=True) is True
    # Escape hatch: force v4.4 even with a 3.x core present.
    monkeypatch.setenv('VELXIO_ARDUINO_IDF5', '0')
    assert compiler._use_idf5('esp32', arduino_mode=True) is False
    # ... or force v5 explicitly.
    monkeypatch.setenv('VELXIO_ARDUINO_IDF5', '1')
    assert compiler._use_idf5('esp32', arduino_mode=True) is True
    monkeypatch.delenv('VELXIO_ARDUINO_IDF5')

    # Without a v5 install, pure-IDF builds fall back to v4.4 (OSS
    # self-host) — except esp32c6, which has no v4.4 to fall back to
    # (compile() returns a structured error for it in that case).
    compiler.idf5_path = ''
    assert compiler._use_idf5('esp32', arduino_mode=False) is False
    assert compiler._use_idf5('esp32c6', arduino_mode=False) is True


def test_render_sdkconfig_idf5_arduino_keeps_component_symbols(
    compiler: ESPIDFCompiler,
) -> None:
    """A v5 ARDUINO build (3.x core) keeps the Arduino/BT symbols the 3.x
    component's Kconfig defines; a v5 PURE-IDF build drops them."""
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options(None, idf_target='esp32')
    ard = compiler._render_sdkconfig(
        opts, _TEMPLATE_DIR, idf_target='esp32', use_idf5=True, arduino_mode=True
    )
    assert 'CONFIG_AUTOSTART_ARDUINO=n' in ard
    assert 'CONFIG_ARDUHAL_LOG_DEFAULT_LEVEL=0' in ard
    assert 'CONFIG_BT_ENABLED=y' in ard
    assert 'CONFIG_ESP_TASK_WDT_EN=y' in ard  # WDT split still applies
    assert 'CONFIG_ESP_TASK_WDT_INIT=n' in ard

    pure = compiler._render_sdkconfig(
        opts, _TEMPLATE_DIR, idf_target='esp32', use_idf5=True, arduino_mode=False
    )
    assert 'CONFIG_AUTOSTART_ARDUINO' not in pure
    assert 'CONFIG_BT_ENABLED' not in pure

    # On a single-core RISC-V C6 Arduino build the running-core options are
    # dropped (hidden by FREERTOS_UNICORE) but the rest of Arduino stays.
    c6 = compiler._render_sdkconfig(
        compiler._normalize_options(None, idf_target='esp32c6'),
        _TEMPLATE_DIR, idf_target='esp32c6', use_idf5=True, arduino_mode=True,
    )
    assert 'CONFIG_ARDUINO_RUNNING_CORE' not in c6
    assert 'CONFIG_ARDUINO_RUN_CORE' not in c6  # CORE1 depends on !FREERTOS_UNICORE
    assert 'CONFIG_ARDUINO_EVENT_RUN_CORE' not in c6
    assert 'CONFIG_AUTOSTART_ARDUINO=n' in c6
    assert 'CONFIG_SPIRAM' not in c6  # no PSRAM controller on C6


def test_render_sdkconfig_idf5_per_target_drops(compiler: ESPIDFCompiler) -> None:
    """v5 fixup is target-aware: esp32/s3 keep SPIRAM + 240 MHz symbols,
    only classic esp32 keeps the 26 MHz flash-freq choice."""
    from app.services.espidf_compiler import _TEMPLATE_DIR
    opts = compiler._normalize_options({'psram': 'enabled'}, idf_target='esp32')
    text = compiler._render_sdkconfig(
        opts, _TEMPLATE_DIR, idf_target='esp32', use_idf5=True
    )
    assert 'CONFIG_SPIRAM=y' in text                      # kept on esp32
    assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240=y' in text  # kept on esp32
    assert 'CONFIG_ESPTOOLPY_FLASHFREQ_26M' in text       # kept on esp32
    assert 'CONFIG_ARDUHAL_' not in text                  # no Arduino on v5
    assert 'CONFIG_BT_ENABLED' not in text                # no Bluedroid on v5
    assert 'CONFIG_ESP_TASK_WDT_EN=y' in text             # split in v5
    assert 'CONFIG_ESP_TASK_WDT_INIT=n' in text

    s3_text = compiler._render_sdkconfig(
        compiler._normalize_options(None, idf_target='esp32s3'),
        _TEMPLATE_DIR, idf_target='esp32s3', use_idf5=True,
    )
    assert 'CONFIG_ESPTOOLPY_FLASHFREQ_26M' not in s3_text  # S3 has no 26M


def test_ninja_log_step_count(tmp_path) -> None:
    """Diagnostic helper for the ninja-timeout log line: counts completed
    steps in .ninja_log (header excluded), 0 when the log is missing."""
    from app.services.espidf_compiler import _ninja_log_step_count

    build_dir = tmp_path / 'build'
    assert _ninja_log_step_count(build_dir) == 0
    build_dir.mkdir()
    (build_dir / '.ninja_log').write_text(
        '# ninja log v6\n'
        '1\t20\t0\tesp-idf/a.obj\tdeadbeef\n'
        '2\t30\t0\tesp-idf/b.obj\tcafebabe\n',
        encoding='utf-8',
    )
    assert _ninja_log_step_count(build_dir) == 2


# ── FQBN menu-option suffix (CDCOnBoot) ──────────────────────────────────


def test_fqbn_board_id_plain(compiler: ESPIDFCompiler) -> None:
    assert compiler._fqbn_board_id_and_options('esp32:esp32:esp32c3') == (
        'esp32c3', {},
    )


def test_fqbn_board_id_with_menu_suffix(compiler: ESPIDFCompiler) -> None:
    board_id, opts = compiler._fqbn_board_id_and_options(
        'esp32:esp32:esp32c3:CDCOnBoot=cdc'
    )
    assert board_id == 'esp32c3'
    assert opts == {'CDCOnBoot': 'cdc'}


def test_fqbn_menu_suffix_multiple_options(compiler: ESPIDFCompiler) -> None:
    board_id, opts = compiler._fqbn_board_id_and_options(
        'esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi'
    )
    assert board_id == 'esp32s3'
    assert opts == {'CDCOnBoot': 'cdc', 'PSRAM': 'opi'}


def test_menu_override_cdc_flips_flag(compiler: ESPIDFCompiler) -> None:
    base = {'board': 'ESP32C3_DEV', 'cdc_on_boot': False}
    out = compiler._apply_menu_overrides(base, {'CDCOnBoot': 'cdc'})
    assert out['cdc_on_boot'] is True
    # The cache's base dict must never be mutated by an override.
    assert base['cdc_on_boot'] is False


def test_menu_override_default_keeps_boards_txt_value(
    compiler: ESPIDFCompiler,
) -> None:
    base = {'board': 'ESP32C3_DEV', 'cdc_on_boot': False}
    assert compiler._apply_menu_overrides(base, {'CDCOnBoot': 'default'}) is base
    assert compiler._apply_menu_overrides(base, {}) is base


# ── Warm build dir: managed components + configure inputs under main/ ──────
#
# The persistent build dir skips the cmake configure when build.ninja exists,
# trusting ninja's RERUN_CMAKE rule to re-run it when an input changed. That
# rule only lists the inputs the LAST configure saw, so a main/idf_component.yml
# written for the first camera sketch in a dir is invisible to it: the managed
# component is never fetched and the build dies on "esp_camera.h: No such file
# or directory" right after logging that the dependency was declared
# (2026-09-05, XIAO ESP32S3). These tests drive the prepare -> sync sequence
# of consecutive builds in one dir.

CAMERA_SKETCH = '#include "esp_camera.h"\nvoid setup() {}\nvoid loop() {}\n'
BARE_SKETCH = '#include <WiFi.h>\nvoid setup() {}\nvoid loop() {}\n'
_OLD_MTIME = 1_600_000_000


def _prepare(tmp_path, monkeypatch, key: str = 'variant'):
    from app.services import espidf_compiler as mod

    monkeypatch.setattr(mod, '_BUILD_ROOT', tmp_path / 'build-root')
    return mod._prepare_persistent_project_dir('esp32s3', key)


def test_component_graph_token_marks_camera_sketch(compiler: ESPIDFCompiler) -> None:
    assert compiler._component_graph_token(BARE_SKETCH) == ''
    token = compiler._component_graph_token(CAMERA_SKETCH)
    assert token.startswith('mc:espressif/esp32-camera')
    # A commented-out include is not an include.
    assert compiler._component_graph_token('// #include "esp_camera.h"\n') == ''


def test_sync_managed_components_forces_configure_when_manifest_is_new(
    compiler: ESPIDFCompiler, tmp_path, monkeypatch,
) -> None:
    camera = compiler._detect_managed_components(CAMERA_SKETCH)
    assert camera == {'espressif/esp32-camera': '^2.0.4'}

    # Build 1: a bare sketch configures the dir; no manifest anywhere.
    project_dir = _prepare(tmp_path, monkeypatch)
    manifest = project_dir / 'main' / 'idf_component.yml'
    assert compiler._sync_managed_components(project_dir, {}) is False
    assert not manifest.exists()

    # Build 2: the first camera sketch in this dir. The manifest is new, so
    # the configure must run explicitly - ninja does not know the file.
    project_dir = _prepare(tmp_path, monkeypatch)
    assert compiler._sync_managed_components(project_dir, camera) is True
    assert 'espressif/esp32-camera: "^2.0.4"' in manifest.read_text(encoding='utf-8')
    os.utime(manifest, (_OLD_MTIME, _OLD_MTIME))  # "the configure ran after this"

    # Build 3: same camera sketch. Same bytes -> previous mtime handed back so
    # ninja sees nothing new, and no forced configure.
    project_dir = _prepare(tmp_path, monkeypatch)
    assert not manifest.exists(), 'prepare restores main/ from the template'
    assert compiler._sync_managed_components(project_dir, camera) is False
    assert int(manifest.stat().st_mtime) == _OLD_MTIME

    # Build 4: another registry component joins -> changed.
    more = dict(camera, **{'lvgl/lvgl': '*'})
    project_dir = _prepare(tmp_path, monkeypatch)
    assert compiler._sync_managed_components(project_dir, more) is True
    text = manifest.read_text(encoding='utf-8')
    assert 'espressif/esp32-camera' in text and 'lvgl/lvgl' in text

    # Build 5: a bare sketch again -> the manifest went away, changed.
    project_dir = _prepare(tmp_path, monkeypatch)
    assert compiler._sync_managed_components(project_dir, {}) is True
    assert not manifest.exists()

    # Build 6: still bare -> nothing changed.
    project_dir = _prepare(tmp_path, monkeypatch)
    assert compiler._sync_managed_components(project_dir, {}) is False


def test_prepare_hands_back_main_cmake_mtime_when_unchanged(
    tmp_path, monkeypatch,
) -> None:
    """main/CMakeLists.txt is patched per build (user_libs_all, IDF components).
    Same bytes as the previous build must not look new to ninja, or every
    warm variant with a library reconfigures on every build."""
    from app.services import espidf_compiler as mod

    project_dir = _prepare(tmp_path, monkeypatch)
    cmake = project_dir / 'main' / 'CMakeLists.txt'
    stash = project_dir / mod._MAIN_CMAKE_STASH
    template_text = cmake.read_text(encoding='utf-8')
    patched = template_text.replace(
        'INCLUDE_DIRS "."', 'INCLUDE_DIRS "." "../user_libs/user_libs_all"', 1,
    )
    assert patched != template_text

    # Build 1 patches the file; pretend the configure ran afterwards.
    cmake.write_text(patched, encoding='utf-8')
    os.utime(cmake, (_OLD_MTIME, _OLD_MTIME))
    assert not stash.exists()

    # Build 2: prepare stashes build 1's file, the template comes back fresh.
    project_dir = _prepare(tmp_path, monkeypatch)
    assert stash.read_text(encoding='utf-8') == patched
    assert cmake.read_text(encoding='utf-8') == template_text
    cmake.write_text(patched, encoding='utf-8')
    assert int(cmake.stat().st_mtime) != _OLD_MTIME
    assert mod._restore_mtime_if_unchanged(cmake, stash) is False
    assert int(cmake.stat().st_mtime) == _OLD_MTIME

    # Build 3: a different patch (an IDF component joined REQUIRES) IS new.
    project_dir = _prepare(tmp_path, monkeypatch)
    cmake.write_text(patched.replace('driver', 'driver esp_lcd', 1), encoding='utf-8')
    assert mod._restore_mtime_if_unchanged(cmake, stash) is True
    assert int(cmake.stat().st_mtime) != _OLD_MTIME

export type BoardKind =
  | 'arduino-uno'
  | 'arduino-nano'
  | 'arduino-mega'
  | 'raspberry-pi-pico'           // RP2040, browser emulation
  | 'pi-pico-w'                   // RP2040 + WiFi, browser emulation (WiFi ignored)
  | 'raspberry-pi-3'              // QEMU ARM64, backend
  | 'esp32'                       // Xtensa LX6, QEMU backend
  | 'esp32-devkit-c-v4'           // ESP32 DevKit C V4, QEMU (esp32)
  | 'esp32-cam'                   // ESP32-CAM, QEMU (esp32)
  | 'wemos-lolin32-lite'          // Wemos Lolin32 Lite, QEMU (esp32)
  | 'esp32-s3'                    // Xtensa LX7, QEMU backend
  | 'xiao-esp32-s3'               // Seeed XIAO ESP32-S3, QEMU (esp32-s3)
  | 'arduino-nano-esp32'          // Arduino Nano ESP32 (S3), QEMU (esp32-s3)
  | 'esp32-c3'                    // RISC-V RV32IMC, QEMU backend
  | 'xiao-esp32-c3'               // Seeed XIAO ESP32-C3, QEMU backend
  | 'aitewinrobot-esp32c3-supermini' // ESP32-C3 SuperMini, QEMU backend
  | 'attiny85';                   // AVR ATtiny85, browser emulation (avr8js)

export type LanguageMode = 'arduino' | 'micropython';

export const BOARD_SUPPORTS_MICROPYTHON = new Set<BoardKind>([
  'raspberry-pi-pico',
  'pi-pico-w',
  // ESP32 Xtensa (QEMU bridge)
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  // ESP32-S3 Xtensa (QEMU bridge)
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  // ESP32-C3 RISC-V (QEMU bridge)
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

export interface WifiStatus {
  status: string;       // 'initializing' | 'connected' | 'got_ip' | 'disconnected'
  ssid?: string;
  ip?: string;
}

export interface BleStatus {
  status: string;       // 'initialized' | 'advertising'
}

export interface BoardInstance {
  id: string;                   // unique in canvas, e.g. 'arduino-uno', 'raspberry-pi-3'
  boardKind: BoardKind;
  x: number;
  y: number;
  running: boolean;
  compiledProgram: string | null;  // hex for AVR/RP2040, null for Pi (runs Python)
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;
  activeFileGroupId: string;
  languageMode: LanguageMode;     // 'arduino' (default) or 'micropython'
  hasWifi?: boolean;         // set by compiler — true when sketch uses WiFi
  wifiStatus?: WifiStatus;
  bleStatus?: BleStatus;
}

export const BOARD_KIND_LABELS: Record<BoardKind, string> = {
  'arduino-uno':    'Arduino Uno',
  'arduino-nano':   'Arduino Nano',
  'arduino-mega':   'Arduino Mega 2560',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
  'pi-pico-w':      'Raspberry Pi Pico W',
  'raspberry-pi-3': 'Raspberry Pi 3B',
  'esp32':          'ESP32 DevKit V1',
  'esp32-devkit-c-v4': 'ESP32 DevKit C V4',
  'esp32-cam':      'ESP32-CAM',
  'wemos-lolin32-lite': 'Wemos Lolin32 Lite',
  'esp32-s3':       'ESP32-S3 DevKit',
  'xiao-esp32-s3':  'XIAO ESP32-S3',
  'arduino-nano-esp32': 'Arduino Nano ESP32',
  'esp32-c3':       'ESP32-C3 DevKit',
  'xiao-esp32-c3':  'XIAO ESP32-C3',
  'aitewinrobot-esp32c3-supermini': 'ESP32-C3 SuperMini',
  'attiny85':       'ATtiny85',
};

export const BOARD_KIND_FQBN: Record<BoardKind, string | null> = {
  'arduino-uno':    'arduino:avr:uno',
  'arduino-nano':   'arduino:avr:nano:cpu=atmega328',
  'arduino-mega':   'arduino:avr:mega',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
  'pi-pico-w':      'rp2040:rp2040:rpipicow',
  'raspberry-pi-3': null,
  'esp32':          'esp32:esp32:esp32',
  'esp32-devkit-c-v4': 'esp32:esp32:esp32',
  'esp32-cam':      'esp32:esp32:esp32cam',
  'wemos-lolin32-lite': 'esp32:esp32:lolin32-lite',
  'esp32-s3':       'esp32:esp32:esp32s3',
  'xiao-esp32-s3':  'esp32:esp32:XIAO_ESP32S3',
  'arduino-nano-esp32': 'esp32:esp32:nano_nora',
  'esp32-c3':       'esp32:esp32:esp32c3',
  'xiao-esp32-c3':  'esp32:esp32:XIAO_ESP32C3',
  'aitewinrobot-esp32c3-supermini': 'esp32:esp32:esp32c3',
  'attiny85':       'ATTinyCore:avr:attinyx5:chip=85,clock=internal16mhz',
};

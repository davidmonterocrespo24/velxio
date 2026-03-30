/**
 * Shared types for extension ↔ WebView communication.
 */

export type BoardKind =
  | 'arduino-uno'
  | 'arduino-nano'
  | 'arduino-mega'
  | 'raspberry-pi-pico'
  | 'pi-pico-w'
  | 'esp32'
  | 'esp32-s3'
  | 'esp32-c3'
  | 'attiny85';

export type LanguageMode = 'arduino' | 'micropython';

/** Messages from the VS Code extension → WebView */
export type ToWebviewMessage =
  | { type: 'loadHex'; hex: string; board: BoardKind }
  | { type: 'loadBinary'; firmwareBase64: string; board: BoardKind }
  | { type: 'loadMicroPython'; files: Array<{ name: string; content: string }>; board: BoardKind }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'serialInput'; text: string }
  | { type: 'setBoard'; board: BoardKind }
  | { type: 'setDiagram'; diagram: DiagramJson }
  | { type: 'setApiBase'; apiBase: string };

/** Messages from the WebView → VS Code extension */
export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'serialOutput'; text: string }
  | { type: 'simulationState'; running: boolean }
  | { type: 'error'; message: string }
  | { type: 'requestCompile'; files: Array<{ name: string; content: string }>; board: string; fqbn: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** diagram.json format (Wokwi-compatible) */
export interface DiagramJson {
  version: 1;
  author?: string;
  editor?: string;
  parts: DiagramPart[];
  connections: DiagramConnection[];
  serialMonitor?: { display?: string; newline?: string };
}

export interface DiagramPart {
  id: string;
  type: string;
  left: number;
  top: number;
  rotate?: number;
  hide?: boolean;
  attrs?: Record<string, string>;
}

/** [fromPin, toPin, wireColor, routingHints?] */
export type DiagramConnection = [string, string, string, string[]?];

/** velxio.toml parsed config */
export interface VelxioConfig {
  velxio: {
    version: number;
    board?: string;
    firmware?: string;
    elf?: string;
    language?: LanguageMode;
  };
}

export const BOARD_LABELS: Record<BoardKind, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega 2560',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
  'pi-pico-w': 'Raspberry Pi Pico W',
  'esp32': 'ESP32 DevKit V1',
  'esp32-s3': 'ESP32-S3 DevKit',
  'esp32-c3': 'ESP32-C3 DevKit',
  'attiny85': 'ATtiny85',
};

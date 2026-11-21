import { isTauri } from '../desktop/tauriBridge';

interface UsbSerialFilter {
  usbVendorId: number;
  usbProductId?: number;
}

export interface BrowserFlashPort {
  readonly connected?: boolean;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  setSignals(signals: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void>;
  close(): Promise<void>;
}

interface BrowserFlashSerial {
  requestPort(options: { filters: UsbSerialFilter[] }): Promise<BrowserFlashPort>;
  addEventListener?(type: 'disconnect', listener: EventListener): void;
  removeEventListener?(type: 'disconnect', listener: EventListener): void;
}

export interface BrowserFlashTarget {
  boardId: string;
  workspaceVersion: number;
}

interface BrowserFlashSelection extends BrowserFlashTarget {
  port: BrowserFlashPort;
}

let selection: BrowserFlashSelection | null = null;
let unlisten: (() => void) | undefined;
const listeners = new Set<() => void>();

export function getBrowserFlashSelection(): BrowserFlashSelection | null {
  return selection;
}

export function subscribeBrowserFlashSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publishSelection(next: BrowserFlashSelection | null): void {
  selection = next;
  for (const listener of listeners) listener();
}

export function hasSelectedBrowserFlashPort(target: BrowserFlashTarget): boolean {
  return selection?.boardId === target.boardId && selection.workspaceVersion === target.workspaceVersion
    && selection.port.connected !== false;
}

export function clearBrowserFlashSelection(target: BrowserFlashTarget): void {
  if (selection?.boardId !== target.boardId || selection.workspaceVersion !== target.workspaceVersion) return;
  unlisten?.();
  unlisten = undefined;
  publishSelection(null);
}

export function getBrowserFlashSerial(): BrowserFlashSerial | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || isTauri()) return undefined;
  const serial = (navigator as Navigator & { serial?: BrowserFlashSerial }).serial;
  return typeof serial?.requestPort === 'function' ? serial : undefined;
}

export async function selectBrowserFlashPort(
  boardKind: string,
  target?: BrowserFlashTarget,
  chooseNewPort = false,
): Promise<BrowserFlashPort> {
  if (!chooseNewPort && target && selection && hasSelectedBrowserFlashPort(target)) return selection.port;
  const serial = getBrowserFlashSerial();
  if (!serial) throw new Error('Web Serial is unavailable in this browser.');
  const port = await serial.requestPort({ filters: flashPortFilters(boardKind) });
  if (target) {
    unlisten?.();
    const disconnect: EventListener = (event) => {
      if (event.target === (port as unknown as EventTarget)) clearBrowserFlashSelection(target);
    };
    serial.addEventListener?.('disconnect', disconnect);
    unlisten = () => serial.removeEventListener?.('disconnect', disconnect);
    publishSelection({ ...target, port });
  }
  return port;
}

// USB identities from ArduinoCore-avr boards.txt and common serial bridges
// used by clone boards. A bridge identifies the USB adapter, not the AVR.
const unoPorts: UsbSerialFilter[] = [
  { usbVendorId: 0x2341, usbProductId: 0x0043 },
  { usbVendorId: 0x2341, usbProductId: 0x0001 },
  { usbVendorId: 0x2a03, usbProductId: 0x0043 },
  { usbVendorId: 0x2341, usbProductId: 0x0243 },
  { usbVendorId: 0x2341, usbProductId: 0x006a },
];
const serialBridges: UsbSerialFilter[] = [
  { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340/CH341
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 }, // CH9102
  { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // CP210x
  { usbVendorId: 0x0403, usbProductId: 0x6001 }, // FT232
];

export function flashPortFilters(boardKind?: string): UsbSerialFilter[] {
  if (boardKind === 'arduino-uno') return [...unoPorts, ...serialBridges];
  if (boardKind?.startsWith('esp32')) return [{ usbVendorId: 0x303a }, ...serialBridges];
  return [
    { usbVendorId: 0x2341 }, // Arduino
    { usbVendorId: 0x2a03 }, // Arduino
    { usbVendorId: 0x303a }, // Espressif
    { usbVendorId: 0x2e8a }, // Raspberry Pi
    ...serialBridges,
  ];
}

import { verifyHexChecksum } from '../utils/hexParser';
import { getBrowserFlashSerial, selectBrowserFlashPort, type BrowserFlashPort, type BrowserFlashTarget } from './browserFlashSerial';
import type { WebFlashImpl, WebFlashRequest, WebFlashResult } from './proWebFlash';

const UNO_FQBN = 'arduino:avr:uno';
export const UNO_UPLOAD_BAUD_RATE = 115200;
export const UNO_UPLOAD_BAUD_RATES: readonly number[] = [UNO_UPLOAD_BAUD_RATE, 57600];
const PAGE_SIZE = 128;
const SKETCH_LIMIT = 32256;
const CHIP_SIGNATURE = [0x1e, 0x95, 0x0f];
const RESET_CAPACITOR_DISCHARGE_MS = 250;
const BOOTLOADER_STARTUP_MS = 450;
const SYNC_TIMEOUT = 200;
const COMMAND_TIMEOUT = 2000;

// The Optiboot subset of STK500v1. Word addresses are sent little-endian
// while page lengths are sent big-endian. Only sketch flash is writable.
const STK = {
  ok: 0x10,
  inSync: 0x14,
  end: 0x20,
  sync: 0x30,
  enter: 0x50,
  leave: 0x51,
  address: 0x55,
  write: 0x64,
  read: 0x74,
  signature: 0x75,
  flash: 0x46,
};

function unoImage(hex: string): Uint8Array {
  const image = new Uint8Array(SKETCH_LIMIT).fill(0xff);
  let end = 0;
  let base = 0;
  let eof = false;
  let hasResetVector = false;
  for (const raw of hex.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const count = parseInt(line.slice(1, 3), 16);
    if (eof || !/^:[0-9a-f]+$/i.test(line) || line.length !== 11 + count * 2 || !verifyHexChecksum(line)) {
      throw new Error('The compiled program is not a valid Intel HEX file.');
    }
    const offset = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    const data = (index: number) => parseInt(line.slice(9 + index * 2, 11 + index * 2), 16);
    if (type === 0) {
      const address = base + offset;
      const recordEnd = address + count;
      if (recordEnd > SKETCH_LIMIT) throw new Error('The image extends outside the Arduino Uno sketch area.');
      if (address === 0 && count >= 2) hasResetVector = true;
      for (let i = 0; i < count; i++) image[address + i] = data(i);
      end = Math.max(end, recordEnd);
    } else if (type === 1 && count === 0 && offset === 0) {
      eof = true;
    } else if ((type === 2 || type === 4) && count === 2 && offset === 0) {
      base = (data(0) * 256 + data(1)) * (type === 2 ? 16 : 65536);
    } else if (!((type === 3 || type === 5) && count === 4 && offset === 0)) {
      throw new Error('The compiled program contains an unsupported Intel HEX record.');
    }
  }
  if (!eof || !hasResetVector) throw new Error('The compiled Arduino Uno program is incomplete.');
  return image.subarray(0, end);
}

class BootloaderTimeout extends Error {
  constructor() {
    super('Timed out waiting for the Arduino Uno bootloader.');
  }
}

function withinDeadline<T>(operation: Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(new BootloaderTimeout()), Math.max(0, deadline - performance.now()));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then((value) => {
      cleanup();
      resolve(value);
    }, fail);
  });
}

export async function flashUnoOnPort(port: BrowserFlashPort, request: WebFlashRequest): Promise<WebFlashResult> {
  if (request.boardKind !== 'arduino-uno' || (request.fqbn && request.fqbn !== UNO_FQBN)) {
    throw new Error('This uploader only supports the Arduino Uno (ATmega328P).');
  }
  const image = unoImage(request.binaryBase64);
  const { signal, onProgress } = request;
  const baudRate = request.baudRate ?? UNO_UPLOAD_BAUD_RATE;
  if (!UNO_UPLOAD_BAUD_RATES.includes(baudRate)) throw new Error('Unsupported Arduino Uno upload baud rate.');
  const started = performance.now();
  signal.throwIfAborted();
  onProgress({ phase: 'connecting', pct: 0, line: `Resetting the board at ${baudRate} baud…` });
  await port.open({ baudRate });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let completed = false;
  try {
    signal.throwIfAborted();
    // Discharge the reset capacitor and leave DTR/RTS asserted through the upload.
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await new Promise<void>((resolve) => setTimeout(resolve, RESET_CAPACITOR_DISCHARGE_MS));
    signal.throwIfAborted();
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    // AVR Uno Optiboot can spend about 375 ms blinking the LED before it reads commands.
    await new Promise<void>((resolve) => setTimeout(resolve, BOOTLOADER_STARTUP_MS));
    signal.throwIfAborted();
    reader = port.readable?.getReader();
    writer = port.writable?.getWriter();
    if (!reader || !writer) throw new Error('The serial port did not provide readable and writable streams.');
    const input = reader;
    const output = writer;
    let data: Uint8Array = new Uint8Array();
    let position = 0;
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

    const readByte = async (deadline: number): Promise<number> => {
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new BootloaderTimeout();
      while (position === data.length) {
        pendingRead ??= input.read();
        // When a sync attempt times out, keep using that read on the next attempt.
        const result = await withinDeadline(pendingRead, deadline, signal);
        pendingRead = undefined;
        if (result.done) throw new Error('The serial port disconnected while flashing.');
        data = result.value;
        position = 0;
      }
      return data[position++];
    };
    const command = async (body: number[], responseLength = 0, syncing = false) => {
      signal.throwIfAborted();
      const deadline = performance.now() + (syncing ? SYNC_TIMEOUT : COMMAND_TIMEOUT);
      await withinDeadline(output.write(Uint8Array.from([...body, STK.end])), deadline, signal);
      let prefix = await readByte(deadline);
      while (syncing && prefix !== STK.inSync) {
        prefix = await readByte(deadline);
      }
      if (prefix !== STK.inSync) throw new Error('The Arduino Uno bootloader lost synchronization.');
      const response: number[] = [];
      for (let i = 0; i < responseLength; i++) response.push(await readByte(deadline));
      if (await readByte(deadline) !== STK.ok) throw new Error('The Arduino Uno rejected a bootloader command.');
      return response;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        await command([STK.sync], 0, true);
        break;
      } catch (error) {
        if (!(error instanceof BootloaderTimeout)) throw error;
        if (attempt === 3) {
          throw new Error('Timed out waiting for the Arduino Uno bootloader. Check that you selected the Uno’s USB port, then try pressing Reset on the board as flashing starts.');
        }
      }
    }

    const signature = await command([STK.signature], CHIP_SIGNATURE.length);
    if (signature.some((byte, index) => byte !== CHIP_SIGNATURE[index])) {
      throw new Error('The connected device is not an Arduino Uno with an ATmega328P. No firmware was written.');
    }
    await command([STK.enter]);
    onProgress({ phase: 'writing', pct: 0, line: `Connected to ATmega328P. Writing ${image.length} bytes…` });
    const address = (offset: number) => {
      const wordAddress = offset / 2;
      return command([STK.address, wordAddress & 0xff, wordAddress >> 8]);
    };
    for (let offset = 0; offset < image.length; offset += PAGE_SIZE) {
      const page = new Uint8Array(PAGE_SIZE).fill(0xff);
      page.set(image.subarray(offset, offset + PAGE_SIZE));
      await address(offset);
      await command([STK.write, 0, PAGE_SIZE, STK.flash, ...page]);
      onProgress({ phase: 'writing', pct: 85 * Math.min(offset + PAGE_SIZE, image.length) / image.length });
    }

    onProgress({ phase: 'writing', pct: 85, line: 'Verifying the written flash…' });
    for (let offset = 0; offset < image.length; offset += PAGE_SIZE) {
      await address(offset);
      const actual = await command([STK.read, 0, PAGE_SIZE, STK.flash], PAGE_SIZE);
      if (actual.some((byte, index) => byte !== (image[offset + index] ?? 0xff))) {
        throw new Error(`Flash verification failed at page 0x${offset.toString(16)}.`);
      }
      onProgress({ phase: 'writing', pct: 85 + 15 * Math.min(offset + PAGE_SIZE, image.length) / image.length });
    }
    await command([STK.leave]);
    completed = true;
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    writer?.releaseLock();
    await port.close().catch((error) => { if (completed) throw error; });
  }
  onProgress({ phase: 'resetting', pct: 100, line: 'Done. Restarting the board…' });
  return { chipName: 'ATmega328P', elapsedMs: performance.now() - started };
}

async function prepareUnoPort(boardKind: string, target?: BrowserFlashTarget, chooseNewPort?: boolean) {
  const port = await selectBrowserFlashPort(boardKind, target, chooseNewPort);
  return (request: WebFlashRequest) => flashUnoOnPort(port, request);
}

export const arduinoUnoWebFlash: WebFlashImpl = {
  available: (kind) => kind === 'arduino-uno' && !!getBrowserFlashSerial(),
  preparePort: prepareUnoPort,
  flash: async (request) => (await prepareUnoPort(request.boardKind))(request),
};

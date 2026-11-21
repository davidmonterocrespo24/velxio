import { getBrowserFlashSerial, type BrowserFlashPort } from './browserFlashSerial';

interface Session {
  ready: Promise<void>;
  isOpening: () => boolean;
  write: (text: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

let monitor: Session | undefined;
let flashing = false;

export function connectHardwareSerial(
  baudRate: number,
  onData: (text: string) => void,
  onDisconnect: (error?: unknown) => void,
): Session {
  const serial = getBrowserFlashSerial();
  if (!serial) throw new Error('Web Serial is unavailable.');
  if (flashing || monitor) throw new Error('The serial port is busy. Try again in a moment.');

  let port: BrowserFlashPort | undefined;
  let opened = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let reading: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let opening = true;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stop = (error?: unknown) => {
    if (closing) return closing;
    stopped = true;
    closing = (async () => {
      try {
        await ready.catch(() => {});
        await reader?.cancel().catch(() => {});
        await reading;
        reader?.releaseLock();
        if (writer) {
          await writer.abort().catch(() => {});
          writer.releaseLock();
        }
        if (opened) await port?.close();
      } finally {
        serial.removeEventListener?.('disconnect', handleUnplug);
        monitor = undefined;
        onDisconnect(error);
      }
    })();
    return closing;
  };
  const handleUnplug: EventListener = (event) => {
    if (event.target === (port as unknown as EventTarget)) {
      void stop().catch(() => {});
    }
  };

  const ready = (async () => {
    // The chooser must be called directly from the Connect click.
    port = await serial.requestPort({ filters: [] });
    if (stopped) return;
    await port.open({ baudRate });
    opened = true;
    if (stopped) return;
    if (!port.readable || !port.writable) throw new Error('The serial port is unavailable.');
    const input = port.readable.getReader();
    reader = input;
    writer = port.writable.getWriter();
    serial.addEventListener?.('disconnect', handleUnplug);
    reading = (async () => {
      let failure: unknown;
      try {
        while (!stopped) {
          const { value, done } = await input.read();
          if (done || stopped) break;
          onData(decoder.decode(value, { stream: true }));
        }
        if (!stopped) onData(decoder.decode());
      } catch (error) {
        if (!stopped) failure = error;
      } finally {
        input.releaseLock();
        reader = undefined;
        if (!stopped) void stop(failure).catch(() => {});
      }
    })();
  })();

  monitor = {
    ready,
    isOpening: () => opening,
    disconnect: () => stop(),
    async write(text) {
      if (writer && !stopped) await writer.write(encoder.encode(text));
    },
  };
  void ready.then(
    () => { opening = false; },
    () => {
      opening = false;
      void stop().catch(() => {});
    },
  );
  return monitor;
}

/** Keep the monitor out of the uploader's port until its own cleanup finishes. */
export async function withHardwareSerialFlash<T>(flash: () => Promise<T>): Promise<T> {
  if (flashing) throw new Error('Another USB flash operation is already in progress.');
  if (monitor?.isOpening()) throw new Error('Finish or cancel the serial port selection before flashing.');
  flashing = true;
  try {
    if (monitor) await monitor.disconnect();
    return await flash();
  } finally {
    flashing = false;
  }
}

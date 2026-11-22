import { beforeEach, expect, it, vi } from 'vitest';
import { getBrowserFlashSerial } from '../lib/browserFlashSerial';
import { connectHardwareSerial, withHardwareSerialFlash } from '../lib/hardwareSerial';

vi.mock('../lib/browserFlashSerial', () => ({ getBrowserFlashSerial: vi.fn() }));

function createPort() {
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { input = controller; },
  });
  const write = vi.fn<(chunk: Uint8Array) => void>();
  const writable = new WritableStream<Uint8Array>({ write: (chunk) => write(chunk) });
  const port = {
    readable,
    writable,
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {
      expect(readable.locked).toBe(false);
      expect(writable.locked).toBe(false);
    }),
    setSignals: vi.fn(),
  };
  return { input, port, write };
}

const serial = { requestPort: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getBrowserFlashSerial).mockReturnValue(serial);
});

it('opens at the selected baud, decodes split UTF-8, and writes raw bytes', async () => {
  const { port, input, write } = createPort();
  serial.requestPort.mockResolvedValue(port);
  const onData = vi.fn();
  const onDisconnect = vi.fn();
  const session = connectHardwareSerial(9600, onData, onDisconnect);
  try {
    expect(serial.requestPort).toHaveBeenCalledWith({ filters: [] });
    await session.ready;
    expect(port.open).toHaveBeenCalledWith({ baudRate: 9600 });

    const encoder = new TextEncoder();
    const bytes = encoder.encode('é\n');
    input.enqueue(bytes.slice(0, 1));
    input.enqueue(bytes.slice(1));
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith('é\n'));
    await session.write('hello\r\n');
    expect(write).toHaveBeenCalledWith(encoder.encode('hello\r\n'));
  } finally {
    await session.disconnect();
  }
  expect(port.close).toHaveBeenCalledOnce();
  expect(onDisconnect).toHaveBeenCalledOnce();
});

it('releases the monitor before flashing and prevents connecting during upload', async () => {
  const { port } = createPort();
  serial.requestPort.mockResolvedValue(port);
  const session = connectHardwareSerial(115200, vi.fn(), vi.fn());
  await session.ready;

  expect(await withHardwareSerialFlash(async () => {
    expect(port.close).toHaveBeenCalledOnce();
    expect(() => connectHardwareSerial(9600, vi.fn(), vi.fn())).toThrow(/busy/i);
    return 'flashed';
  })).toBe('flashed');

  const next = connectHardwareSerial(9600, vi.fn(), vi.fn());
  await next.disconnect();
});

it('does not open a port selected after the monitor was closed', async () => {
  const { port } = createPort();
  let select!: (selected: typeof port) => void;
  serial.requestPort.mockImplementation(() => new Promise<typeof port>((resolve) => {
    select = resolve;
  }));
  const session = connectHardwareSerial(115200, vi.fn(), vi.fn());
  const close = session.disconnect();
  const flash = vi.fn();
  await expect(withHardwareSerialFlash(flash)).rejects.toThrow(/selection/i);
  expect(flash).not.toHaveBeenCalled();
  select(port);
  await close;
  expect(port.open).not.toHaveBeenCalled();
  expect(port.close).not.toHaveBeenCalled();
});

it('notifies the UI and releases the port when the device stream ends', async () => {
  const { input, port } = createPort();
  serial.requestPort.mockResolvedValue(port);
  const onDisconnect = vi.fn();
  const session = connectHardwareSerial(115200, vi.fn(), onDisconnect);
  try {
    await session.ready;
    input.close();
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
    expect(port.close).toHaveBeenCalledOnce();
  } finally {
    await session.disconnect();
  }
});

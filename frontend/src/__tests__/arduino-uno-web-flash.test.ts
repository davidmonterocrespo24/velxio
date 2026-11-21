import { describe, expect, it, vi } from 'vitest';
import { flashUnoOnPort } from '../lib/arduinoUnoWebFlash';
import { flashPortFilters } from '../lib/browserFlashSerial';
import type { WebFlashRequest } from '../lib/proWebFlash';

const HEX = ':040000000C94340028\n:02008000AABB19\n:00000001FF';

function fakeUno({ signature = [0x1e, 0x95, 0x0f], corruptReadback = false, silent = false } = {}) {
  const flash = new Uint8Array(512).fill(0xff);
  const commands: number[] = [];
  let bootloaderReadyAt = Infinity;
  let address = 0;
  let reply!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (controller) => { reply = controller; } });
  const writable = new WritableStream<Uint8Array>({
    write: (packet) => {
      const [opcode, high, low] = packet;
      commands.push(opcode);
      expect(packet.at(-1)).toBe(0x20);
      if (silent || performance.now() < bootloaderReadyAt) return;
      let response: number[] = [];
      if (opcode === 0x55) address = (high + low * 256) * 2;
      if (opcode === 0x75) response = signature;
      if (opcode === 0x64) flash.set(packet.subarray(4, 4 + high * 256 + low), address);
      if (opcode === 0x74) {
        response = Array.from(flash.slice(address, address + high * 256 + low));
        if (corruptReadback) response[0] ^= 1;
      }
      // Real serial devices may split a reply across multiple reads.
      reply.enqueue(Uint8Array.of(0x14));
      reply.enqueue(Uint8Array.from([...response, 0x10]));
    },
  });
  const port = {
    readable,
    writable,
    open: vi.fn(async () => {}),
    setSignals: vi.fn(async ({ dataTerminalReady }: { dataTerminalReady: boolean }) => {
      bootloaderReadyAt = dataTerminalReady ? performance.now() + 375 : Infinity;
    }),
    close: vi.fn(async () => {}),
  };
  return { port, flash, commands };
}

function request(program = HEX): WebFlashRequest {
  return {
    boardId: 'uno',
    boardKind: 'arduino-uno',
    fqbn: 'arduino:avr:uno',
    binaryBase64: program,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  };
}

describe('Arduino Uno Web Serial upload', () => {
  it('writes multiple pages and verifies them before leaving the bootloader', async () => {
    const { port, flash, commands } = fakeUno();
    await expect(flashUnoOnPort(port, request())).resolves.toMatchObject({ chipName: 'ATmega328P' });
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200 });
    expect(port.setSignals.mock.calls).toEqual([
      [{ dataTerminalReady: false, requestToSend: false }],
      [{ dataTerminalReady: true, requestToSend: true }],
    ]);
    expect(commands).toEqual([0x30, 0x75, 0x50, 0x55, 0x64, 0x55, 0x64, 0x55, 0x74, 0x55, 0x74, 0x51]);
    expect(Array.from(flash.slice(0, 5))).toEqual([0x0c, 0x94, 0x34, 0, 0xff]);
    expect(Array.from(flash.slice(126, 131))).toEqual([0xff, 0xff, 0xaa, 0xbb, 0xff]);
    expect(port.close).toHaveBeenCalledOnce();
    expect(port.readable.locked || port.writable.locked).toBe(false);
  });

  it('refuses to write when the device signature does not match', async () => {
    const { port, commands } = fakeUno({ signature: [0x1e, 0x97, 0x03] });
    await expect(flashUnoOnPort(port, request())).rejects.toThrow(/No firmware was written/);
    expect(commands).toEqual([0x30, 0x75]);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('uses the selected upload baud rate', async () => {
    const { port } = fakeUno();
    await expect(flashUnoOnPort(port, { ...request(), baudRate: 57600 })).resolves.toMatchObject({ chipName: 'ATmega328P' });
    expect(port.open).toHaveBeenCalledWith({ baudRate: 57600 });
  });

  it('reports failure when readback does not match', async () => {
    const { port, commands } = fakeUno({ corruptReadback: true });
    await expect(flashUnoOnPort(port, request())).rejects.toThrow(/verification failed/i);
    expect(commands).not.toContain(0x51);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('rejects corrupt HEX and bootloader writes before opening the port', async () => {
    const { port } = fakeUno();
    await expect(flashUnoOnPort(port, request(HEX.replace('0C94', '0D94')))).rejects.toThrow(/Intel HEX/);
    const protectedHex = ':040000000C94340028\n:027E0000AABB1B\n:00000001FF';
    await expect(flashUnoOnPort(port, request(protectedHex))).rejects.toThrow(/outside the Arduino Uno sketch/);
    expect(port.open).not.toHaveBeenCalled();
  });

  it('times out and releases a silent port without writing', async () => {
    const { port, commands } = fakeUno({ silent: true });
    await expect(flashUnoOnPort(port, request())).rejects.toThrow(/timed out/i);
    expect(commands).toEqual([0x30, 0x30, 0x30, 0x30]);
    expect(port.close).toHaveBeenCalledOnce();
    expect(port.readable.locked).toBe(false);
  });

  it('filters the Uno chooser to matching Arduino USB IDs and common serial bridges', () => {
    const filters = flashPortFilters('arduino-uno');
    expect(filters).toContainEqual({ usbVendorId: 0x2341, usbProductId: 0x0043 });
    expect(filters).toContainEqual({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
    expect(filters.every(({ usbProductId }) => usbProductId !== undefined)).toBe(true);
  });
});

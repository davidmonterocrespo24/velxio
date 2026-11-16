/**
 * Serial.print without Serial.begin sends nothing (velxio/velxio-prod#167).
 *
 * The Arduino core's init() leaves UCSR0B at 0 and only Serial.begin() sets
 * TXEN0 (ArduinoCore-avr wiring.c, HardwareSerial.cpp). With the transmitter
 * off the USART neither drives TXD nor shifts anything out: data written to
 * UDR0 goes nowhere (ATmega328P datasheet DS40002061B section 20.6 and the
 * UDRn description), so a real Uno running a sketch that forgot
 * Serial.begin() prints nothing, and keeps running (a 2011 hardware report:
 * nothing received, the TX LED dark, the loop still turning). avr8js reports
 * every UDR write all the same, and Velxio passed each one to the monitor
 * and to whatever is wired to TX: the gallery's l293d-speed-pwm printed
 * "Speed: 153" with no Serial.begin.
 *
 * The fixture is that gallery sketch as it was (avr-serial-no-begin.ino),
 * compiled by the compile service for arduino:avr:uno.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const NO_BEGIN_HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-serial-no-begin/avr-serial-no-begin.ino.hex', import.meta.url)),
  'utf-8',
);

const UDR0 = 0xc6;
const UCSR0B = 0xc1;
const TXEN0 = 0x08;

interface Run {
  console: string;
  fabric: number[];
  udrWrites: number;
}

/** Boot the sketch, optionally turning the transmitter on as Serial.begin would, and run `ms` of guest time. */
function run(ms: number, enableTx: boolean): Run {
  const sim = new AVRSimulator(new PinManager());
  sim.loadHex(NO_BEGIN_HEX);
  let text = '';
  sim.onSerialData = (ch) => {
    text += ch;
  };
  const fabric: number[] = [];
  sim.getBusBinding().uart![0]!.setTxHandler((byte) => fabric.push(byte));
  const cpu = (sim as unknown as { cpu: { cycles: number; data: Uint8Array; writeHooks: Record<number, unknown>; writeData(a: number, v: number): void } }).cpu;
  // Count the sketch's writes to UDR0, whatever the USART does with them.
  let udrWrites = 0;
  const hook = cpu.writeHooks[UDR0] as (...args: unknown[]) => boolean | void;
  cpu.writeHooks[UDR0] = (...args: unknown[]) => {
    udrWrites++;
    return hook(...args);
  };
  const end = cpu.cycles + ms * 16_000;
  if (enableTx) {
    // After the core's init(), which clears UCSR0B, as Serial.begin would.
    while (cpu.cycles < 16_000) sim.step();
    cpu.writeData(UCSR0B, cpu.data[UCSR0B] | TXEN0);
  }
  while (cpu.cycles < end) sim.step();
  sim.stop();
  return { console: text, fabric, udrWrites };
}

describe('Serial.print without Serial.begin (velxio/velxio-prod#167)', () => {
  it('sends nothing to the monitor or to the TX wire while TXEN0 is off', () => {
    const r = run(350, false);
    expect(r.console).toBe('');
    expect(r.fabric).toEqual([]);
  });

  it('the sketch keeps running: it still writes UDR0 on every loop', () => {
    // Three loops of delay(100), each printing "Speed: 0\r\n" (10 bytes).
    const r = run(350, false);
    expect(r.udrWrites).toBeGreaterThanOrEqual(30);
  });

  it('with the transmitter on (what Serial.begin does) the same bytes arrive', () => {
    const r = run(350, true);
    expect(r.console).toContain('Speed: 0');
    expect(r.fabric.length).toBe(r.console.length);
  });
});

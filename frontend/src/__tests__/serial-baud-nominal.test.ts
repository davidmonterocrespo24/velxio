import { describe, expect, it } from 'vitest';
import { STANDARD_BAUD_RATES, baudLabelTitle, nominalBaud } from '../store/serialWire';

/**
 * The rate the serial monitor names a board's UART by (velxio/velxio-prod#193).
 *
 * An Uno never clocks exactly what the sketch asked for: the USART divides
 * 16 MHz by an integer. ArduinoCore-avr's HardwareSerial::begin picks U2X with
 * baud_setting = (F_CPU / 4 / baud - 1) / 2, except at 57600 on a 16 MHz part
 * (the 16U2 bridge's rate) and for settings that do not fit 12 bits, which use
 * (F_CPU / 8 / baud - 1) / 2 without U2X. avr8js reports the rate the divider
 * gives, floor(F_CPU / (8 or 16 * (UBRR + 1))). For 115200 that is UBRR 16 with
 * U2X, 117647 baud (+2.1 %, Microchip AVR306 Table 3-5), and the label read
 * "117,647 baud", a number no monitor lists and no student typed.
 */
function unoAchieved(baud: number, fCpu = 16_000_000): number {
  let u2x = true;
  let setting = Math.floor((Math.floor(fCpu / 4 / baud) - 1) / 2);
  if ((fCpu === 16_000_000 && baud === 57600) || setting > 4095) {
    u2x = false;
    setting = Math.floor((Math.floor(fCpu / 8 / baud) - 1) / 2);
  }
  return Math.floor(fCpu / ((u2x ? 8 : 16) * (setting + 1)));
}

describe('nominalBaud: the label is the rate the sketch asked for', () => {
  it('an Uno at 115200, 57600 and 230400 is named by those rates', () => {
    expect(unoAchieved(115200)).toBe(117647);
    expect(unoAchieved(57600)).toBe(58823);
    expect(unoAchieved(230400)).toBe(222222);
    expect(nominalBaud(117647)).toBe(115200);
    expect(nominalBaud(58823)).toBe(57600);
    expect(nominalBaud(222222)).toBe(230400);
  });

  it('every rate an Uno can be asked for up to 250000 gets its own name back', () => {
    for (const asked of STANDARD_BAUD_RATES.filter((b) => b >= 300 && b <= 250000)) {
      expect(nominalBaud(unoAchieved(asked)), `${asked} -> ${unoAchieved(asked)}`).toBe(asked);
    }
  });

  it('a divider that lands on ANOTHER standard rate is named by the rate it really is', () => {
    // 460800 and 921600 cannot be made from 16 MHz: the Uno clocks 500000 and
    // 1000000 (8.5 % off), which a 460800 receiver cannot read.
    expect(unoAchieved(460800)).toBe(500000);
    expect(nominalBaud(unoAchieved(460800))).toBe(500000);
    expect(unoAchieved(921600)).toBe(1000000);
    expect(nominalBaud(unoAchieved(921600))).toBe(1000000);
  });

  it('a rate that is no standard one keeps its own number', () => {
    expect(nominalBaud(31250)).toBe(31250); // MIDI
    expect(nominalBaud(125000)).toBe(125000);
    expect(nominalBaud(200000)).toBe(200000);
    expect(nominalBaud(0)).toBe(0);
  });

  it('never names a rate after a farther neighbour', () => {
    // Adjacent standard rates are at least 7.8 % apart (230400/250000,
    // 460800/500000, 921600/1000000), so a rate inside the band is closer to
    // the one it is named by than to any other.
    for (let b = 200_000; b <= 270_000; b += 50) {
      const n = nominalBaud(b);
      if (n === b) continue;
      const nearest = STANDARD_BAUD_RATES.reduce((best, s) =>
        Math.abs(s - b) / s < Math.abs(best - b) / best ? s : best,
      );
      expect(n, String(b)).toBe(nearest);
    }
  });

  it('an ESP32 off the 80 MHz APB is named as before', () => {
    expect(nominalBaud(115201)).toBe(115200);
    expect(nominalBaud(9600)).toBe(9600);
  });
});

describe('baudLabelTitle: the tooltip keeps the rate the board really clocks', () => {
  it('says how far off the divider is when the label rounds it', () => {
    const title = baudLabelTitle(117647);
    expect(title).toContain((117647).toLocaleString());
    expect(title).toContain((115200).toLocaleString());
    expect(title).toMatch(/\+2\.1\s?%/);
  });

  it('says nothing about a divider error the label does not round', () => {
    expect(baudLabelTitle(9600)).not.toMatch(/%/);
    expect(baudLabelTitle(115201)).not.toMatch(/%/);
  });
});

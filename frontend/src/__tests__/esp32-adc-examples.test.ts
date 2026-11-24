/**
 * The gallery's ESP32, ESP32-S3 and ESP32-C3 ADC examples read the ADC the
 * way the real chips do (velxio/velxio-prod#171).
 *
 * At the default 12 dB attenuation none of these chips is linear from 0 to
 * 3.3 V: the classic ESP32 reads 1872 for 1.65 V and reaches 4095 at about
 * 3.13 V, the S3 at about 3.1 V and the C3 at about 2.73 V. So
 * `raw * 3.3 / 4095` is not a voltage, and `map(raw, 0, 4095, -100, 100)`
 * does not put a centred joystick at 0. A sketch that wants volts asks the
 * core for calibrated millivolts (analogReadMilliVolts); a sketch that wants
 * a centred position learns the rest value at start-up.
 */
import { describe, expect, it } from 'vitest';
import { exampleProjects } from '../data/examples';

function code(id: string): string {
  const ex = exampleProjects.find((e) => e.id === id);
  if (!ex) throw new Error(`example ${id} not found`);
  return ex.code;
}
function text(id: string): string {
  const ex = exampleProjects.find((e) => e.id === id)!;
  return `${ex.title}\n${ex.description}\n${ex.code}`;
}

// raw * 3.3 / 4095, sum / 16.0 * 3.3 / 4095.0, raw * 3.3f / 4095.0f ...
const LINEAR = /\*\s*3\.3f?\s*\/\s*4095/;
// a 0..4095 span mapped straight onto a signed percentage
const FULL_SPAN_MAP = /map\(\s*\w+\s*,\s*0\s*,\s*4095\s*,\s*-100\s*,\s*100\s*\)/;

const VOLTAGE_EXAMPLES = [
  'esp32-dual-adc',
  'esp32-ntc-fan-control',
  'esp32s3-potentiometer',
  'c3-potentiometer',
];

describe('ESP32-family ADC gallery examples (#171)', () => {
  it.each(VOLTAGE_EXAMPLES)('%s converts with calibrated millivolts, not raw*3.3/4095', (id) => {
    const c = code(id);
    expect(c).not.toMatch(LINEAR);
    expect(c).toMatch(/analogReadMilliVolts\(/);
  });

  it('esp32-joystick learns its centre instead of assuming 0..4095 is symmetric', () => {
    const c = code('esp32-joystick');
    expect(c).not.toMatch(FULL_SPAN_MAP);
    expect(c).not.toMatch(/0[–-]4095/);
    // the rest value is averaged in setup() and each half is mapped on its own
    const setup = c.slice(c.indexOf('void setup()'), c.indexOf('void loop()'));
    expect(setup).toMatch(/\(JOY_HORZ\)/);
    expect(setup).toMatch(/\(JOY_VERT\)/);
    expect(c).toMatch(/map\(\s*\w+\s*,\s*0\s*,\s*\w+\s*,\s*-100\s*,\s*0\s*\)/);
    expect(c).toMatch(/map\(\s*\w+\s*,\s*\w+\s*,\s*4095\s*,\s*0\s*,\s*100\s*\)/);
  });

  it('esp32-dual-adc no longer claims a 3.3 V reference', () => {
    expect(text('esp32-dual-adc')).not.toMatch(/3\.3\s*V reference/i);
    expect(code('esp32-dual-adc')).toMatch(/3\.13 V/);
  });

  it('the S3 and C3 examples state where their 12 dB range ends', () => {
    expect(text('esp32s3-potentiometer')).toMatch(/3\.1 V/);
    expect(text('c3-potentiometer')).toMatch(/2\.7\d? V/);
  });
});

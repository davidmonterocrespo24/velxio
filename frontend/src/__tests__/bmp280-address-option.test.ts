/**
 * The BMP280's second address can be chosen, and the gallery's I2C scanner
 * says what it scans (velxio/velxio-prod#163).
 *
 * The part already answered at 0x77 when its element carried
 * `i2cAddress: '0x77'` (protocol-parts.test.ts), but nothing in the app could
 * set it: the catalog entry had no properties and the 4-pin board has no SDO
 * pin. So two BMP280s on one bus always collided, where a real board straps
 * SDO (Bosch BMP280 datasheet 5.2: 111011x, SDO to GND 0x76, to VDDIO 0x77).
 * Temperature and pressure need no catalog entry: the inspector takes them
 * from the sensor panel since 8e9f891f.
 *
 * The scanner example said "all 127 addresses" while its loop, like Arduino's
 * own i2c_scanner, covers 1-126; it named 0x76 a BME280 although Velxio's
 * BMP280 sits there by default (both chips share 0x76 / 0x77); and its loop()
 * called setup() again to rescan.
 */
import { describe, it, expect } from 'vitest';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { exampleProjects } from '../data/examples';

interface Prop {
  name: string;
  control?: string;
  options?: string[];
  defaultValue?: unknown;
}

describe('BMP280 address in the catalog (velxio/velxio-prod#163)', () => {
  const entry = (
    metadataJson as {
      components: Array<{ id: string; properties: Prop[]; defaultValues: Record<string, unknown> }>;
    }
  ).components.find((c) => c.id === 'bmp280');

  it('offers i2cAddress, the name the part reads, as 0x76 or 0x77', () => {
    expect(entry).toBeDefined();
    const prop = entry!.properties.find((p) => p.name === 'i2cAddress');
    expect(prop, 'bmp280 has no i2cAddress property').toBeDefined();
    expect(prop!.control).toBe('select');
    expect(prop!.options).toEqual(['0x76', '0x77']);
  });

  it('defaults to 0x76, where the part sits without one (SDO to GND)', () => {
    const prop = entry!.properties.find((p) => p.name === 'i2cAddress');
    expect(prop!.defaultValue).toBe('0x76');
    expect(entry!.defaultValues.i2cAddress).toBe('0x76');
  });
});

describe('the i2c-scanner example says what it does (velxio/velxio-prod#163)', () => {
  const code = exampleProjects.find((e) => e.id === 'i2c-scanner')?.code ?? '';

  it('is found', () => {
    expect(code).toContain('Wire.beginTransmission');
  });

  it('does not claim 127 addresses for its 1-126 loop', () => {
    expect(code).toMatch(/for \(byte addr = 1; addr < 127; addr\+\+\)/);
    expect(code).not.toMatch(/all 127/i);
  });

  it('names 0x76 and 0x77 for both chips that use them', () => {
    expect(code).toMatch(/case 0x76:.*BMP280\/BME280/);
    expect(code).toMatch(/case 0x77:.*BMP280\/BME280/);
  });

  it('scans in loop() and never calls setup() again', () => {
    const loop = code.slice(code.indexOf('void loop()'));
    expect(loop).toContain('Wire.beginTransmission');
    expect(loop).not.toMatch(/\bsetup\(\)/);
  });
});

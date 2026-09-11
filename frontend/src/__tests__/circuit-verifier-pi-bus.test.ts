/**
 * The Raspberry Pi bus-pin check: a part on I2C or SPI wired to the wrong
 * GPIO is named with the pin it needs, and nothing legitimate is flagged.
 */
import { describe, it, expect } from 'vitest';
import { piBusPinWarnings } from '../simulation/verify/circuitVerifier';
import type { BuildNetlistInput } from '../simulation/spice/types';

function board(id: string, boardKind: string): BuildNetlistInput['boards'][number] {
  return { id, boardKind, vcc: 3.3, pins: {}, groundPinNames: ['GND'], vccPinNames: ['3V3'] };
}

function wire(id: string, part: string, pin: string, boardId: string, boardPin: string): BuildNetlistInput['wires'][number] {
  return { id, start: { componentId: part, pinName: pin }, end: { componentId: boardId, pinName: boardPin } };
}

function check(
  boardKind: string,
  parts: Array<{ id: string; metadataId: string }>,
  wires: BuildNetlistInput['wires'],
) {
  return piBusPinWarnings({
    boards: [board('pi', boardKind)],
    components: parts.map((p) => ({ ...p, properties: {} })),
    wires,
  });
}

describe('piBusPinWarnings', () => {
  it('an MPU6050 on GPIO2/GPIO3 (or header pins 3/5) is fine', () => {
    expect(check('raspberry-pi-4', [{ id: 'mpu', metadataId: 'mpu6050' }], [
      wire('a', 'mpu', 'SDA', 'pi', 'GPIO2'),
      wire('b', 'mpu', 'SCL', 'pi', 'GPIO3'),
    ])).toEqual([]);
    expect(check('raspberry-pi-3', [{ id: 'mpu', metadataId: 'mpu6050' }], [
      wire('a', 'mpu', 'SDA', 'pi', '3'),
      wire('b', 'mpu', 'SCL', 'pi', '5'),
    ])).toEqual([]);
  });

  it('SDA on GPIO17 is named, with the pin it needs', () => {
    const w = check('raspberry-pi-4', [{ id: 'mpu', metadataId: 'mpu6050' }], [
      wire('a', 'mpu', 'SDA', 'pi', 'GPIO17'),
      wire('b', 'mpu', 'SCL', 'pi', 'GPIO3'),
    ]);
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe('bus-off-pins');
    expect(w[0].componentId).toBe('mpu');
    expect(w[0].message).toContain('GPIO17');
    expect(w[0].message).toContain('GPIO2 (header pin 3)');
  });

  it('an SPI part with its clock off SCLK is named; its chip select never is', () => {
    const w = check('raspberry-pi-5', [{ id: 'adc', metadataId: 'pro-mcp3008' }], [
      wire('a', 'adc', 'CLK', 'pi', 'GPIO5'),
      wire('b', 'adc', 'DOUT', 'pi', 'GPIO9'),
      wire('c', 'adc', 'DIN', 'pi', 'GPIO10'),
      wire('d', 'adc', 'CS', 'pi', 'GPIO22'),
    ]);
    expect(w.map((x) => x.message.split(' is on ')[0])).toEqual(['adc CLK']);
    expect(w[0].message).toContain('GPIO11 (header pin 23)');
  });

  it('a clock with no SPI data pin is a bit-banged part: HX711, TM1637, encoder', () => {
    expect(check('raspberry-pi-4', [
      { id: 'load', metadataId: 'hx711' },
      { id: 'disp', metadataId: 'tm1637-7segment' },
      { id: 'enc', metadataId: 'ky-040' },
    ], [
      wire('a', 'load', 'SCK', 'pi', 'GPIO5'),
      wire('b', 'load', 'DT', 'pi', 'GPIO6'),
      wire('c', 'disp', 'CLK', 'pi', 'GPIO23'),
      wire('d', 'disp', 'DIO', 'pi', 'GPIO24'),
      wire('e', 'enc', 'CLK', 'pi', 'GPIO17'),
      wire('f', 'enc', 'DT', 'pi', 'GPIO27'),
    ])).toEqual([]);
  });

  it('never on another board family, the Pico, or a UNIHIKER', () => {
    for (const kind of ['arduino-uno', 'esp32', 'raspberry-pi-pico', 'unihiker-m10']) {
      expect(check(kind, [{ id: 'mpu', metadataId: 'mpu6050' }], [wire('a', 'mpu', 'SDA', 'pi', 'GPIO17')]), kind).toEqual([]);
    }
  });

  it('a Pi wired to another board is the Interconnect, not a bus', () => {
    expect(piBusPinWarnings({
      boards: [board('pi', 'raspberry-pi-4'), board('uno', 'arduino-uno')],
      components: [],
      wires: [wire('a', 'uno', 'SDA', 'pi', 'GPIO17')],
    })).toEqual([]);
  });
});

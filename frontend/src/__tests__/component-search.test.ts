/**
 * The component picker's search over the REAL catalogue
 * (public/components-metadata.json): what a person types must reach the
 * part, whatever the scanned metadata happens to call it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import metadata from '../../public/components-metadata.json';
import registry from '../services/ComponentRegistry';
import type { ComponentMetadata } from '../types/component-metadata';

const ids = (query: string) => registry.search(query).map((c) => c.id);

beforeAll(async () => {
  // The module-level load() fetches /components-metadata.json, which has no
  // server here; wait for it to settle, then feed the same file directly.
  await registry.load().catch(() => undefined);
  registry.mergeComponents((metadata as { components: ComponentMetadata[] }).components);
});

describe('ComponentRegistry.search over the real catalogue', () => {
  it('blank query is the whole catalogue in browsing order', () => {
    expect(registry.search('')).toEqual(registry.getAllComponents());
    expect(registry.search('   ')).toEqual(registry.getAllComponents());
  });

  it('finds sensors by what they measure, not just their part number', () => {
    expect(ids('temperature')).toContain('dht22');
    expect(ids('temperature')).toContain('bmp280');
    expect(ids('temperature')).toContain('ntc-temperature-sensor');
    expect(ids('humidity')).toContain('dht22');
    expect(ids('ultrasonic')[0]).toBe('hc-sr04');
    expect(ids('distance')).toContain('hc-sr04');
    expect(ids('motion')).toContain('pir-motion-sensor');
    expect(ids('light')).toContain('photoresistor-sensor');
    expect(ids('clock')).toContain('ds3231');
    expect(ids('weight')).toContain('hx711');
  });

  it('finds displays by kind', () => {
    expect(ids('oled')[0]).toMatch(/^ssd1306/);
    expect(ids('screen')).toContain('ili9341');
    expect(ids('screen')).toContain('lcd1602-i2c');
    expect(ids('display 20x4')).toContain('lcd2004-i2c');
    expect(ids('eink')).toContain('epaper-2in9-bw');
  });

  it('is spelled-any-way and typo tolerant', () => {
    expect(ids('hc-sr04')[0]).toBe('hc-sr04');
    expect(ids('hc sr04')[0]).toBe('hc-sr04');
    expect(ids('hcsr04')[0]).toBe('hc-sr04');
    expect(ids('ssd 1306')[0]).toMatch(/^ssd1306/);
    expect(ids('potenciometer')[0]).toBe('potentiometer');
    expect(ids('ultrasnic')[0]).toBe('hc-sr04');
    expect(ids('neopixl')).toContain('neopixel');
    expect(ids('buzer')).toContain('buzzer');
  });

  it('works in the languages the UI ships in', () => {
    expect(ids('temperatura')).toContain('dht22');
    expect(ids('sensor de temperatura')).toContain('dht22');
    expect(ids('pantalla')).toContain('ssd1306');
    expect(ids('pantalla')).toContain('lcd1602');
    expect(ids('boton')[0]).toMatch(/^pushbutton/);
    expect(ids('pulsador')[0]).toMatch(/^pushbutton/);
    expect(ids('potenciometro')[0]).toBe('potentiometer');
    expect(ids('zumbador')[0]).toBe('buzzer');
    expect(ids('resistencia')).toContain('resistor');
    expect(ids('ultrasonido')[0]).toBe('hc-sr04');
    expect(ids('reloj')).toContain('ds1307');
    expect(ids('schrittmotor')).toContain('stepper-motor');
    expect(ids('moteur pas')).toContain('stepper-motor');
    expect(ids('umidita')).toContain('dht22');
    expect(ids('botao')[0]).toMatch(/^pushbutton/);
  });

  it('ranks the part that carries the name first', () => {
    expect(ids('led')[0]).toBe('led');
    expect(ids('servo')[0]).toBe('servo');
    expect(ids('relay')[0]).toBe('relay');
    expect(ids('and gate')[0]).toBe('logic-gate-and');
    expect(ids('nand')[0]).toMatch(/nand/);
    expect(ids('button')[0]).toBe('pushbutton');
    expect(ids('breadboard')[0]).toBe('breadboard');
  });

  it('several words narrow the result', () => {
    const rgb = ids('rgb led');
    expect(rgb[0]).toBe('rgb-led');
    expect(rgb.length).toBeLessThan(ids('led').length);
    expect(ids('temperature i2c')).toContain('bmp280');
    expect(ids('temperature i2c')).not.toContain('ntc-temperature-sensor');
  });

  it('finds nothing for nonsense', () => {
    expect(ids('qzqzqzqz')).toEqual([]);
  });
});

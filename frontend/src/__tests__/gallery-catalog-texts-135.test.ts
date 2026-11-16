/**
 * Gallery and catalog texts that did not match the models (velxio/velxio-prod#135).
 *
 * 1. an-diode-clipper said "Two diodes to VCC/GND ... roughly ±0.7 V". Both
 *    1N4007s go from the output to ground, anti-parallel, and a real 1N4007
 *    at the 4.4 mA this circuit draws drops about 0.6 V (Vishay's 1N4007
 *    model clips this circuit at ±0.59 V; Fairchild's 1N4001-4007 sheet,
 *    figure 2: about 0.62 V at 10 mA).
 * 2. The NTC module's catalog entry declared no properties (and 0 pins), so
 *    the agent saw none of what its circuit model reads: R0, β and the
 *    pull-up (componentToSpice). The editor had no field for them either,
 *    and the part's own ADC write used 10 kΩ / 3950 / 10 kΩ whatever the
 *    project set, so it disagreed with the circuit solve for any other part.
 * (The analog thermostat template the issue missed exists, in
 * examples-analog-projects.ts; the agent index's board field is pro's.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { analogExamples } from '../data/examples-analog';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { parseValueWithUnits } from '../simulation/spice/valueParser';
import '../simulation/parts/SensorParts';

afterEach(() => vi.unstubAllGlobals());

describe('an-diode-clipper text (velxio/velxio-prod#135, item 1)', () => {
  const clipper = analogExamples.find((e) => e.id === 'an-diode-clipper')!;

  it('describes the circuit drawn: two anti-parallel diodes from the output to ground', () => {
    expect(clipper.description).not.toMatch(/VCC/);
    expect(clipper.description).toMatch(/anti-parallel/i);
    expect(clipper.description).toMatch(/ground/i);
    // The wiring it describes: d1 anode and d2 cathode on the output, the
    // other ends on the generator's ground.
    const ends = clipper.wires.map((w) => `${w.start.componentId}:${w.start.pinName}>${w.end.componentId}:${w.end.pinName}`);
    expect(ends).toContain('d1:C>src:GND');
    expect(ends).toContain('d2:A>src:GND');
  });

  it("gives a real 1N4007's clip level at this current, about ±0.6 V", () => {
    expect(clipper.description).toMatch(/±0\.6 V/);
    expect(clipper.description).not.toMatch(/±0\.7/);
  });
});

describe('the NTC module in the catalog and on the canvas (velxio/velxio-prod#135, item 3)', () => {
  type Prop = { name: string; defaultValue?: unknown };
  const items = (Array.isArray(metadataJson) ? metadataJson : (metadataJson as { components: unknown[] }).components) as Array<{
    id: string;
    properties: Prop[];
    defaultValues: Record<string, unknown>;
    pinCount: number;
    description?: string;
  }>;
  const ntc = items.find((c) => c.id === 'ntc-temperature-sensor')!;

  it('declares the parameters its circuit model reads, with the same defaults', () => {
    const byName = Object.fromEntries(ntc.properties.map((p) => [p.name, p.defaultValue]));
    expect(byName).toMatchObject({ R0: 10000, beta: 3950, pullup: 10000 });
    expect(ntc.defaultValues).toMatchObject({ R0: 10000, beta: 3950, pullup: 10000 });
    expect(ntc.pinCount).toBe(3);
    expect(ntc.description ?? '').toMatch(/NTC/);
    // The overrides carry it, so a regeneration keeps it.
    const overrides = JSON.parse(readFileSync(new URL('../../../scripts/component-overrides.json', import.meta.url), 'utf8'));
    expect(Object.keys(overrides['ntc-temperature-sensor']?.properties ?? {}).sort()).toEqual(['R0', 'beta', 'pullup']);
  });

  it("the part's own ADC write agrees with the circuit model for a part with other values", () => {
    const props = { temperature: 40, R0: '100k', beta: 4250, pullup: '47k' };
    // What the circuit solve puts on OUT: the mapper's divider on a 5 V rail.
    const { cards } = componentToSpice(
      { id: 'n', metadataId: 'ntc-temperature-sensor', properties: props },
      (pin) => ({ VCC: 'vcc', GND: '0', OUT: 'out' })[pin] ?? null,
      { vcc: 5 },
    )!;
    const value = (name: string) => parseValueWithUnits(cards.find((c) => c.startsWith(name))!.split(/\s+/)[3], NaN);
    const rPull = value('R_n_pull');
    const rNtc = value('R_n_ntc');
    const spiceVolts = (5 * rNtc) / (rNtc + rPull);

    // What the part writes to the ADC before any solve, on an Uno.
    const adc = { channelValues: new Array(8).fill(0) };
    const sim = {
      pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}), onPwmChange: vi.fn().mockReturnValue(() => {}), triggerPinChange: vi.fn() },
      getADC: () => adc,
      setPinState: vi.fn(),
      cpu: { data: new Uint8Array(512), cycles: 0 },
    };
    const element = { addEventListener: vi.fn(), removeEventListener: vi.fn(), ...props } as unknown as HTMLElement;
    PartSimulationRegistry.get('ntc-temperature-sensor')!.attachEvents!(element, sim as never, (pin: string) => (pin === 'OUT' ? 14 : null), 'n');
    expect(adc.channelValues[0]).toBeCloseTo(spiceVolts, 4);
  });
});

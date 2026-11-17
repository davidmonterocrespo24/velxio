/**
 * A scope probe on a node a capacitor or an inductor holds shows that node's
 * voltage, not the pulses of the pin behind it (velxio/velxio-prod#142).
 *
 * resolveProbe's rule 2 follows PinTrace across passives to a GPIO, so that a
 * series resistor into an LED still shows the driving pin's square wave with
 * its exact edge times. PinTrace crosses capacitors and inductors too, so on
 * the gallery's arduino-pwm-dac-opamp both wires of the RC filter's output
 * resolved to D9, and the scope drew pin 9's 490 Hz PWM where the node is a
 * nearly flat DC level: removing that PWM is the whole point of the RC (TI
 * SPRAA88A). The digital path holds only when every hop is resistive and no
 * node walked before the pin's own (the probed node included) has a C or an L
 * on it; otherwise the probe reads the SPICE net.
 */
import { describe, it, expect } from 'vitest';
import { resolveProbe } from '../simulation/probeResolve';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput, stripBrandPrefix, isBoardComponentType } from '../utils/exampleToBuildNetlistInput';
import { analogProjectExamples } from '../data/examples-analog-projects';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
  end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
  waypoints: [],
  color: '#0af',
});

const uno = { id: 'uno', boardKind: 'arduino-uno' as const, x: 0, y: 0, running: true };
const part = (id: string, metadataId: string, value?: string) => ({
  id,
  metadataId,
  x: 0,
  y: 0,
  properties: value ? { value } : {},
});

describe('a scope probe on a filtered node reads the circuit, not the pin', () => {
  it('arduino-pwm-dac-opamp: the RC output wires resolve to the filter net, not D9', () => {
    const ex = analogProjectExamples.find((e) => e.id === 'arduino-pwm-dac-opamp');
    expect(ex, 'gallery example present').toBeTruthy();
    const board = ex!.components.find((c) => isBoardComponentType(c.type))!;
    const input = exampleToBuildNetlistInput(ex!, {
      boards: [{ id: board.id, boardKind: 'arduino-uno', pinStates: { '9': { type: 'pwm', duty: 0.5 } as never } }],
    });
    const { pinNetMap } = buildNetlist(input);
    const state = {
      boards: [{ id: board.id, boardKind: 'arduino-uno', x: 0, y: 0, running: true }],
      components: ex!.components
        .filter((c) => !isBoardComponentType(c.type))
        .map((c) => ({ id: c.id, metadataId: stripBrandPrefix(c.type), x: 0, y: 0, properties: c.properties ?? {} })),
      wires: ex!.wires.map((w) => ({ ...w, waypoints: [] })),
    };
    const ctx = { state: state as never, pinNetMap };
    const filterNet = pinNetMap.get('c1:+');
    expect(filterNet, 'the filter node has a net').toBeTruthy();

    const byId = new Map(ex!.wires.map((w) => [w.id, w as unknown as Wire]));
    // w2: R1 -> LM358 IN+, w3: R1 -> C1 +. Both are the RC's output node.
    for (const id of ['w2', 'w3']) {
      expect(resolveProbe(byId.get(id)!, ctx), id).toEqual({ kind: 'analog', netName: filterNet, label: filterNet });
    }
    // The wire ON pin 9 keeps the logic-analyzer path.
    expect(resolveProbe(byId.get('w1')!, ctx)).toMatchObject({ kind: 'digital', pin: 9 });
  });

  it('a capacitor on any node between the pin and the probe sends it to the solver', () => {
    // pin 9 -> R1 -> n1 (C1 to GND) -> R2 -> LED anode: probing the anode
    // wire crosses n1, which the capacitor holds.
    const wires = [
      wire('a', ['uno', '9'], ['r1', '1']),
      wire('b', ['r1', '2'], ['c1', '1']),
      wire('c', ['c1', '2'], ['uno', 'GND.1']),
      wire('d', ['r1', '2'], ['r2', '1']),
      wire('e', ['r2', '2'], ['led1', 'A']),
      wire('f', ['led1', 'C'], ['uno', 'GND.2']),
    ];
    const state = {
      boards: [uno],
      components: [part('r1', 'resistor', '1k'), part('c1', 'cap-100n'), part('r2', 'resistor', '220'), part('led1', 'led')],
      wires,
    };
    const pinNetMap = new Map([['r2:2', 'n2'], ['led1:A', 'n2']]);
    expect(resolveProbe(wires[4]!, { state: state as never, pinNetMap })).toEqual({
      kind: 'analog',
      netName: 'n2',
      label: 'n2',
    });
  });

  it('an inductor in series is not a wire either', () => {
    // pin 9 -> L1 -> R1 to GND: the current, and the voltage on R1, lag the pin.
    const wires = [
      wire('a', ['uno', '9'], ['l1', '1']),
      wire('b', ['l1', '2'], ['r1', '1']),
      wire('c', ['r1', '2'], ['uno', 'GND.1']),
    ];
    const state = { boards: [uno], components: [part('l1', 'ind-10m'), part('r1', 'resistor', '100')], wires };
    const pinNetMap = new Map([['l1:2', 'n1'], ['r1:1', 'n1']]);
    expect(resolveProbe(wires[1]!, { state: state as never, pinNetMap })).toEqual({
      kind: 'analog',
      netName: 'n1',
      label: 'n1',
    });
  });

  it('keeps the digital path for a series resistor into an LED, with a capacitor on the pin itself', () => {
    // The pin drives its own node: a capacitor there does not filter what a
    // resistor passes on, so the LED's anode still shows pin 13's edges.
    const wires = [
      wire('a', ['uno', '13'], ['r1', '1']),
      wire('b', ['r1', '1'], ['c1', '1']),
      wire('c', ['c1', '2'], ['uno', 'GND.1']),
      wire('d', ['r1', '2'], ['led1', 'A']),
      wire('e', ['led1', 'C'], ['uno', 'GND.2']),
    ];
    const state = {
      boards: [uno],
      components: [part('r1', 'resistor', '220'), part('c1', 'capacitor', '100n'), part('led1', 'led')],
      wires,
    };
    const pinNetMap = new Map([['r1:2', 'n1'], ['led1:A', 'n1']]);
    expect(resolveProbe(wires[3]!, { state: state as never, pinNetMap })).toMatchObject({
      kind: 'digital',
      boardId: 'uno',
      pin: 13,
    });
  });
});

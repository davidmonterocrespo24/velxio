/**
 * digital-gate-engine Phase 5 — sequential logic (D/T/JK flip-flops) on the
 * event-driven engine. project/digital-gate-engine/.
 *
 * Flip-flops are edge-triggered: they sample their data inputs on the rising
 * edge of CLK and hold Q between edges. The combinational settle kernel cannot
 * model that on its own, so the engine gives each flip-flop explicit state +
 * edge detection (reusing the LogicGateParts sample semantics). Because a
 * flip-flop only updates on the clock edge, a Q->D feedback (a counter / shift
 * register) does NOT oscillate the settle loop — these circuits are impossible
 * on the SPICE B-source path (no edge detection at DC; no SPICE mapper).
 *
 * A switch supplies the clock (closed = 1). A full clock cycle = setSwitch(1)
 * then setSwitch(0); each rising 0->1 is one trigger.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetBusNets } from '../simulation/customChips/busNets';
import { buildDigitalNetwork, type DigitalComponent, type DigitalWire } from '../simulation/digital/digitalGateEngine';

beforeEach(() => resetBusNets());

const W = (a: string, ap: string, b: string, bp: string): DigitalWire => ({ start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp } });
// The 5 V rail, set the way the gallery's digital examples set it: a generator
// is the waveform it is set to (#146), and one with no settings is the
// catalogue's default 1 kHz, 1 V sine, which never reaches the gates' 2.5 V.
const src: DigitalComponent = {
  id: 'src',
  metadataId: 'signal-generator',
  properties: { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 },
};
const sw = (id: string, v: 0 | 1 = 0): DigitalComponent => ({ id, metadataId: 'slide-switch', properties: { value: v } });

describe('digital-gate-engine Phase 5 — flip-flops', () => {
  it('D flip-flop: Q <- D on the rising edge, holds between edges', () => {
    const comps = [src, sw('clk'), sw('d'), { id: 'ff', metadataId: 'flip-flop-d' }];
    const wires = [
      W('src', 'SIG', 'clk', '3'), W('clk', '2', 'ff', 'CLK'),
      W('src', 'SIG', 'd', '3'), W('d', '2', 'ff', 'D'),
    ];
    const net = buildDigitalNetwork(comps, wires);
    const Q = net.netOf('ff', 'Q')!;
    const pulse = () => { net.setSwitch('clk', 1); net.setSwitch('clk', 0); };

    expect(net.readNet(Q), 'initial Q=0').toBe(0);
    net.setSwitch('d', 1); pulse();
    expect(net.readNet(Q), 'D=1 clocked -> Q=1').toBe(1);
    net.setSwitch('d', 0);
    expect(net.readNet(Q), 'Q holds 1 before the next edge').toBe(1);
    pulse();
    expect(net.readNet(Q), 'D=0 clocked -> Q=0').toBe(0);
  });

  it('T flip-flop: toggles on each rising edge when T=1', () => {
    const comps = [src, sw('clk'), { id: 'ff', metadataId: 'flip-flop-t' }];
    const wires = [W('src', 'SIG', 'clk', '3'), W('clk', '2', 'ff', 'CLK'), W('src', 'SIG', 'ff', 'T')]; // T tied high
    const net = buildDigitalNetwork(comps, wires);
    const Q = net.netOf('ff', 'Q')!;
    const seq: number[] = [net.readNet(Q)];
    for (let i = 0; i < 4; i++) { net.setSwitch('clk', 1); net.setSwitch('clk', 0); seq.push(net.readNet(Q)); }
    expect(seq, 'T=1 toggles each clock').toEqual([0, 1, 0, 1, 0]);
  });

  it('JK flip-flop: hold / set / reset / toggle', () => {
    const comps = [src, sw('clk'), sw('j'), sw('k'), { id: 'ff', metadataId: 'flip-flop-jk' }];
    const wires = [
      W('src', 'SIG', 'clk', '3'), W('clk', '2', 'ff', 'CLK'),
      W('src', 'SIG', 'j', '3'), W('j', '2', 'ff', 'J'),
      W('src', 'SIG', 'k', '3'), W('k', '2', 'ff', 'K'),
    ];
    const net = buildDigitalNetwork(comps, wires);
    const Q = net.netOf('ff', 'Q')!;
    const pulse = () => { net.setSwitch('clk', 1); net.setSwitch('clk', 0); };
    const set = (j: 0 | 1, k: 0 | 1) => { net.setSwitch('j', j); net.setSwitch('k', k); };

    set(1, 0); pulse(); expect(net.readNet(Q), 'J=1,K=0 set -> 1').toBe(1);
    set(0, 0); pulse(); expect(net.readNet(Q), 'J=0,K=0 hold -> 1').toBe(1);
    set(0, 1); pulse(); expect(net.readNet(Q), 'J=0,K=1 reset -> 0').toBe(0);
    set(1, 1); pulse(); expect(net.readNet(Q), 'J=1,K=1 toggle -> 1').toBe(1);
    set(1, 1); pulse(); expect(net.readNet(Q), 'J=1,K=1 toggle -> 0').toBe(0);
  });

  it('2-bit ripple counter from T flip-flops (impossible on the SPICE path)', () => {
    // FF0 toggles on every clock; FF1 is clocked by FF0.Qbar so it toggles when
    // FF0 goes 1->0. Counts 00,01,10,11,00 across rising clock edges.
    const comps = [
      src, sw('clk'),
      { id: 'ff0', metadataId: 'flip-flop-t' },
      { id: 'ff1', metadataId: 'flip-flop-t' },
    ];
    const wires = [
      W('src', 'SIG', 'clk', '3'), W('clk', '2', 'ff0', 'CLK'),
      W('src', 'SIG', 'ff0', 'T'), W('src', 'SIG', 'ff1', 'T'), // both T high
      W('ff0', 'Qbar', 'ff1', 'CLK'), // ripple: FF0.Qbar clocks FF1
    ];
    const net = buildDigitalNetwork(comps, wires);
    const Q0 = net.netOf('ff0', 'Q')!;
    const Q1 = net.netOf('ff1', 'Q')!;
    const read = () => net.readNet(Q0) + net.readNet(Q1) * 2;

    expect(read(), 'start 0').toBe(0);
    const got: number[] = [];
    for (let i = 0; i < 5; i++) { net.setSwitch('clk', 1); net.setSwitch('clk', 0); got.push(read()); }
    expect(got, 'counts 1,2,3,0,1').toEqual([1, 2, 3, 0, 1]);
  });
});

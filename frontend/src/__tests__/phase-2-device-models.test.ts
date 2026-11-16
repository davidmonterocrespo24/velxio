/**
 * Phase 2 lockdown — verify the BJT and diode model upgrades survived
 * any later edits to componentToSpice.ts. Asserts that the upgraded
 * models include the parameters that distinguish them from the old
 * truncated SPICE3F5 placeholders.
 *
 * If these fail, someone reasonably simplified the models again — that
 * regresses AC/transient fidelity. Either re-upgrade the model or
 * remove this test consciously.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import type { PlacedComponent } from '../simulation/spice/types';

function netLookupStub(_pin: string): string {
  return 'net_dummy';
}

function emit(metadataId: string, properties: Record<string, unknown> = {}): string[] {
  const comp: PlacedComponent = { id: 't1', metadataId, properties };
  const result = componentToSpice(comp, netLookupStub, { vcc: 5 });
  if (!result) throw new Error(`no emission for ${metadataId}`);
  return Array.from(result.modelsUsed);
}

describe('Phase 2 — BJT Gummel-Poon parameters present', () => {
  it.each([
    ['bjt-2n2222', 'Q2N2222'],
    ['bjt-bc547', 'QBC547'],
    ['bjt-2n3055', 'Q2N3055'],
    ['bjt-2n3906', 'Q2N3906'],
    ['bjt-bc557', 'QBC557'],
  ])('%s model includes Gummel-Poon junction caps and transit times', (id, modelName) => {
    const models = emit(id);
    const m = models.find((s) => s.includes(modelName));
    expect(m, `no model card found for ${modelName}`).toBeDefined();
    const text = (m ?? '').toUpperCase();
    // Junction caps — separates Phase 2 model from the old truncated one.
    expect(text).toMatch(/CJC=/);
    expect(text).toMatch(/CJE=/);
    // Forward transit time — required for switching/AC behaviour.
    expect(text).toMatch(/TF=/);
    // Bf must still be there too (sanity).
    expect(text).toMatch(/BF=/);
  });
});

describe('Phase 2 — diode reverse-recovery and junction capacitance', () => {
  it('D1N4148 includes tt (storage time) and Cjo', () => {
    const models = emit('diode-1n4148');
    const m = models.find((s) => s.includes('D1N4148'));
    expect(m).toBeDefined();
    expect(m).toMatch(/tt=/i);
    expect(m).toMatch(/Cjo=/i);
  });

  it('Schottky 1N5817 carries Eg (Schottky band-gap) and Cjo', () => {
    const models = emit('diode-1n5817');
    const m = models.find((s) => s.includes('D1N5817'));
    expect(m).toBeDefined();
    expect(m).toMatch(/Eg=/i);
    expect(m).toMatch(/Cjo=/i);
  });

  it('Schottky 1N5819 carries Eg and Cjo', () => {
    const models = emit('diode-1n5819');
    const m = models.find((s) => s.includes('D1N5819'));
    expect(m).toBeDefined();
    expect(m).toMatch(/Eg=/i);
    expect(m).toMatch(/Cjo=/i);
  });
});

describe('Phase 2.1 — MOSFETs use VDMOS 3-terminal syntax', () => {
  it.each([
    ['mosfet-2n7000', 'M2N7000'],
    ['mosfet-irf540', 'MIRF540'],
    ['mosfet-irf9540', 'MIRF9540'],
    // Fitted to Fairchild's datasheet (velxio/velxio-prod#136); it was the
    // last Level=1 placeholder.
    ['mosfet-fqp27p06', 'MFQP27P06'],
  ])('%s emits a VDMOS .model and a 3-terminal Mxxx card', (id, modelName) => {
    const comp: PlacedComponent = { id: 'q1', metadataId: id, properties: {} };
    const result = componentToSpice(comp, netLookupStub, { vcc: 5 });
    if (!result) throw new Error(`no emission for ${id}`);
    const m = Array.from(result.modelsUsed).find((s) => s.includes(modelName));
    expect(m, `no model card found for ${modelName}`).toBeDefined();
    expect(m).toMatch(/VDMOS\(/);

    // Instance card must NOT include the old Level=1 body terminal + W/L.
    const instance = result.cards.find((c) => c.startsWith('M_'));
    expect(instance).toBeDefined();
    expect(instance).not.toMatch(/L=2u/);
    expect(instance).not.toMatch(/W=\d/);
    // 3-terminal Mxxx: `M_id D G S MODEL` → 5 tokens.
    expect((instance ?? '').trim().split(/\s+/)).toHaveLength(5);
  });
});

describe('Phase 2 — relay flyback keeps the canonical D1N4148 string', () => {
  it('relay emits the same D1N4148 .model string as a standalone diode', () => {
    const standaloneModels = emit('diode-1n4148');
    const relayModels = emit('relay');
    const standalone = standaloneModels.find((s) => s.includes('D1N4148'));
    const fromRelay = relayModels.find((s) => s.includes('D1N4148'));
    expect(standalone).toBeDefined();
    expect(fromRelay).toBeDefined();
    // Must match exactly — the netlist dedupe Set collapses them by string
    // identity. If they ever diverge, ngspice will see duplicate .model
    // definitions and error out.
    expect(fromRelay).toBe(standalone);
  });
});

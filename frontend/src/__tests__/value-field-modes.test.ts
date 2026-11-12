/**
 * A field the part's mode does not read is never validated, and an empty
 * field it does read runs with its default without blocking Run
 * (velxio/velxio-prod#118 follow-up).
 *
 * The invalid-value check (bf5a8937) read every number field of a part. A DC
 * supply whose "AC mode only" frequency was empty, or a DC generator whose
 * "ignored for DC" amplitude was empty, opened the blocking circuit-check
 * modal ("its frequency "" is not a value ... It runs with 50 Hz") although
 * the netlist never reads the field in that mode and the readings were the
 * same. The production corpus held 7 such supplies in 6 projects and one
 * generator. These are the browser checker's projects X2 and X8 as it built
 * them (bookv batch-a), run through the Run button's own pre-flight.
 */
import { describe, it, expect } from 'vitest';
import { buildPreflightSnapshot, type PreflightState } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { componentToSpice, mappedMetadataIds } from '../simulation/spice/componentToSpice';
import { fieldIsRead, valueFieldsOf } from '../simulation/spice/valueFields';

const wire = (id: string, a: string, b: string) => {
  const [ac, ap] = a.split(':');
  const [bc, bp] = b.split(':');
  return { id, start: { componentId: ac!, pinName: ap! }, end: { componentId: bc!, pinName: bp! } };
};

/** A source on a 1 kΩ load with a voltmeter across it, as the checker drew X2 and X8. */
function onLoad(source: { id: string; metadataId: string; properties: Record<string, unknown> }): PreflightState {
  const pos = 'SIG';
  return {
    components: [
      source,
      { id: 'r1', metadataId: 'resistor', properties: { value: '1000' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ],
    wires: [
      wire('w0', `${source.id}:${pos}`, 'r1:1'),
      wire('w1', 'r1:2', `${source.id}:GND`),
      wire('w2', 'r1:1', 'vm:V+'),
      wire('w3', `${source.id}:GND`, 'vm:V-'),
    ],
    boards: [],
  };
}

async function check(state: PreflightState) {
  const { snap, synthesizedPins } = buildPreflightSnapshot(state);
  const input = buildInputFromStore(snap);
  const result = await verifyCircuit(input, { synthesizedPins });
  const findings = [...result.errors, ...result.warnings].filter((f) => f.code === 'invalid-value');
  return { result, findings };
}

const X2 = { id: 'ps', metadataId: 'power-supply', properties: { mode: 'dc', voltage: 5, frequency: '', currentLimit: 1 } };
const X8 = { id: 'gen', metadataId: 'signal-generator', properties: { waveform: 'dc', frequency: 1, amplitude: '', offset: 5 } };

describe('a field the mode does not read', () => {
  it('X2: a DC supply with an empty frequency runs with no finding', async () => {
    const { result, findings } = await check(onLoad(X2));
    expect(findings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('X8: a DC generator with an empty amplitude runs with no finding', async () => {
    const { result, findings } = await check(onLoad(X8));
    expect(findings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('nor when it holds a text that is not a value', async () => {
    const dc = await check(onLoad({ ...X2, properties: { ...X2.properties, frequency: 'fifty' } }));
    expect(dc.findings).toEqual([]);
    const gen = await check(onLoad({ ...X8, properties: { ...X8.properties, amplitude: 'big', frequency: '1,5k' } }));
    expect(gen.findings).toEqual([]);
  });

  it('the mode that reads the field checks it again', async () => {
    const ac = await check(onLoad({ ...X2, properties: { ...X2.properties, mode: 'ac', frequency: 'fifty' } }));
    expect(ac.result.errors.map((e) => `${e.code} ${e.componentId}`)).toEqual(['invalid-value ps']);
    expect(ac.result.errors[0]!.message).toContain('frequency');
    const sine = await check(onLoad({ ...X8, properties: { ...X8.properties, waveform: 'sine', amplitude: 'big' } }));
    expect(sine.result.errors.map((e) => `${e.code} ${e.componentId}`)).toEqual(['invalid-value gen']);
    expect(sine.result.errors[0]!.message).toContain('amplitude');
  });
});

describe('an empty field the mode reads', () => {
  // The simulator runs it with the field's default, the value a new part
  // has. Run is not blocked for that; the console says what it runs with,
  // and the inspector keeps its note under the field.
  it('a supply with no voltage runs at its default 5 V and warns', async () => {
    const { result, findings } = await check(onLoad({ ...X2, properties: { ...X2.properties, voltage: '' } }));
    expect(result.errors).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.componentId).toBe('ps');
    expect(findings[0]!.message).toContain('voltage');
    expect(findings[0]!.message).toContain('5 V');
  });

  it('an AC supply with an empty frequency runs at 50 Hz and warns', async () => {
    const { result, findings } = await check(onLoad({ ...X2, properties: { ...X2.properties, mode: 'ac' } }));
    expect(result.errors).toEqual([]);
    expect(findings.map((f) => f.severity)).toEqual(['warning']);
    expect(findings[0]!.message).toContain('50 Hz');
  });

  it('a resistor with no value runs at 1 kΩ and warns', async () => {
    const state = onLoad({ id: 'bat', metadataId: 'battery-9v', properties: {} });
    state.wires = [wire('w0', 'bat:+', 'r1:1'), wire('w1', 'r1:2', 'bat:−')];
    state.components[1] = { id: 'r1', metadataId: 'resistor', properties: { value: ' ' } };
    const { result, findings } = await check(state);
    expect(result.errors).toEqual([]);
    expect(findings.map((f) => `${f.severity} ${f.componentId}`)).toEqual(['warning r1']);
    expect(findings[0]!.message).toContain('1 kΩ');
  });

  it('a text that is not a value still blocks Run', async () => {
    const state = onLoad({ id: 'bat', metadataId: 'battery-9v', properties: {} });
    state.wires = [wire('w0', 'bat:+', 'r1:1'), wire('w1', 'r1:2', 'bat:−')];
    state.components[1] = { id: 'r1', metadataId: 'resistor', properties: { value: '4,7k' } };
    const { result } = await check(state);
    expect(result.errors.map((e) => `${e.code} ${e.componentId}`)).toEqual(['invalid-value r1']);
  });
});

describe('the table knows which fields each mode reads, as the mappers do', () => {
  /** Every mode a part's mapper tells apart. */
  const MODES: Record<string, Array<Record<string, unknown>>> = {
    'power-supply': [{}, { mode: 'dc' }, { mode: 'ac' }, { mode: 'AC' }],
    'signal-generator': [{}, { waveform: 'sine' }, { waveform: 'square' }, { waveform: 'dc' }, { waveform: 'DC' }],
  };
  const emit = (metadataId: string, properties: Record<string, unknown>) =>
    componentToSpice({ id: 'x', metadataId, properties }, (pin) => `n_${pin.replace(/[^A-Za-z0-9]/g, '_')}`, { vcc: 5 })
      ?.cards.join('\n') ?? '';

  for (const [id, modes] of Object.entries(MODES)) {
    it(`${id}: a field changes the netlist exactly in the modes that read it`, () => {
      for (const mode of modes) {
        for (const field of valueFieldsOf(id)) {
          const a = emit(id, { ...mode, [field.prop]: field.fallback * 2 + 1 });
          const b = emit(id, { ...mode, [field.prop]: field.fallback * 3 + 2 });
          const read = fieldIsRead({ metadataId: id, properties: mode }, field);
          expect(a !== b, `${id} ${JSON.stringify(mode)} ${field.prop}: read=${read}`).toBe(read);
        }
      }
    });
  }

  it('the parts with no modes read every field', () => {
    const others = mappedMetadataIds().filter((m) => valueFieldsOf(m).length > 0 && !(m in MODES));
    expect(others).toContain('resistor');
    for (const id of others) {
      for (const field of valueFieldsOf(id)) {
        expect(fieldIsRead({ metadataId: id, properties: {} }, field), `${id} ${field.prop}`).toBe(true);
      }
    }
  });
});

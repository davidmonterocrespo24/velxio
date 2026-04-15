/**
 * NetlistBuilder — turn a Velxio circuit (components + wires + board pin
 * state) into a complete ngspice netlist string.
 *
 * Algorithm (see plan phase_8_velxio_implementation §5):
 *   1. Union-Find on wires to identify nets.
 *   2. Canonicalize known-special nets: GND → "0", VCC/VDD/5V/3V3 → "vcc_rail".
 *   3. Auto-name remaining nets "n0", "n1", ... deterministically.
 *   4. Detect floating nodes (no DC path to 0) → add auto pull-down 100 MΩ.
 *   5. Emit component cards via `componentToSpice`.
 *   6. Emit board GPIO source cards (digital or PWM quasi-static).
 *   7. Emit the Vcc rail source.
 *   8. Append `.model` / `.subckt` cards for every used device.
 *   9. Append analysis card (`.op` / `.tran` / `.ac`).
 *  10. `.end`.
 */
import { UnionFind } from './unionFind';
import { componentToSpice } from './componentToSpice';
import type {
  BuildNetlistInput,
  ComponentForSpice,
  BoardForSpice,
  WireForSpice,
} from './types';

const GROUND_PIN_RE = /^(gnd|vss|vee|ground|gnd\.\d+)$/i;
// Deliberately excludes "V+" / "V-" (which are probe terminals) and
// "VBB" (non-standard). VCC-like pins on boards are handled via the
// board.vccPinNames list, not this regex.
const VCC_PIN_RE = /^(vcc|vdd|vcc_rail|5v|3v3|3\.3v)$/i;

/** metadataId prefixes of components that must NOT be auto-canonicalized
 *  by the pin-name regex (their pins are just probe labels). */
function skipCanonicalization(metadataId: string): boolean {
  return metadataId.startsWith('instr-');
}

export function buildNetlist(input: BuildNetlistInput): string {
  const { components, wires, boards, analysis, extraCards = [] } = input;

  // ── 1. Union-Find over wires ─────────────────────────────────────────────
  const uf = new UnionFind();
  const pinKey = (componentId: string, pinName: string) => `${componentId}:${pinName}`;

  // Seed every pin referenced by a wire (components pins are added on demand)
  for (const w of wires) {
    const a = pinKey(w.start.componentId, w.start.pinName);
    const b = pinKey(w.end.componentId, w.end.pinName);
    uf.add(a);
    uf.add(b);
    uf.union(a, b);
  }

  // ── 2. Canonicalize ground / VCC pins ────────────────────────────────────
  for (const board of boards) {
    for (const pinName of board.groundPinNames ?? []) {
      uf.setCanonical(pinKey(board.id, pinName), '0');
    }
    for (const pinName of board.vccPinNames ?? []) {
      uf.setCanonical(pinKey(board.id, pinName), 'vcc_rail');
    }
  }
  for (const comp of components) {
    if (skipCanonicalization(comp.metadataId)) continue;
    for (const pinName of pinsReferencedByWires(comp.id, wires)) {
      if (GROUND_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(comp.id, pinName), '0');
      } else if (VCC_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(comp.id, pinName), 'vcc_rail');
      }
    }
  }

  // ── 3. Auto-name remaining nets deterministically ────────────────────────
  const netNames = assignDeterministicNetNames(uf);

  // Helper: pin → net name (null if pin isn't in any net)
  function netLookup(componentId: string, pinName: string): string | null {
    const key = pinKey(componentId, pinName);
    if (!uf.has(key)) return null;
    return netNames.get(uf.find(key)) ?? null;
  }

  // ── 4. Emit component cards ───────────────────────────────────────────────
  const cards: string[] = [];
  const modelLines = new Set<string>();
  const dominantVcc = boards[0]?.vcc ?? 5;

  for (const comp of components) {
    const localLookup = (pinName: string) => netLookup(comp.id, pinName);
    const emission = componentToSpice(comp, localLookup, { vcc: dominantVcc });
    if (!emission) continue;
    cards.push(...emission.cards);
    for (const m of emission.modelsUsed) modelLines.add(m);
  }

  // ── 5. Board GPIO sources ─────────────────────────────────────────────────
  for (const board of boards) {
    for (const [pinName, state] of Object.entries(board.pins)) {
      if (state.type === 'input') continue; // don't drive the pin
      const net = netLookup(board.id, pinName);
      if (!net) continue;
      if (net === '0' || net === 'vcc_rail') continue; // already served
      const v = state.type === 'digital' ? state.v : state.duty * board.vcc;
      cards.push(`V_${board.id}_${pinName} ${net} 0 DC ${v}`);
    }
  }

  // ── 6. Vcc rail source (if any pin referenced it) ─────────────────────────
  if (hasNet(netNames, 'vcc_rail')) {
    cards.unshift(`V_VCC_RAIL vcc_rail 0 DC ${dominantVcc}`);
  }

  // ── 7. Auto pull-downs for floating nets ─────────────────────────────────
  const floating = detectFloatingNets(netNames, cards);
  for (const net of floating) {
    cards.push(`R_autopull_${net} ${net} 0 100Meg`);
  }

  // ── 8. Compose netlist ────────────────────────────────────────────────────
  const lines: string[] = [`* Velxio circuit @ ${new Date().toISOString()}`];
  lines.push(...cards);
  lines.push(...modelLines);
  lines.push(...extraCards);

  switch (analysis.kind) {
    case 'op':
      lines.push('.op');
      break;
    case 'tran':
      lines.push(`.tran ${analysis.step} ${analysis.stop}`);
      break;
    case 'ac': {
      const kind = analysis.type ?? 'dec';
      const points = analysis.points ?? 20;
      const fstart = analysis.fstart ?? 1;
      const fstop = analysis.fstop ?? 1e6;
      lines.push(`.ac ${kind} ${points} ${fstart} ${fstop}`);
      break;
    }
  }
  lines.push('.end');

  return lines.join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pinsReferencedByWires(componentId: string, wires: WireForSpice[]): string[] {
  const pins = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === componentId) pins.add(w.start.pinName);
    if (w.end.componentId === componentId) pins.add(w.end.pinName);
  }
  return [...pins];
}

function assignDeterministicNetNames(uf: UnionFind): Map<string, string> {
  const reps = [...uf.nets()].sort();
  const out = new Map<string, string>();
  let counter = 0;
  for (const rep of reps) {
    if (rep === '0' || rep === 'vcc_rail') {
      out.set(rep, rep);
    } else {
      // Strip characters ngspice doesn't like from auto-names
      out.set(rep, `n${counter++}`);
    }
  }
  return out;
}

function hasNet(netNames: Map<string, string>, name: string): boolean {
  for (const v of netNames.values()) if (v === name) return true;
  return false;
}

/**
 * Detect nets that lack a DC path to ground.
 *
 * Heuristic: look at the emitted cards. A net is "DC-safe" if it is named "0",
 * or if it appears in the netlist as a terminal of any of:
 *   - a resistor (R...)
 *   - a voltage source (V...)
 *   - a current source (I...)
 *   - an inductor (L... — treated as DC short)
 *   - a switch (S...)
 *   - a behavioral source (B...)
 *   - an MNA-controlled source (E..., G..., F..., H...)
 *   - a subckt instance (X...)
 *
 * Components that don't offer a DC path on their own:
 *   - bare capacitor (C...)
 *   - reverse-biased diode (D...) — conservative: treat as floating unless R/L nearby
 *
 * We actually take a looser approach: any net that has at least one R/L/V/I/S/B/E/X
 * terminal is DC-safe. Otherwise, add a 100 MΩ pull.
 */
function detectFloatingNets(netNames: Map<string, string>, cards: string[]): Set<string> {
  const touched = new Set<string>();
  const nets = new Set(netNames.values());

  for (const line of cards) {
    const prefix = line[0];
    if ('RLVISBEGFHX'.indexOf(prefix) < 0) continue;
    const tokens = line.split(/\s+/);
    // Token 0 is the card name; subsequent tokens up to the value are nets
    for (let i = 1; i < Math.min(tokens.length, 4); i++) {
      const t = tokens[i];
      if (nets.has(t)) touched.add(t);
    }
  }

  const floating = new Set<string>();
  for (const net of nets) {
    if (net === '0' || net === 'vcc_rail') continue;
    if (!touched.has(net)) floating.add(net);
  }
  return floating;
}

/** Re-export types for callers. */
export type { BuildNetlistInput, ComponentForSpice, BoardForSpice, WireForSpice } from './types';

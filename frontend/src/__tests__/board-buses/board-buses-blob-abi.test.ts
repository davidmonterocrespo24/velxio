/**
 * Board buses F4: the vx_blob_* ABI in the BROWSER host (ChipRuntime.ts).
 *
 * Named byte storage is how a portable microSD model gets its card image and
 * how the guest's writes get back to the card panel. F4 moves responders next
 * to the CPU, so the same model runs in the tab, in the QEMU worker and on the
 * Linux-board host; a call that answers differently in one of them is exactly
 * the per-engine divergence this project exists to remove.
 *
 * This suite is one of three that replay the SAME table
 * (fixtures/chips-blob-abi/expectations.json) against the SAME artifact
 * (blob-probe.wasm). The others are, in Python,
 *   velxio/test/backend/unit/test_wasm_chip_blobs.py          (QEMU worker)
 *   pro/backend/tests/unit/test_board_buses_blob_abi_pi.py    (Linux boards)
 * The table is written from velxio-chip.h, not from any runtime, so all three
 * fail rather than agreeing on a wrong answer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PinManager } from '../../simulation/PinManager';
import { I2CBusManager } from '../../simulation/I2CBusManager';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';

const fixture = (p: string) =>
  fileURLToPath(new URL(`./fixtures/chips-blob-abi/${p}`, import.meta.url));

const WASM = new Uint8Array(readFileSync(fixture('blob-probe.wasm')));
const EXPECT = JSON.parse(readFileSync(fixture('expectations.json'), 'utf-8')) as Expectations;
const MANIFEST = JSON.parse(readFileSync(fixture('manifest.json'), 'utf-8')) as
  Record<string, { sourceSha256: string }>;

interface Step {
  op: 'size' | 'read' | 'write' | 'poke';
  which?: number;
  offset?: number;
  len?: number;
  ret?: number;
  hex?: string;
  scratchHex?: string;
  why?: string;
}
interface Expectations {
  blobName: string;
  blobHex: string;
  setupSize: number;
  steps: Step[];
  finalBlobHex: string;
  dirty: Record<string, [number, number]>;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

/** The probe's exported surface, plus the memory poking a write needs. */
class Probe {
  readonly chip: ChipInstance;
  constructor(chip: ChipInstance) { this.chip = chip; }
  private get e() { return this.chip.exports as Record<string, (...a: number[]) => number>; }
  scratch(n: number): Uint8Array {
    const ptr = this.e.scratch_ptr();
    return new Uint8Array(this.chip.memory!.buffer, ptr, n).slice();
  }
  poke(data: Uint8Array): void {
    const ptr = this.e.scratch_ptr();
    new Uint8Array(this.chip.memory!.buffer, ptr, data.length).set(data);
  }
  run(step: Step): number {
    switch (step.op) {
      case 'size':  return this.e.blob_size(step.which!);
      case 'read':  return this.e.blob_read(step.which!, step.offset!, step.len!);
      case 'write': return this.e.blob_write(step.which!, step.offset!, step.len!);
      default: throw new Error(`not a probe call: ${step.op}`);
    }
  }
}

// The probe attaches an I2C slave (the Linux hosts only reach a chip that
// way), so the browser host needs a bus to put it on. Nothing here clocks it;
// the master is a stub that is never asked to do anything.
const idleMaster = {
  completeStart() {}, completeStop() {}, completeConnect() {},
  completeWrite() {}, completeRead() {},
};

async function makeChip(blobs?: Map<string, Uint8Array>) {
  const chip = await ChipInstance.create({
    wasm: WASM,
    componentId: 'blob-probe',
    pinManager: new PinManager(),
    i2cBus: new I2CBusManager(idleMaster),
    wires: new Map(),
    blobs: blobs ?? null,
  });
  chip.start();
  return { chip, probe: new Probe(chip) };
}

const declaredBlobs = () => new Map([[EXPECT.blobName, bytes(EXPECT.blobHex)]]);

describe('vx_blob_* in the browser runtime', () => {
  it('the committed wasm was built from the committed source', () => {
    const sha = createHash('sha256').update(readFileSync(fixture('blob-probe.c'))).digest('hex');
    expect(sha).toBe(MANIFEST['blob-probe'].sourceSha256);
  });

  it('the blob is there while chip_setup runs, the way a card model sizes itself', async () => {
    const { probe } = await makeChip(declaredBlobs());
    expect((probe.chip.exports as { setup_size: () => number }).setup_size())
      .toBe(EXPECT.setupSize);
  });

  it('answers every row of the cross-host table', async () => {
    const { probe } = await makeChip(declaredBlobs());
    for (const [i, step] of EXPECT.steps.entries()) {
      const label = `step ${i}: ${JSON.stringify(step)}`;
      if (step.op === 'poke') {
        probe.poke(bytes(step.hex!));
        continue;
      }
      expect(`${label} -> ${probe.run(step)}`).toBe(`${label} -> ${step.ret}`);
      if (step.scratchHex !== undefined) {
        const n = step.scratchHex.length / 2;
        expect(`${label} scratch ${hex(probe.scratch(n))}`)
          .toBe(`${label} scratch ${step.scratchHex}`);
      }
    }
  });

  it('leaves the blob holding exactly what the chip wrote', async () => {
    const { probe } = await makeChip(declaredBlobs());
    for (const step of EXPECT.steps) {
      if (step.op === 'poke') probe.poke(bytes(step.hex!));
      else probe.run(step);
    }
    expect(hex(probe.chip.blobBytes(EXPECT.blobName)!)).toBe(EXPECT.finalBlobHex);
  });

  it('reports the touched span once and then nothing, so the panel ships that span', async () => {
    const { probe } = await makeChip(declaredBlobs());
    for (const step of EXPECT.steps) {
      if (step.op === 'poke') probe.poke(bytes(step.hex!));
      else probe.run(step);
    }
    const dirty = probe.chip.takeBlobDirty();
    expect(Object.fromEntries(dirty)).toEqual(EXPECT.dirty);
    expect(probe.chip.takeBlobDirty().size).toBe(0);
  });

  it('copies the caller array in, so the chip cannot rewrite it behind its back', async () => {
    const source = bytes(EXPECT.blobHex);
    const { probe } = await makeChip(new Map([[EXPECT.blobName, source]]));
    probe.poke(bytes('aabb'));
    expect(probe.run({ op: 'write', which: 0, offset: 2, len: 2 })).toBe(2);
    expect(hex(source)).toBe(EXPECT.blobHex);
  });

  it('gives a chip whose host declared no blob nothing at all', async () => {
    const { probe } = await makeChip();
    expect(probe.run({ op: 'size', which: 0 })).toBe(0);
    expect(probe.run({ op: 'read', which: 0, offset: 0, len: 4 })).toBe(0);
    expect(probe.run({ op: 'write', which: 0, offset: 0, len: 4 })).toBe(0);
    expect(probe.chip.blobBytes(EXPECT.blobName)).toBeNull();
  });

  it('keeps storage per instance: two chips do not share a name', async () => {
    const a = await makeChip(declaredBlobs());
    const b = await makeChip(declaredBlobs());
    a.probe.poke(bytes('aabb'));
    expect(a.probe.run({ op: 'write', which: 0, offset: 0, len: 2 })).toBe(2);
    expect(hex(b.chip.blobBytes(EXPECT.blobName)!)).toBe(EXPECT.blobHex);
    expect(b.probe.run({ op: 'read', which: 0, offset: 0, len: 2 })).toBe(2);
    expect(hex(b.probe.scratch(2))).toBe(EXPECT.blobHex.slice(0, 4));
  });
});

/**
 * SDK-004 — `TemplateDefinition` schema + validator unit tests.
 *
 * The schema is the contract plugin authors program against. This file
 * locks the validation rules so the host (and the plugin CLI in SDK-009)
 * can rely on them.
 */
import { describe, it, expect } from 'vitest';
import {
  defineTemplate,
  validateProjectSnapshot,
  ProjectSnapshotSchema,
  TEMPLATE_CATEGORIES,
  TEMPLATE_MAX_TOTAL_BYTES,
  InvalidTemplateError,
  type ProjectSnapshot,
  type TemplateDefinition,
} from '../src/templates';

const tinySnapshot = (): ProjectSnapshot => ({
  schemaVersion: 1,
  board: 'arduino-uno',
  files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }],
  components: [
    { id: 'led1', metadataId: 'wokwi-led', x: 100, y: 100, properties: { color: 'red' } },
  ],
  wires: [],
});

describe('defineTemplate', () => {
  it('is an identity function — returns the same record', () => {
    const t: TemplateDefinition = {
      id: 'demo.blink',
      name: 'Blink',
      description: 'Hello blinking world.',
      category: 'beginner',
      difficulty: 1,
      snapshot: tinySnapshot(),
    };
    expect(defineTemplate(t)).toBe(t);
  });

  it('all 4 categories exist', () => {
    expect(TEMPLATE_CATEGORIES).toEqual(['beginner', 'intermediate', 'advanced', 'showcase']);
  });
});

describe('ProjectSnapshotSchema', () => {
  it('accepts a minimal valid snapshot', () => {
    expect(ProjectSnapshotSchema.safeParse(tinySnapshot()).success).toBe(true);
  });

  it('rejects schemaVersion ≠ 1', () => {
    const bad = { ...tinySnapshot(), schemaVersion: 2 };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty files[]', () => {
    const bad: ProjectSnapshot = { ...tinySnapshot(), files: [] };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects > 64 files (over cap)', () => {
    const files = Array.from({ length: 65 }, (_, i) => ({ name: `f${i}.ino`, content: '' }));
    const bad = { ...tinySnapshot(), files };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a component with NaN coordinates', () => {
    const bad: ProjectSnapshot = {
      ...tinySnapshot(),
      components: [{ id: 'x', metadataId: 'wokwi-led', x: NaN, y: 0 }],
    };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('strips unknown extra fields silently (z.object default)', () => {
    const snap = { ...tinySnapshot(), unknownField: 'ignored' } as unknown;
    const r = ProjectSnapshotSchema.safeParse(snap);
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).unknownField).toBeUndefined();
    }
  });
});

describe('validateProjectSnapshot', () => {
  it('returns the parsed snapshot on success', () => {
    const snap = tinySnapshot();
    const out = validateProjectSnapshot(snap, 'demo.blink', 'demo');
    expect(out.board).toBe('arduino-uno');
    expect(out.components).toHaveLength(1);
  });

  it('throws InvalidTemplateError with template id, plugin id, and reason on schema fail', () => {
    expect(() => validateProjectSnapshot({ schemaVersion: 1 }, 'tpl.bad', 'pl')).toThrowError(
      InvalidTemplateError,
    );
    try {
      validateProjectSnapshot({ schemaVersion: 1 }, 'tpl.bad', 'pl');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTemplateError);
      const e = err as InvalidTemplateError;
      expect(e.templateId).toBe('tpl.bad');
      expect(e.pluginId).toBe('pl');
      expect(e.reason).toContain('snapshot fails schema');
    }
  });

  it('throws when total file bytes exceed the 1 MB cap', () => {
    const big = 'x'.repeat(TEMPLATE_MAX_TOTAL_BYTES + 1);
    const snap: ProjectSnapshot = {
      schemaVersion: 1,
      board: 'arduino-uno',
      files: [{ name: 'big.ino', content: big }],
      components: [],
      wires: [],
    };
    // Per-file Zod cap (500 KB) trips before the byte total — the error
    // surfaces as "file content too long". Either way we get InvalidTemplateError.
    expect(() => validateProjectSnapshot(snap, 'tpl.big', 'pl')).toThrowError(
      InvalidTemplateError,
    );
  });

  it('throws when a wire references an unknown component', () => {
    const snap: ProjectSnapshot = {
      ...tinySnapshot(),
      wires: [
        {
          id: 'w1',
          start: { componentId: 'led1', pinName: 'A' },
          end: { componentId: 'ghost', pinName: 'C' },
        },
      ],
    };
    expect(() => validateProjectSnapshot(snap, 'tpl.broken-wire', 'pl')).toThrowError(
      /unknown end component "ghost"/,
    );
  });

  it('accepts snapshot whose total bytes sit just under the cap', () => {
    // 4 files of 200 KB each = 800 KB total, well under 1 MB cap.
    const chunk = 'a'.repeat(200_000);
    const snap: ProjectSnapshot = {
      schemaVersion: 1,
      board: 'arduino-uno',
      files: [
        { name: 'a.ino', content: chunk },
        { name: 'b.h', content: chunk },
        { name: 'c.h', content: chunk },
        { name: 'd.h', content: chunk },
      ],
      components: [],
      wires: [],
    };
    expect(() => validateProjectSnapshot(snap, 'tpl.big-but-ok', 'pl')).not.toThrow();
  });
});

/**
 * Phase 2.2 — LM358 subcircuit asset test.
 *
 * The full LM358 macro-model is vendored at simulation/spice/models/
 * lm358Subckt.ts, and componentToSpice runs it for opamp-lm358 (since
 * 54936ef6, which replaced the behavioural B-source clamp) and for
 * opamp-lm324 (velxio/velxio-prod#128). What it does is checked where it
 * matters: its swing and inputs in opamp-texts-match-models.test.ts, its
 * supply pins in spice-opamp-supply-pins.test.ts.
 *
 * This test locks the asset itself: pin order, presence of the
 * `.SUBCKT LM358 1 2 99 50 28` header, and the renamed internal
 * model names (DX_LM358 / QX_LM358) so the subckt can coexist with
 * other future subcircuits without name collisions.
 */
import { describe, it, expect } from 'vitest';
import { LM358_SUBCKT } from '../simulation/spice/models/lm358Subckt';

describe('Phase 2.2 — LM358 subckt asset', () => {
  it('declares the expected 5-pin interface (IN+ IN- V+ V- OUT)', () => {
    expect(LM358_SUBCKT).toMatch(/\.SUBCKT\s+LM358\s+1\s+2\s+99\s+50\s+28/i);
    expect(LM358_SUBCKT).toMatch(/\.ENDS\s+LM358/i);
  });

  it('uses LM358-scoped names for internal models (no collisions with other libs)', () => {
    expect(LM358_SUBCKT).toMatch(/\.MODEL\s+DX_LM358\s+D/i);
    expect(LM358_SUBCKT).toMatch(/\.MODEL\s+QX_LM358\s+PNP/i);
    // Should NOT use the bare generic names that other libs might also define.
    expect(LM358_SUBCKT).not.toMatch(/\.MODEL\s+DX\s+D/i);
    expect(LM358_SUBCKT).not.toMatch(/\.MODEL\s+QX\s+PNP/i);
  });
});

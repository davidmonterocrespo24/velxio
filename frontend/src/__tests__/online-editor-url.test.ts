/**
 * Where an online-only board card sends a self-hosted user (issue #380).
 *
 * The constant said velxio.com, a parked domain with a registrar placeholder,
 * and every board card marked "available in the online editor" opened it.
 * The hosted editor is velxio.dev, as the README and the rest of the code say.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ONLINE_EDITOR_URL } from '../lib/onlineOnlyBoards';

describe('ONLINE_EDITOR_URL', () => {
  it('is the hosted editor, https on velxio.dev', () => {
    const url = new URL(ONLINE_EDITOR_URL);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('velxio.dev');
  });

  it('nothing the picker shows or links names the parked domain', () => {
    for (const file of ['src/lib/onlineOnlyBoards.ts', 'src/components/ComponentPickerModal.tsx']) {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/velxio\.com/);
    }
  });
});

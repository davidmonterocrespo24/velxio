// @vitest-environment jsdom
/**
 * SHA-256 verification of plugin bundle bytes.
 *
 * crypto.subtle.digest is available in jsdom under Node ≥ 20 via the
 * built-in `crypto.webcrypto` polyfill — no fake needed.
 */
import { describe, expect, it } from 'vitest';

import {
  BundleIntegrityError,
  computeBundleHash,
  verifyBundleHash,
} from '../plugins/loader/BundleVerifier';

const helloHashHex =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'; // SHA-256("hello")
const helloBytes = new TextEncoder().encode('hello');

describe('BundleVerifier', () => {
  it('computes SHA-256 hex of given bytes', async () => {
    const h = await computeBundleHash(helloBytes);
    expect(h).toBe(helloHashHex);
  });

  it('accepts ArrayBuffer as well as Uint8Array', async () => {
    const buf = helloBytes.buffer.slice(
      helloBytes.byteOffset,
      helloBytes.byteOffset + helloBytes.byteLength,
    );
    const h = await computeBundleHash(buf);
    expect(h).toBe(helloHashHex);
  });

  it('verifyBundleHash returns the actual hash on success', async () => {
    const h = await verifyBundleHash(helloBytes, helloHashHex);
    expect(h).toBe(helloHashHex);
  });

  it('verifyBundleHash is case-insensitive on the expected value', async () => {
    const h = await verifyBundleHash(helloBytes, helloHashHex.toUpperCase());
    expect(h).toBe(helloHashHex);
  });

  it('throws BundleIntegrityError on mismatch', async () => {
    await expect(
      verifyBundleHash(helloBytes, '0000000000000000000000000000000000000000000000000000000000000000'),
    ).rejects.toBeInstanceOf(BundleIntegrityError);
  });

  it('mismatch error carries pluginId when provided', async () => {
    try {
      await verifyBundleHash(helloBytes, 'aa', 'my.plugin');
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(BundleIntegrityError);
      const e = err as BundleIntegrityError;
      expect(e.pluginId).toBe('my.plugin');
      expect(e.message).toContain('my.plugin');
      expect(e.message).toContain(helloHashHex);
    }
  });
});

/**
 * Canonical JSON encoding used as the signing input for licenses.
 *
 * The signing party (Pro) and the verifying party (Core) MUST produce
 * exactly the same byte sequence for the payload — otherwise Ed25519
 * verification fails on a perfectly legitimate license. Plain
 * `JSON.stringify` is order-dependent because object key insertion
 * order leaks into the output, so we normalize:
 *
 *   - Object keys sorted lexicographically.
 *   - Arrays preserved in their declared order.
 *   - `undefined` properties omitted (matching `JSON.stringify`).
 *   - Numbers / strings / booleans / null encoded the same way as
 *     `JSON.stringify`.
 *
 * This is a strict subset of RFC 8785 (JSON Canonicalization Scheme):
 * we do not need fractional-number normalization because licenses
 * carry no floats. Documenting that constraint explicitly so PRO-007
 * doesn't need a full RFC 8785 lib.
 */

export function canonicalJsonStringify(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJsonStringify: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + stringify(obj[k]));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(`canonicalJsonStringify: unsupported type ${typeof value}`);
}

export function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

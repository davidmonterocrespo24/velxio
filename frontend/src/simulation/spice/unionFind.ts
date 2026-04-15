/**
 * Minimal Union-Find (disjoint set) with a `setCanonical()` extension:
 *
 *   uf.add(key)
 *   uf.union(a, b)
 *   uf.find(key) → representative string
 *   uf.setCanonical(key, name)  — pin the representative of key's component
 *                                  to an explicit name (e.g. "0" for ground)
 *
 * Used by the NetlistBuilder to collapse wired pins into named nets.
 */
export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();
  private canonical = new Map<string, string>(); // key → forced name

  add(key: string): void {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
      this.rank.set(key, 0);
    }
  }

  find(key: string): string {
    this.add(key);
    while (this.parent.get(key) !== key) {
      const p = this.parent.get(key)!;
      this.parent.set(key, this.parent.get(p)!);
      key = this.parent.get(key)!;
    }
    // If this representative has a forced canonical name, return that instead.
    const canon = this.canonical.get(key);
    return canon ?? key;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.findRoot(a);
    const rb = this.findRoot(b);
    if (ra === rb) return;

    // If either root has a canonical name, the other adopts it.
    const canonA = this.canonical.get(ra);
    const canonB = this.canonical.get(rb);

    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    let newRoot: string;
    let oldRoot: string;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
      newRoot = rb;
      oldRoot = ra;
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
      newRoot = ra;
      oldRoot = rb;
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
      newRoot = ra;
      oldRoot = rb;
    }

    // Propagate canonical name: whichever side had one wins. If both had
    // different canonical names, the numerically-smaller / ground wins to
    // guarantee determinism (gnd = "0").
    const merged = pickCanonical(canonA, canonB);
    if (merged !== undefined) this.canonical.set(newRoot, merged);
    this.canonical.delete(oldRoot);
  }

  /**
   * Force the set containing `key` to report `name` as its representative.
   * Called e.g. with "0" for ground, "vcc_rail" for supply rails.
   */
  setCanonical(key: string, name: string): void {
    this.add(key);
    const root = this.findRoot(key);
    const prev = this.canonical.get(root);
    this.canonical.set(root, prev !== undefined ? pickCanonical(prev, name)! : name);
  }

  has(key: string): boolean {
    return this.parent.has(key);
  }

  /** Iterate every (key, representative) pair. */
  *entries(): IterableIterator<[string, string]> {
    for (const key of this.parent.keys()) {
      yield [key, this.find(key)];
    }
  }

  /** All distinct representatives (nets). */
  nets(): Set<string> {
    const s = new Set<string>();
    for (const key of this.parent.keys()) s.add(this.find(key));
    return s;
  }

  private findRoot(key: string): string {
    while (this.parent.get(key) !== key) {
      const p = this.parent.get(key)!;
      this.parent.set(key, this.parent.get(p)!);
      key = this.parent.get(key)!;
    }
    return key;
  }
}

/** Ground ("0") always wins over vcc; vcc over auto-named. Deterministic pick. */
function pickCanonical(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === b) return a;
  if (a === '0') return a;
  if (b === '0') return b;
  if (a.startsWith('vcc')) return a;
  if (b.startsWith('vcc')) return b;
  // Lexicographically smaller wins (stable)
  return a < b ? a : b;
}

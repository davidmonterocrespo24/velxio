/**
 * Plugin-contributed SPICE `.model` cards.
 *
 * The built-in SPICE mappers ship their own `.model` strings inline in each
 * mapper's `modelsUsed` set, so the NetlistBuilder picks them up
 * automatically. Plugins that need a custom diode/BJT can register the
 * `.model` card here and reference it by name from their mapper. The
 * NetlistBuilder concatenates this registry with the inline-discovered set
 * before emitting the netlist.
 *
 * Wiring the NetlistBuilder side is left to a follow-up — the registry is
 * the contract surface; the wiring is mechanical.
 */

export interface SpiceModelHandle {
  dispose(): void;
}

export class SpiceModelRegistry {
  private readonly models = new Map<string, string>();

  /** Register a `.model NAME ...` card. Last-writer-wins. */
  register(name: string, card: string): SpiceModelHandle {
    const previous = this.models.get(name);
    this.models.set(name, card);
    return {
      dispose: () => {
        if (this.models.get(name) !== card) return;
        if (previous === undefined) {
          this.models.delete(name);
        } else {
          this.models.set(name, previous);
        }
      },
    };
  }

  get(name: string): string | undefined {
    return this.models.get(name);
  }

  /** Sorted snapshot of every registered card. */
  cards(): ReadonlyArray<string> {
    return [...this.models.values()].sort();
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  size(): number {
    return this.models.size;
  }

  __clearForTests(): void {
    this.models.clear();
  }
}

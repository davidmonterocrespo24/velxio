/**
 * Component Registry
 *
 * Singleton service that loads and provides access to component metadata.
 * Loads from components-metadata.json generated at build time.
 */

import { prepareSearchFields, rankBySearch, type PreparedSearchFields } from '../utils/searchMatch';
import { componentSearchKeywords } from '../data/componentSearchKeywords';
import type {
  ComponentMetadata,
  ComponentCategory,
  ComponentMetadataCollection,
} from '../types/component-metadata';

export class ComponentRegistry {
  private static instance: ComponentRegistry;
  private metadata: Map<string, ComponentMetadata> = new Map();
  private categories: Map<ComponentCategory, ComponentMetadata[]> = new Map();
  private allComponents: ComponentMetadata[] = [];
  private loaded = false;
  private _loadPromise: Promise<void> | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ComponentRegistry {
    if (!ComponentRegistry.instance) {
      ComponentRegistry.instance = new ComponentRegistry();
    }
    return ComponentRegistry.instance;
  }

  /**
   * Load metadata from JSON file
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad();
    return this._loadPromise;
  }

  /**
   * Returns the load promise so consumers can await registry readiness
   */
  get loadPromise(): Promise<void> {
    return this._loadPromise ?? this.load();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  private async _doLoad(): Promise<void> {
    try {
      // `cache: 'no-store'` so adding a new component (or rebuilding the JSON)
      // shows up after a single page refresh — without this, the browser keeps
      // serving the stale copy until you do a hard reload.
      const response = await fetch('/components-metadata.json', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to load metadata: ${response.statusText}`);
      }

      const data: ComponentMetadataCollection = await response.json();

      // Inject Raspberry Pi 3 / 4 / 5 metadata. All three share the
      // same 40-pin GPIO header; the simulator backend picks a
      // different QEMU CPU model per board (Cortex-A53/A72/A76).
      data.components.push({
        id: 'raspberry-pi-zero',
        tagName: 'velxio-raspberry-pi-3',   // reuse 40-pin board art
        name: 'Raspberry Pi Zero',
        category: 'boards',
        description: 'Raspberry Pi Zero with 40-pin GPIO. QEMU virt + Cortex-A7 (armhf) backend; presents the Pi Zero memory/SMP profile (1 core, 512 MB).',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#7E2553" rx="4"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="9" fill="#FFF">RPi0</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 40,
        tags: ['raspberry', 'pi', 'pi-zero', 'board', 'qemu', 'linux'],
      });
      data.components.push({
        id: 'raspberry-pi-1',
        tagName: 'velxio-raspberry-pi-3',   // reuse 40-pin board art
        name: 'Raspberry Pi 1',
        category: 'boards',
        description: 'Raspberry Pi 1 Model B+ with 40-pin GPIO. QEMU virt + Cortex-A7 (armhf) backend; 1 core / 512 MB profile.',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#A8324B" rx="4"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="9" fill="#FFF">RPi1</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 40,
        tags: ['raspberry', 'pi', 'rp1', 'board', 'qemu', 'linux'],
      });
      data.components.push({
        id: 'raspberry-pi-2',
        tagName: 'velxio-raspberry-pi-3',
        name: 'Raspberry Pi 2',
        category: 'boards',
        description: 'Raspberry Pi 2 Model B with 40-pin GPIO. QEMU virt + Cortex-A7 (armhf) backend; 4 cores / 1 GB.',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#C73E5A" rx="4"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="9" fill="#FFF">RPi2</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 40,
        tags: ['raspberry', 'pi', 'rp2', 'board', 'qemu', 'linux'],
      });
      data.components.push({
        id: 'raspberry-pi-3',
        tagName: 'velxio-raspberry-pi-3',
        name: 'Raspberry Pi 3',
        category: 'boards',
        description: 'Raspberry Pi 3 Model B with 40-pin GPIO. QEMU virt + Cortex-A53 backend.',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#E60049" rx="4"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10" fill="#FFF">RPi3</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 40,
        tags: ['raspberry', 'pi', 'rp3', 'board', 'qemu', 'linux'],
      });
      data.components.push({
        id: 'raspberry-pi-4',
        tagName: 'velxio-raspberry-pi-4',
        name: 'Raspberry Pi 4',
        category: 'boards',
        description: 'Raspberry Pi 4 Model B with 40-pin GPIO. QEMU virt + Cortex-A72 backend.',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#006633" rx="4"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10" fill="#FFF">RPi4</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 40,
        tags: ['raspberry', 'pi', 'rp4', 'board', 'qemu', 'linux'],
      });
      data.components.push({
        id: 'raspberry-pi-5',
        tagName: 'velxio-raspberry-pi-5',
        name: 'Raspberry Pi 5',
        category: 'boards',
        description: 'Raspberry Pi 5 with 40-pin GPIO + RP1 southbridge. QEMU virt + Cortex-A76 backend.',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#004d27" rx="4"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10" fill="#FFF">RPi5</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 40,
        tags: ['raspberry', 'pi', 'rp5', 'board', 'qemu', 'linux'],
      });

      // Inject SPICE probe instruments — these are Velxio-specific React
      // components (not wokwi web elements), so they have no auto-generated
      // metadata but still need a registry entry so the picker can offer
      // them and the canvas can resolve them by id.
      data.components.push({
        id: 'instr-voltmeter',
        tagName: 'velxio-instr-voltmeter',
        name: 'Voltmeter',
        category: 'analog',
        description:
          'SPICE probe — displays the voltage between V+ and V-. Used in electrical-mode circuits.',
        thumbnail:
          '<svg width="64" height="64" viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="16" width="5" height="9" rx="1.5" fill="#c0392b" stroke="#14181c"/><rect x="0.5" y="28" width="5" height="9" rx="1.5" fill="#4b5158" stroke="#14181c"/><rect x="4.5" y="6.5" width="55" height="39" rx="5" fill="#24282e" stroke="#3b424a"/><text x="9" y="16" font-family="monospace" font-size="6" letter-spacing="1" fill="#8d959d">DC V</text><circle cx="55" cy="13.5" r="2.2" fill="#ffa726"/><rect x="8" y="20" width="48" height="19" rx="3" fill="#0c1013" stroke="#2a3138"/><text x="32" y="33" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#ffa726">3.30 V</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 2,
        tags: ['voltmeter', 'meter', 'probe', 'instrument', 'spice', 'multimeter', 'dmm'],
      });
      data.components.push({
        id: 'instr-ammeter',
        tagName: 'velxio-instr-ammeter',
        name: 'Ammeter',
        category: 'analog',
        description:
          'SPICE probe — measures the current through its body (connect in series). Used in electrical-mode circuits.',
        thumbnail:
          '<svg width="64" height="64" viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="21.5" width="5" height="9" rx="1.5" fill="#c0392b" stroke="#14181c"/><rect x="58.5" y="21.5" width="5" height="9" rx="1.5" fill="#4b5158" stroke="#14181c"/><rect x="4.5" y="6.5" width="55" height="39" rx="5" fill="#24282e" stroke="#3b424a"/><text x="9" y="16" font-family="monospace" font-size="6" letter-spacing="1" fill="#8d959d">DC A</text><circle cx="55" cy="13.5" r="2.2" fill="#4dd0e1"/><rect x="8" y="20" width="48" height="19" rx="3" fill="#0c1013" stroke="#2a3138"/><text x="32" y="33" text-anchor="middle" font-family="monospace" font-size="9" font-weight="bold" fill="#4dd0e1">12.4 mA</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 2,
        tags: ['ammeter', 'meter', 'probe', 'instrument', 'spice', 'current', 'multimeter', 'dmm'],
      });

      // Custom Chip — user-supplied WASM compiled from C. Pin layout is
      // dynamic (read from the per-instance chip.json properties), so
      // pinCount=0 is just a placeholder for the picker grid.
      data.components.push({
        id: 'custom-chip',
        tagName: 'velxio-custom-chip',
        name: 'Custom Chip',
        category: 'logic',
        description:
          'Write your own chip in C and compile to WebAssembly. Includes a gallery of examples (EEPROM, RTC, shift register, ADC, UART, …).',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="14" width="52" height="36" rx="3" fill="#1a1a1a" stroke="#888" stroke-width="2"/><rect x="2" y="20" width="6" height="3" fill="#c0c0c0"/><rect x="2" y="28" width="6" height="3" fill="#c0c0c0"/><rect x="2" y="36" width="6" height="3" fill="#c0c0c0"/><rect x="2" y="44" width="6" height="3" fill="#c0c0c0"/><rect x="56" y="20" width="6" height="3" fill="#c0c0c0"/><rect x="56" y="28" width="6" height="3" fill="#c0c0c0"/><rect x="56" y="36" width="6" height="3" fill="#c0c0c0"/><rect x="56" y="44" width="6" height="3" fill="#c0c0c0"/><text x="32" y="36" text-anchor="middle" font-family="monospace" font-size="9" font-weight="bold" fill="#e0e0e0">CHIP</text></svg>',
        properties: [
          { name: 'chipName',   type: 'string', defaultValue: 'My Chip' },
          { name: 'sourceC',    type: 'string', defaultValue: '' },
          { name: 'chipJson',   type: 'string', defaultValue: '{"name":"My Chip","pins":["IN","OUT","GND","VCC"]}' },
          { name: 'wasmBase64', type: 'string', defaultValue: '' },
          // For CPU-emulator chips that load their program from a project file
          // (.s / .asm / .hex / .bin). Compile-rom populates romBytes; the chip
          // reads it on chip_setup via vx_rom_size / vx_rom_read.
          { name: 'romBytes',    type: 'string', defaultValue: '' },
          { name: 'programFile', type: 'string', defaultValue: '' },
          { name: 'programTarget', type: 'string', defaultValue: '' },
          // Optional face image (a data: URL). Projected into the chip's
          // file section as chip.png / chip.jpg / chip.svg by chipFiles.ts.
          { name: 'image', type: 'string', defaultValue: '' },
        ],
        defaultValues: {
          chipName: 'My Chip',
          sourceC: '',
          chipJson: '{"name":"My Chip","pins":["IN","OUT","GND","VCC"]}',
          wasmBase64: '',
          romBytes: '',
          programFile: '',
          programTarget: '',
          image: '',
        },
        pinCount: 0,
        tags: ['custom', 'chip', 'wasm', 'c', 'wokwi', 'eeprom', 'rtc', 'logic', 'cpu', '8080', 'z80'],
      });

      this.processMetadata(data.components);
      this.loaded = true;

      console.log(`Loaded ${this.allComponents.length} components from metadata`);
    } catch (error) {
      console.error('Failed to load component metadata:', error);
      // Continue with empty registry - app should still work with manual component addition
    }
  }

  /**
   * Process and index metadata
   */
  private processMetadata(components: ComponentMetadata[]): void {
    // Featured (everyday) parts — e.g. breadboards — surface first in the
    // picker. Array.prototype.sort is stable, so the metadata-file order is
    // preserved within the featured and non-featured groups.
    this.allComponents = [...components].sort(
      (a, b) => Number(!!b.featured) - Number(!!a.featured),
    );
    this.metadata.clear();
    this.categories.clear();

    // Index by ID. Iterate the sorted list so the per-category groups keep
    // featured components first too.
    this.allComponents.forEach((component) => {
      this.metadata.set(component.id, component);

      // Group by category
      const categoryComponents = this.categories.get(component.category) || [];
      categoryComponents.push(component);
      this.categories.set(component.category, categoryComponents);
    });
  }

  /**
   * Get all components
   */
  getAllComponents(): ComponentMetadata[] {
    return [...this.allComponents];
  }

  /**
   * Merge additional components into the registry from an external source.
   *
   * Used by private overlays (e.g. the velxio.dev pro overlay) to add
   * premium components after the default `/components-metadata.json` has
   * loaded. Components with an existing `id` are replaced; new ones are
   * appended. Categories and search index are rebuilt.
   */
  mergeComponents(extras: ComponentMetadata[]): void {
    if (!extras || extras.length === 0) return;
    const byId = new Map(this.allComponents.map((c) => [c.id, c]));
    for (const extra of extras) {
      byId.set(extra.id, extra);
    }
    this.processMetadata(Array.from(byId.values()));
    // The overlay merges AFTER its dynamic import lands - notify subscribers so
    // an already-open picker recomputes (ONLINE ad cards vs real components).
    this._version++;
    for (const l of this._changeListeners) l();
  }

  /**
   * Remove previously merged components by id. Counterpart of
   * mergeComponents for sources whose entries can disappear at runtime
   * (e.g. an overlay library the user deletes from). Ids not present are
   * ignored; no-op calls don't bump the version.
   */
  removeComponents(ids: string[]): void {
    if (!ids || ids.length === 0) return;
    const drop = new Set(ids);
    const kept = this.allComponents.filter((c) => !drop.has(c.id));
    if (kept.length === this.allComponents.length) return;
    this.processMetadata(kept);
    this._version++;
    for (const l of this._changeListeners) l();
  }

  private _version = 0;
  private _changeListeners = new Set<() => void>();

  /** Monotonic counter bumped on every mergeComponents() - pair with subscribe
   *  in useSyncExternalStore so late overlay merges re-render consumers. */
  getVersion = (): number => this._version;

  subscribe = (cb: () => void): (() => void) => {
    this._changeListeners.add(cb);
    return () => this._changeListeners.delete(cb);
  };

  /**
   * Get components by category
   */
  getByCategory(category: ComponentCategory): ComponentMetadata[] {
    return this.categories.get(category) || [];
  }

  /**
   * Get component by ID
   */
  getById(id: string): ComponentMetadata | undefined {
    const hit = this.metadata.get(id);
    if (hit) return hit;
    // Brand-prefix fallback: gallery templates and older agent-loaded
    // projects store element tag names ("wokwi-lcd2004") where the registry
    // keys by the bare id ("lcd2004"). Without this, such a component sits
    // in the store, gets saved and wired — but never renders, so the user
    // sees a circuit whose display simply does not exist on screen.
    const bare = id.replace(/^(wokwi|velxio)-/, '');
    return bare !== id ? this.metadata.get(bare) : undefined;
  }

  /**
   * Search components by query, best match first.
   *
   * Every word of the query must land somewhere in the part's name, id,
   * tags, search keywords, category or description; words can be partial
   * ("temp"), misspelled ("potenciometer"), in another language
   * ("temperatura") or spaced differently ("hc sr04"). See utils/searchMatch.
   * A blank query returns the catalogue in browsing order.
   */
  search(query: string): ComponentMetadata[] {
    return rankBySearch(this.allComponents, query, (c) => this.searchFieldsOf(c));
  }

  /** Normalised once per metadata object; mergeComponents() replaces the
   *  objects it touches, so a stale entry can never be served. */
  private _searchFields = new WeakMap<ComponentMetadata, PreparedSearchFields>();

  private searchFieldsOf(component: ComponentMetadata): PreparedSearchFields {
    const hit = this._searchFields.get(component);
    if (hit) return hit;
    const prepared = prepareSearchFields([
      { text: component.name, weight: 3 },
      { text: component.id, weight: 2.5 },
      { text: component.tags.join(' '), weight: 2.5 },
      {
        text: [componentSearchKeywords(component.id), ...(component.keywords ?? [])].join(' '),
        weight: 2,
      },
      {
        text: `${component.category} ${ComponentRegistry.getCategoryDisplayName(component.category)}`,
        weight: 1,
      },
      { text: component.description ?? '', weight: 1 },
    ]);
    this._searchFields.set(component, prepared);
    return prepared;
  }

  /**
   * Get all available categories
   */
  getCategories(): ComponentCategory[] {
    return Array.from(this.categories.keys());
  }

  /**
   * Reload metadata (for hot-reload in dev mode)
   */
  async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  /**
   * Get component count
   */
  getComponentCount(): number {
    return this.allComponents.length;
  }

  /**
   * Get category display name
   */
  static getCategoryDisplayName(category: ComponentCategory): string {
    const displayNames: Record<ComponentCategory, string> = {
      boards: 'Boards',
      sensors: 'Sensors',
      displays: 'Displays',
      input: 'Input',
      output: 'Output',
      motors: 'Motors',
      communication: 'Communication',
      connectivity: 'Connectivity',
      passive: 'Passive',
      logic: 'Logic Gates',
      analog: 'Analog',
      electromech: 'Electromechanical',
      other: 'Other',
    };
    return displayNames[category] || category;
  }
}

// Auto-load on module import
const registry = ComponentRegistry.getInstance();
registry.load();

export default registry;

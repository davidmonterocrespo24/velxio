/**
 * Component Registry
 *
 * Singleton service that loads and provides access to component metadata.
 * Loads from components-metadata.json generated at build time.
 */

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

      // Inject Raspberry Pi 3 metadata
      data.components.push({
        id: 'raspberry-pi-3',
        tagName: 'velxio-raspberry-pi-3',
        name: 'Raspberry Pi 3',
        category: 'boards',
        description: 'Raspberry Pi 3 Model B with 40-pin GPIO. Connects to backend QEMU simulator.',
        thumbnail:
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#E60049" rx="4"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10" fill="#FFF">RPi3</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 40,
        tags: ['raspberry', 'pi', 'rp3', 'board', 'qemu', 'linux'],
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
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="6" fill="#1f1f1f" stroke="#ffa500" stroke-width="2"/><text x="50%" y="42%" text-anchor="middle" font-family="monospace" font-size="9" fill="#ffa500">V METER</text><text x="50%" y="68%" text-anchor="middle" font-family="monospace" font-size="11" fill="#ffa500" font-weight="bold">3.30 V</text></svg>',
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
          '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="6" fill="#1f1f1f" stroke="#4dd0e1" stroke-width="2"/><text x="50%" y="42%" text-anchor="middle" font-family="monospace" font-size="9" fill="#4dd0e1">A METER</text><text x="50%" y="68%" text-anchor="middle" font-family="monospace" font-size="11" fill="#4dd0e1" font-weight="bold">12.4 mA</text></svg>',
        properties: [],
        defaultValues: {},
        pinCount: 2,
        tags: ['ammeter', 'meter', 'probe', 'instrument', 'spice', 'current', 'multimeter', 'dmm'],
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
    this.allComponents = components;
    this.metadata.clear();
    this.categories.clear();

    // Index by ID
    components.forEach((component) => {
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
   * Get components by category
   */
  getByCategory(category: ComponentCategory): ComponentMetadata[] {
    return this.categories.get(category) || [];
  }

  /**
   * Get component by ID
   */
  getById(id: string): ComponentMetadata | undefined {
    return this.metadata.get(id);
  }

  /**
   * Search components by query (name, description, tags)
   */
  search(query: string): ComponentMetadata[] {
    if (!query.trim()) {
      return this.getAllComponents();
    }

    const lowerQuery = query.toLowerCase();
    return this.allComponents.filter((component) => {
      return (
        component.name.toLowerCase().includes(lowerQuery) ||
        component.id.toLowerCase().includes(lowerQuery) ||
        component.description?.toLowerCase().includes(lowerQuery) ||
        component.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
      );
    });
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

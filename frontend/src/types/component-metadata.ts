/**
 * Component Metadata Types
 *
 * Defines the structure for dynamically loaded component metadata
 * from the wokwi-elements repository.
 */

export type ComponentCategory =
  | 'boards'
  | 'sensors'
  | 'displays'
  | 'input'
  | 'output'
  | 'motors'
  | 'communication'
  | 'connectivity'
  | 'passive'
  | 'logic'
  | 'analog'
  | 'electromech'
  | 'other';

export interface PropertyDescriptor {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'color' | 'select';
  defaultValue: any;
  options?: string[];
  min?: number;
  max?: number;
  control?: 'text' | 'range' | 'color' | 'boolean' | 'select';
  description?: string;
}

/**
 * A transistor's absolute maximum ratings, from its datasheet, which `source`
 * cites (velxio/velxio-prod#138). The circuit check before Run and the
 * runtime monitor while it runs compare what the circuit does to the part
 * against them. Magnitudes: `kind` says which way the part blocks.
 */
export interface PartRatings {
  /**
   * A bipolar transistor (pins C, B, E) or a MOSFET (pins D, G, S), and its
   * polarity: an NPN blocks with its collector above its emitter, a PNP
   * below, an N-channel MOSFET with its drain above its source, a P-channel
   * below.
   */
  kind: 'npn' | 'pnp' | 'nmos' | 'pmos';
  /** V_CEO (bipolar) or V_DSS (MOSFET): the most it blocks, V. */
  vMax: number;
  /** I_C or I_D, continuous, A. */
  iMax: number;
  /** I_CM or I_DM, the peak (pulsed) current, when the datasheet gives one, A. */
  iPulse?: number;
  /** P_D in free air at 25 °C, with no heatsink, W. */
  pMax: number;
  /**
   * P_D at a case temperature of 25 °C, W: what a part made for a heatsink
   * (TO-220, TO-3) takes when its `heatsink` property says it is on one.
   */
  pMaxHeatsink?: number;
  /** The datasheet (maker, document, revision) the figures come from. */
  source: string;
}

export interface ComponentMetadata {
  id: string; // "led", "dht22", "arduino-uno"
  tagName: string; // "wokwi-led", "wokwi-dht22"
  name: string; // "LED", "DHT22 Sensor"
  category: ComponentCategory; // "sensors", "displays", etc.
  description?: string;
  thumbnail: string; // SVG inline or path
  properties: PropertyDescriptor[];
  defaultValues: Record<string, any>;
  pinCount: number;
  tags: string[]; // For search functionality
  // Search-only words never shown in the UI ("temperature humidity" on a
  // DHT22). The OSS catalogue keeps its list in data/componentSearchKeywords.ts;
  // overlay parts can ship theirs here. Merged with tags at search time.
  keywords?: string[];
  // Optional flag set by private overlays (e.g. velxio.dev) to mark a
  // component as gated behind a paid subscription. The OSS image never
  // sets this — self-hosters have everything unlocked. The picker can
  // delegate the click on a pro_only component to a window-level gate
  // (see ComponentPickerModal) which the overlay implements.
  pro_only?: boolean;
  // Everyday parts (e.g. breadboards) surface at the top of the picker:
  // ComponentRegistry sorts featured components first after loading the
  // metadata, keeping the original order within each group.
  featured?: boolean;
  // The part carries a microSD/TF slot of its own (e.g. the Seeed Round
  // Display shield). The property dialog shows the same "SD Card" upload
  // panel the standalone microsd-card gets, and the part's simulation reads
  // `properties.sdFiles` when it builds the card image. Without this flag a
  // built-in slot exists electrically but there is no way to put files on it.
  sdSlot?: boolean;
  // A component saved by THIS user (a saved custom chip from their My Chips
  // library, merged into the registry by the overlay). Renders a CUSTOM pill
  // on the picker card / hover panel / part inspector. Never set by OSS.
  custom?: boolean;
  // A transistor's datasheet ratings (PartRatings), which the circuit check
  // and the runtime monitor hold it to.
  ratings?: PartRatings;
}

export interface ComponentMetadataCollection {
  version: string;
  generatedAt?: string;
  components: ComponentMetadata[];
}

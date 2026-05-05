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
  // Optional flag set by private overlays (e.g. velxio.dev) to mark a
  // component as gated behind a paid subscription. The OSS image never
  // sets this — self-hosters have everything unlocked. The picker can
  // delegate the click on a pro_only component to a window-level gate
  // (see ComponentPickerModal) which the overlay implements.
  pro_only?: boolean;
}

export interface ComponentMetadataCollection {
  version: string;
  generatedAt?: string;
  components: ComponentMetadata[];
}

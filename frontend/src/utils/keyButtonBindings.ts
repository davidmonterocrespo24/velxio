/**
 * Keyboard-to-button bindings.
 *
 * Any pushbutton on the canvas can be mapped to a keyboard key via the
 * component property dialog. The mapping is stored as the component's
 * `key` property (so it persists inside components_json / .vlx exports)
 * and is consumed at runtime by `useButtonKeyBindings`, which translates
 * keydown/keyup into the same `button-press` / `button-release` DOM
 * events the mouse fires on the wokwi element — every simulation path
 * (avr8js, SPICE-driven inputs, the QEMU GPIO bridge) already listens to
 * those events, so keyboard presses behave exactly like mouse presses.
 */

/** Structural subset of the canvas component shape this module needs. */
interface BindableComponent {
  id: string;
  metadataId: string;
  properties: Record<string, unknown>;
}

/** Component metadata ids that support a keyboard binding. */
const KEY_BINDABLE = new Set(['pushbutton', 'pushbutton-6mm']);

export function isKeyBindable(metadataId: string): boolean {
  return KEY_BINDABLE.has(metadataId);
}

/**
 * Canonical form of a KeyboardEvent.key for storing and matching.
 * Single characters are case-folded so a mapping made with CapsLock on
 * (or matched while Shift is held) still works; named keys ("ArrowUp",
 * "Enter", " ") are kept verbatim.
 */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Compact human label for a stored key (keycap badge / dialog chip). */
export function formatKeyLabel(key: string): string {
  switch (key) {
    case ' ':
      return 'Space';
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/** Modifier and lock keys can't be bound on their own. */
export function isModifierKey(key: string): boolean {
  return ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'].includes(key);
}

/**
 * normalized key → component ids bound to it. Several buttons may share
 * one key on purpose (e.g. one physical key closing two parallel
 * branches), so the value is a list.
 */
export function buildKeyBindingMap(
  components: BindableComponent[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of components) {
    const key = c.properties?.key;
    if (!isKeyBindable(c.metadataId) || typeof key !== 'string' || !key) continue;
    const norm = normalizeKey(key);
    const list = map.get(norm);
    if (list) list.push(c.id);
    else map.set(norm, [c.id]);
  }
  return map;
}

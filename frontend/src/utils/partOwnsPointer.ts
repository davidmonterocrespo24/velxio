/**
 * Which canvas parts handle their own mouse presses while the simulation runs.
 *
 * Every part on the canvas sits in a DynamicComponent wrapper that catches
 * mousedown in the CAPTURE phase, so it can start a drag or open the property
 * dialog. Catching it there and stopping it means the event never reaches the
 * element's shadow DOM. For a part whose own SVG handlers ARE the interaction
 * (a knob, a pushbutton, a keypad, a remote's keys) that silently kills it: the
 * part looks alive, the press does nothing, and nothing is logged anywhere.
 *
 * The tags listed here are let through while the simulation runs. The list is
 * tight on purpose: a part that has `attachEvents` but no pointer handler of
 * its own (a DHT22, an LED, a display) must keep the wrapper's behaviour, or
 * its sensor panel and property dialog stop opening.
 *
 * `__tests__/part-owns-pointer.test.ts` scans @wokwi/elements for every
 * element that binds its own mouse, pointer or touch handler and fails when
 * one is missing here. That is how `wokwi-ir-remote` was found: its keys
 * never fired `button-press`, so a gallery example whose whole point is
 * pressing them did nothing.
 */
export const OWN_POINTER_TAGS: ReadonlySet<string> = new Set([
  'wokwi-pushbutton',
  'wokwi-pushbutton-6mm',
  'wokwi-potentiometer',
  'wokwi-slide-potentiometer',
  'wokwi-slide-switch',
  'wokwi-dip-switch-8',
  'wokwi-analog-joystick',
  'wokwi-ky-040',
  'wokwi-membrane-keypad',
  'wokwi-rotary-dialer',
  'wokwi-ir-remote',
]);

/** True when a mousedown on this tag belongs to the element, not the canvas. */
export function tagOwnsPointer(tag: string): boolean {
  return OWN_POINTER_TAGS.has(tag.toLowerCase());
}

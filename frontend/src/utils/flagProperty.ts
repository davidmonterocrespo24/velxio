/**
 * An on/off property of a part (a pushbutton's `pressed`), read the one way
 * the canvas and the circuit both use.
 *
 * The property reaches the parts as a real boolean when the simulation
 * writes it (a click on the button), and as text when a person or a tool
 * does: the part inspector stores what is typed, an imported project or the
 * agent's set_property may store "false". Text is on only when it says
 * "true" or "1", which is how DynamicComponent hands it to the element that
 * draws the part. Anything else that is not text keeps its truthiness, as the
 * element reads it.
 *
 * The circuit used to read the same field with Boolean(), and Boolean("false")
 * is true: a button the canvas drew released closed its switch in the solve,
 * and the sketch read it pressed (velxio/velxio-prod#151).
 */
export function flagProperty(value: unknown): boolean {
  if (typeof value === 'string') return value === 'true' || value === '1';
  return Boolean(value);
}

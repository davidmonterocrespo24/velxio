/**
 * sensorModels — the one declaration of the sensors whose MODEL drives the line.
 *
 * A handful of parts are not in the SPICE netlist and are not driven by the
 * host either: the sensor's own model owns the wire for the whole exchange. An
 * HC-SR04 answers a trigger with a timed ECHO pulse; a DHT22 bit-bangs a
 * 40-bit frame on its DATA line. Whoever emulates that model — the backend
 * QEMU worker, or an in-browser engine's sensor hub — is the only thing
 * allowed to move those pads, and every other layer has to stand down.
 *
 * That fact used to be written down in several places at once: a set of type
 * names in the ESP32 bridge, a union type and a pair of `if (type === ...)`
 * branches in the overlay's hub, and a wiring map in the store. Nothing tied
 * them together, so adding a third single-wire sensor meant finding all of
 * them, and missing one was silent — exactly the failure that cost an HC-SR04
 * its echo pin. This module is the single list; the code that MODELS each
 * sensor stays where it is (that is real per-device behaviour, not a list).
 *
 * NOT in here on purpose: sensors that register through the same channel but
 * only LISTEN — an ePaper panel's DC / CS / RST, a membrane keypad's rows, any
 * I2C device on a virtual 200+addr pin. The host drives those, so they must
 * stay drivable.
 *
 * Adding a single-wire sensor: one entry here, plus the model itself (a part
 * under simulation/parts and, for the in-browser engines, a case in the
 * overlay's singleWireSensors). Nothing else needs to learn its name.
 */

export interface SensorModelSpec {
  /** `sensor_type` in the wire protocol — what the backend / engine dispatches on. */
  sensorType: string;
  /** Component pin carrying the data (or trigger) line, as named on the part. */
  dataPinName: string;
  /** Component properties forwarded to the model (temperature, distance, …). */
  propertyKeys: string[];
  /**
   * Which of `propertyKeys` carry TEXT. Everything a sensor reports has been a
   * number until now, so the pre-registration walk parsed every property as
   * one — and an IR receiver's `channel` (a name the user types, matched as a
   * string by the air) came out of that walk as NaN. Listed here rather than
   * sniffed from the value, because an empty channel and a channel named "5"
   * are both legitimate and neither looks like text.
   */
  textPropertyKeys?: string[];
  /**
   * Extra pins the model also drives, as `record field -> component pin name`.
   * The field name is what reaches the backend (`echo_pin`), and the same
   * fields are what `ownsPin` walks — so a model that gains a second line only
   * has to declare it here.
   */
  extraPins?: Record<string, string>;
}

/** Keyed by the component's metadataId on the canvas. */
export const SINGLE_WIRE_SENSOR_MODELS: Readonly<Record<string, SensorModelSpec>> = {
  dht22: {
    sensorType: 'dht22',
    dataPinName: 'SDA',
    propertyKeys: ['temperature', 'humidity'],
  },
  'hc-sr04': {
    sensorType: 'hc-sr04',
    dataPinName: 'TRIG',
    propertyKeys: ['distance'],
    extraPins: { echo_pin: 'ECHO' },
  },
  // The demodulator can behind an IR receiver's lens. Not a sensor of anything
  // physical: it listens to `simulation/ir/irAir` and puts the envelope of
  // whatever crossed the room on its pin. It is here for the same two reasons
  // the others are — the pad is the model's and no other layer may drive it,
  // and the pre-registration walk has to resolve that pad through the wires
  // before the firmware starts.
  'ir-receiver': {
    sensorType: 'ir-nec',
    dataPinName: 'DAT',
    propertyKeys: ['address', 'command', 'channel'],
    textPropertyKeys: ['channel'],
  },
};

/**
 * Pads a MODEL drives, per `sensor_type`, as record fields (a field may hold a
 * single pad or a list of them). Anything listed here is off limits to every
 * other layer — the SPICE-threshold connector above all.
 *
 * The single-wire sensors contribute their data pin plus whatever extra pins
 * they declare. The other two entries are models that own a pad WITHOUT being
 * single-wire, which is why a plain "is it a single-wire sensor?" test was not
 * enough:
 *
 *  - a matrix keypad's COLUMNS are driven by the model (the QEMU worker even
 *    keeps a `_keypad_cols_owned` set); the firmware scans them as inputs;
 *  - an ePaper panel drives BUSY to tell the firmware it is refreshing. Its
 *    DC / CS / RST are the opposite case — the host drives those, so they are
 *    deliberately absent.
 *
 * Neither is broken with plain wiring today, because the connector's older
 * `sourcedNets` gate happens to skip a net nothing else sits on. Put a pull-up
 * on a keypad column and that gate stops holding — which is exactly how a
 * level-shifted HC-SR04 lost its echo.
 */
const MODEL_OWNED_PIN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    Object.values(SINGLE_WIRE_SENSOR_MODELS).map((m) => [
      m.sensorType,
      ['pin', ...Object.keys(m.extraPins ?? {})],
    ]),
  ),
  'matrix-keypad': ['cols'],
  'epaper-ssd168x': ['busy_pin'],
};

/** `sensor_type` values whose model drives its own line. Derived, never typed twice. */
export const SINGLE_WIRE_SENSOR_TYPES: ReadonlySet<string> = new Set(
  Object.values(SINGLE_WIRE_SENSOR_MODELS).map((m) => m.sensorType),
);

/** True for a sensor record (`{ sensor_type, pin, ... }`) of a single-wire kind. */
export function isSingleWireSensorRecord(rec: Record<string, unknown>): boolean {
  return SINGLE_WIRE_SENSOR_TYPES.has(String(rec['sensor_type'] ?? ''));
}

/**
 * Pads a registered sensor record owns, per the declaration above: the fields
 * are read off the record itself, so a model that grows a line is covered by
 * its entry alone. A record of a kind that owns nothing (an I2C device on a
 * virtual pin, a panel's host-driven DC/CS/RST) answers false for every pad.
 */
export function sensorRecordOwnsPin(rec: Record<string, unknown>, gpioPin: number): boolean {
  const fields = MODEL_OWNED_PIN_FIELDS[String(rec['sensor_type'] ?? '')];
  if (!fields) return false;
  for (const field of fields) {
    const v = rec[field];
    if (v === gpioPin) return true;
    if (Array.isArray(v) && v.includes(gpioPin)) return true;
  }
  return false;
}

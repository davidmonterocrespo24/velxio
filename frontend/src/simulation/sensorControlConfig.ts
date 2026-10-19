/**
 * sensorControlConfig.ts — defines the interactive controls shown in the
 * SensorControlPanel for each sensor component type.
 *
 * Used by:
 *  - SensorControlPanel.tsx  (renders the controls)
 *  - SimulatorCanvas.tsx     (decides whether to show the panel on click)
 */

export interface SliderControl {
  type: 'slider';
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  defaultValue: number;
  /** Optional custom formatter — e.g. to show "24.0°C" instead of "24" */
  formatValue?: (v: number) => string;
  /** 'log': the slider POSITION is logarithmic in the value. For quantities
   *  perceived and sensed logarithmically (illumination on an LDR), a linear
   *  slider crams all the behaviour into its first few percent — the
   *  night-light example toggled at 2% of travel. Requires min >= 0. */
  scale?: 'log';
  /** The component property that holds this control's PROJECT value, when it
   *  is not `key` itself (the IR remote's `address` lives in `irAddress`).
   *  Reset and the panel read the project value from it. */
  propertyKey?: string;
  /** Names of the values, for a slider that is really a CHOICE among a few
   *  (an event kind, a surface, a key): value -> label. The panel and the
   *  property dialog then show a select with these labels instead of a bare
   *  number; the value stored and dispatched stays the number. A two-position
   *  slider (0/1, step 1) without options is an on/off switch and shows as a
   *  checkbox; one whose formatValue names both positions is a choice between
   *  those two names. See sliderInput(). */
  options?: Record<number, string>;
}

export interface ButtonControl {
  type: 'button';
  key: string;
  label: string;
}

export type SensorControl = SliderControl | ButtonControl;

export interface SensorControlDef {
  title: string;
  controls: SensorControl[];
  defaultValues: Record<string, number | boolean>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** How a slider is edited: a range, an on/off switch, or a choice of names. */
export type SliderInput =
  | { kind: 'range' }
  | { kind: 'toggle' }
  | { kind: 'choice'; options: { value: number; label: string }[] };

/** A formatted position that just prints its own number ("0", "1.0"), as
 *  opposed to a name for it ("Manual", "0x68"). */
const printsItself = (text: string, v: number) => text.trim() !== '' && Number(text.trim()) === v;

/**
 * The input a slider really is. Many sensors model a switch ("magnet
 * present", "probe disconnected") or a small set of named cases ("event:
 * strike / disturber / noise") as an integer slider, and a bare number is a
 * poor way to set either:
 *  - declared `options` make it a choice among those labels (values outside
 *    min..max are dropped, the rest sorted);
 *  - a 0..1 slider with step 1 is a two-position switch: a choice when its
 *    formatValue names the positions (Source: Manual / Thermal zone), else a
 *    checkbox (on = 1);
 *  - everything else stays a range.
 * The value is a number in every case, so stored projects, Reset and the
 * parts' update callbacks are unchanged.
 */
export function sliderInput(ctrl: SliderControl): SliderInput {
  if (ctrl.options) {
    const options = Object.entries(ctrl.options)
      .map(([v, label]) => ({ value: Number(v), label }))
      .filter((o) => Number.isFinite(o.value) && o.value >= ctrl.min && o.value <= ctrl.max)
      .sort((a, b) => a.value - b.value);
    if (options.length > 0) return { kind: 'choice', options };
  }
  if (ctrl.min === 0 && ctrl.max === 1 && ctrl.step === 1 && ctrl.scale !== 'log') {
    if (ctrl.formatValue) {
      const off = ctrl.formatValue(0);
      const on = ctrl.formatValue(1);
      if (!printsItself(off, 0) && !printsItself(on, 1) && off !== on) {
        return {
          kind: 'choice',
          options: [
            { value: 0, label: off },
            { value: 1, label: on },
          ],
        };
      }
    }
    return { kind: 'toggle' };
  }
  return { kind: 'range' };
}

/** The option a stored value selects: the nearest one, so a project that
 *  holds 0.6 (an old slider save) shows the option the part acts on. */
export function nearestOption(
  options: { value: number; label: string }[],
  value: number,
): { value: number; label: string } | undefined {
  let best: { value: number; label: string } | undefined;
  for (const o of options) {
    if (!best || Math.abs(o.value - value) < Math.abs(best.value - value)) best = o;
  }
  return best;
}

const oneDecimal = (v: number) => v.toFixed(1);
/** NEC address/command as every decoder prints them: 0x and two hex digits. */
const hex8 = (v: number) =>
  `0x${(Math.round(v) & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
const twoDecimal = (v: number) => v.toFixed(2);

/** Resolution of the position axis for log-scale sliders. */
export const LOG_SLIDER_STEPS = 1000;

/** Log-scale slider: position 0..LOG_SLIDER_STEPS -> value min..max.
 *  value = min + 10^(p/STEPS * log10(span+1)) - 1, so position 0 lands
 *  EXACTLY on min (a log axis has no true zero; the +1 shift gives it one)
 *  and full travel lands exactly on max. */
export function logSliderToValue(pos: number, min: number, max: number): number {
  const p = Math.min(Math.max(pos, 0), LOG_SLIDER_STEPS) / LOG_SLIDER_STEPS;
  const span = max - min;
  return Math.round(min + Math.pow(10, p * Math.log10(span + 1)) - 1);
}

/** Inverse of logSliderToValue — where an existing value sits on the axis. */
export function logValueToSlider(value: number, min: number, max: number): number {
  const span = max - min;
  const v = Math.min(Math.max(value, min), max) - min;
  return Math.round((Math.log10(v + 1) / Math.log10(span + 1)) * LOG_SLIDER_STEPS);
}

// ─── Sensor Control Definitions ──────────────────────────────────────────────

export const SENSOR_CONTROLS: Record<string, SensorControlDef> = {
  // ── MPU-6050 6-axis IMU ────────────────────────────────────────────────────
  // The sliders span the chip's widest ranges (16 g, 2000 deg/s). Past the
  // range the sketch selected, the output stays at full scale, as the chip's.
  mpu6050: {
    title: 'MPU6050 Accelerometer + Gyroscope',
    controls: [
      // Acceleration
      {
        type: 'slider',
        key: 'accelX',
        label: 'X',
        min: -16,
        max: 16,
        step: 0.01,
        unit: 'g',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'accelY',
        label: 'Y',
        min: -16,
        max: 16,
        step: 0.01,
        unit: 'g',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'accelZ',
        label: 'Z',
        min: -16,
        max: 16,
        step: 0.01,
        unit: 'g',
        defaultValue: 1,
        formatValue: oneDecimal,
      },
      // Rotation (gyro)
      {
        type: 'slider',
        key: 'gyroX',
        label: 'X',
        min: -2000,
        max: 2000,
        step: 1,
        unit: '°/sec',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'gyroY',
        label: 'Y',
        min: -2000,
        max: 2000,
        step: 1,
        unit: '°/sec',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'gyroZ',
        label: 'Z',
        min: -2000,
        max: 2000,
        step: 1,
        unit: '°/sec',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      // Temperature
      {
        type: 'slider',
        key: 'temp',
        label: 'Temperature',
        min: -40,
        max: 85,
        step: 1,
        unit: '°C',
        defaultValue: 24,
        formatValue: oneDecimal,
      },
    ],
    defaultValues: { accelX: 0, accelY: 0, accelZ: 1, gyroX: 0, gyroY: 0, gyroZ: 0, temp: 24 },
  },

  // ── DHT22 Temperature / Humidity ──────────────────────────────────────────
  dht22: {
    title: 'DHT22 Temperature & Humidity',
    controls: [
      {
        type: 'slider',
        key: 'temperature',
        label: 'Temperature',
        min: -40,
        max: 80,
        step: 0.5,
        unit: '°C',
        defaultValue: 25,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'humidity',
        label: 'Humidity',
        min: 0,
        max: 100,
        step: 0.5,
        unit: '%',
        defaultValue: 50,
        formatValue: oneDecimal,
      },
    ],
    defaultValues: { temperature: 25, humidity: 50 },
  },

  // ── BMP280 Barometric Pressure + Temperature ───────────────────────────────
  bmp280: {
    title: 'BMP280 Barometric Pressure Sensor',
    controls: [
      {
        type: 'slider',
        key: 'temperature',
        label: 'Temperature',
        min: -40,
        max: 85,
        step: 1,
        unit: '°C',
        defaultValue: 24,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'pressure',
        label: 'Pressure',
        min: 300,
        max: 1100,
        step: 0.25,
        unit: 'hPa',
        defaultValue: 1013.25,
        formatValue: twoDecimal,
      },
    ],
    defaultValues: { temperature: 24, pressure: 1013.25 },
  },

  // ── DS3231 RTC (on-chip temperature sensor) ────────────────────────────────
  ds3231: {
    title: 'DS3231 RTC Temperature',
    controls: [
      {
        type: 'slider',
        key: 'temperature',
        label: 'Temperature',
        min: -40,
        max: 85,
        step: 0.25,
        unit: '°C',
        defaultValue: 25,
        formatValue: twoDecimal,
      },
    ],
    defaultValues: { temperature: 25 },
  },

  // ── GPS NEO-6M (position fed into the NMEA stream) ─────────────────────────
  'gps-neo6m': {
    title: 'GPS NEO-6M Position',
    controls: [
      {
        type: 'slider',
        key: 'lat',
        label: 'Latitude',
        min: -90,
        max: 90,
        step: 0.0001,
        unit: '°',
        defaultValue: 40.4168,
        formatValue: (v: number) => v.toFixed(4),
      },
      {
        type: 'slider',
        key: 'lng',
        label: 'Longitude',
        min: -180,
        max: 180,
        step: 0.0001,
        unit: '°',
        defaultValue: -3.7038,
        formatValue: (v: number) => v.toFixed(4),
      },
      {
        type: 'slider',
        key: 'altitude',
        label: 'Altitude',
        min: -100,
        max: 9000,
        step: 1,
        unit: 'm',
        defaultValue: 667,
      },
      {
        type: 'slider',
        key: 'speed',
        label: 'Speed',
        min: 0,
        max: 200,
        step: 0.5,
        unit: 'kn',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
    ],
    defaultValues: { lat: 40.4168, lng: -3.7038, altitude: 667, speed: 0 },
  },

  // ── HC-SR04 Ultrasonic Distance ───────────────────────────────────────────
  'hc-sr04': {
    title: 'Ultrasonic Distance Sensor',
    controls: [
      {
        type: 'slider',
        key: 'distance',
        label: 'Distance',
        min: 2,
        max: 400,
        step: 1,
        unit: 'cm',
        defaultValue: 10,
      },
    ],
    defaultValues: { distance: 10 },
  },

  // ── Photoresistor (LDR) ───────────────────────────────────────────────────
  'photoresistor-sensor': {
    title: 'Photoresistor (LDR)',
    controls: [
      {
        type: 'slider',
        key: 'lux',
        label: 'Illumination',
        min: 0,
        max: 1000,
        step: 1,
        unit: 'lux',
        defaultValue: 500,
        scale: 'log',
      },
    ],
    defaultValues: { lux: 500 },
  },

  // ── Photodiode ────────────────────────────────────────────────────────────
  photodiode: {
    title: 'Photodiode',
    controls: [
      {
        type: 'slider',
        key: 'lux',
        label: 'Illumination',
        min: 0,
        max: 1000,
        step: 1,
        unit: 'lux',
        defaultValue: 500,
        scale: 'log',
      },
    ],
    defaultValues: { lux: 500 },
  },

  // ── PIR Motion Sensor ─────────────────────────────────────────────────────
  'pir-motion-sensor': {
    title: 'PIR Motion Sensor',
    controls: [{ type: 'button', key: 'trigger', label: 'Simulate motion' }],
    defaultValues: {},
  },

  // ── IR receiver ───────────────────────────────────────────────────────────
  // The panel IS the remote, for a canvas with no handset on it. Send
  // transmits into simulation/ir/irAir rather than straight onto this part's
  // pin, so a second receiver in the project hears it too — which is the whole
  // point of there being an air at all.
  'ir-receiver': {
    title: 'IR remote',
    controls: [
      {
        type: 'slider',
        key: 'address',
        propertyKey: 'irAddress',
        label: 'Address',
        min: 0,
        max: 255,
        step: 1,
        unit: '',
        defaultValue: 0,
        formatValue: hex8,
      },
      {
        type: 'slider',
        key: 'command',
        propertyKey: 'irCommand',
        label: 'Command',
        min: 0,
        max: 255,
        step: 1,
        unit: '',
        defaultValue: 0x45,
        formatValue: hex8,
      },
      { type: 'button', key: 'send', label: 'Send' },
    ],
    defaultValues: { address: 0, command: 0x45 },
  },

  // ── NTC Temperature Sensor ────────────────────────────────────────────────
  'ntc-temperature-sensor': {
    title: 'NTC Temperature Sensor',
    controls: [
      {
        type: 'slider',
        key: 'temperature',
        label: 'Temperature',
        min: -40,
        max: 125,
        step: 1,
        unit: '°C',
        defaultValue: 25,
        formatValue: oneDecimal,
      },
    ],
    defaultValues: { temperature: 25 },
  },

  // ── Gas Sensor (MQ-series) ────────────────────────────────────────────────
  'gas-sensor': {
    title: 'Gas Sensor (MQ-series)',
    controls: [
      {
        type: 'slider',
        key: 'gasLevel',
        label: 'Gas Level',
        min: 0,
        max: 1023,
        step: 1,
        unit: '',
        defaultValue: 100,
      },
    ],
    defaultValues: { gasLevel: 100 },
  },

  // ── Flame Sensor ──────────────────────────────────────────────────────────
  'flame-sensor': {
    title: 'Flame Sensor',
    controls: [
      {
        type: 'slider',
        key: 'intensity',
        label: 'Flame Intensity',
        min: 0,
        max: 1023,
        step: 1,
        unit: '',
        defaultValue: 0,
      },
    ],
    defaultValues: { intensity: 0 },
  },

  // ── Big Sound Sensor (FC-04) ──────────────────────────────────────────────
  'heart-beat-sensor': {
    title: 'Heart Beat Sensor',
    controls: [
      {
        type: 'slider',
        key: 'bpm',
        label: 'Heart Rate',
        min: 30,
        max: 220,
        step: 1,
        unit: 'BPM',
        defaultValue: 72,
      },
    ],
    defaultValues: { bpm: 72 },
  },

  'big-sound-sensor': {
    title: 'Sound Sensor',
    controls: [
      {
        type: 'slider',
        key: 'soundLevel',
        label: 'Sound Level',
        min: 0,
        max: 1023,
        step: 1,
        unit: '',
        defaultValue: 512,
      },
    ],
    defaultValues: { soundLevel: 512 },
  },

  // ── Small Sound Sensor (KY-038) ───────────────────────────────────────────
  'small-sound-sensor': {
    title: 'Sound Sensor (KY-038)',
    controls: [
      {
        type: 'slider',
        key: 'soundLevel',
        label: 'Sound Level',
        min: 0,
        max: 1023,
        step: 1,
        unit: '',
        defaultValue: 512,
      },
    ],
    defaultValues: { soundLevel: 512 },
  },

  // ── Tilt Switch ───────────────────────────────────────────────────────────
  'tilt-switch': {
    title: 'Tilt Switch',
    controls: [{ type: 'button', key: 'toggle', label: 'Toggle tilt' }],
    defaultValues: {},
  },

  // ── Analog Joystick ───────────────────────────────────────────────────────
  'analog-joystick': {
    title: 'Analog Joystick',
    controls: [
      {
        type: 'slider',
        key: 'xAxis',
        label: 'X Axis',
        min: -512,
        max: 512,
        step: 1,
        unit: '',
        defaultValue: 0,
      },
      {
        type: 'slider',
        key: 'yAxis',
        label: 'Y Axis',
        min: -512,
        max: 512,
        step: 1,
        unit: '',
        defaultValue: 0,
      },
    ],
    defaultValues: { xAxis: 0, yAxis: 0 },
  },
};

// ── Overlay seam ─────────────────────────────────────────────────────────────
// A private build (velxio.dev) registers sensor-control definitions for the
// sensors it ships outside the OSS tree (e.g. the DFRobot Gravity analog
// family). Same contract as proBoardRegistry / registerComponentDoc: dead code
// in a pure OSS build. Read every SENSOR_CONTROLS lookup through
// getSensorControl() so overlay-registered sensors surface their slider panel.
const proSensorControls: Record<string, SensorControlDef> = {};

/**
 * Overlay seam — INSTANCE-level control resolution. Catalog sensors key
 * their def by metadataId; some overlay parts (e.g. pro programmable
 * sensor chips) derive controls from the component INSTANCE instead. The
 * overlay installs a resolver here; pure OSS has none and every lookup
 * falls back to the metadataId table.
 */
export type InstanceSensorControlResolver = (component: {
  id: string;
  metadataId?: string;
  properties?: Record<string, unknown>;
}) => SensorControlDef | undefined;

let instanceResolver: InstanceSensorControlResolver | null = null;

export function registerInstanceSensorControlResolver(fn: InstanceSensorControlResolver): void {
  instanceResolver = fn;
}

/** metadataId lookup first (OSS + overlay-registered), then the overlay's
 *  instance resolver. This is what the canvas click paths, the panel and
 *  the reset path consume. */
export function getSensorControlForComponent(component: {
  id: string;
  metadataId?: string;
  properties?: Record<string, unknown>;
}): SensorControlDef | undefined {
  return getSensorControl(component.metadataId) ?? instanceResolver?.(component);
}

/** A number from a stored property value: numbers as they are, numeric
 *  strings (the property dialog and older saves write strings, hex included:
 *  the IR remote stores '0x45'), and nothing else. */
function propertyNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * The values a sensor has in the PROJECT, in control-key space: what the user
 * configured (the component's properties, or `properties.attrs` on a custom
 * chip, where the chip reads them through vx_attr_read), with the panel default
 * only for a control the project leaves unset.
 *
 * Reset brings a sensor back to these and the panel opens on them. A slider
 * moved during a run is a live input and never changes them: the parts that
 * mirror a live value into properties (for the SPICE netlist) do it through
 * the store's applyLivePropertyChange, which Reset takes back out.
 */
export function projectSensorValues(
  component: { id: string; metadataId?: string; properties?: Record<string, unknown> },
  def: SensorControlDef,
): Record<string, number | boolean> {
  const props = component.properties ?? {};
  const source =
    component.metadataId === 'custom-chip'
      ? ((props.attrs ?? {}) as Record<string, unknown>)
      : props;
  const values: Record<string, number | boolean> = { ...def.defaultValues };
  for (const ctrl of def.controls) {
    if (ctrl.type !== 'slider') continue;
    const n = propertyNumber(source[ctrl.propertyKey ?? ctrl.key]);
    if (n !== undefined) values[ctrl.key] = n;
    else if (values[ctrl.key] === undefined) values[ctrl.key] = ctrl.defaultValue;
  }
  return values;
}

/**
 * One PROJECT value of a sensor, as the property dialog edits it: a slider of
 * the sensor's panel, read from the same property the part and
 * projectSensorValues read (propertyKey, else key), with the slider's range,
 * step, unit and default. Derived from the control definition on purpose, so
 * the dialog and the panel cannot drift apart and every sensor with a panel,
 * catalogue or overlay-registered, gets its fields without per-part metadata.
 */
export interface SensorProjectField {
  /** Control key: what the panel dispatches and the part's update reads. */
  key: string;
  /** Component property that stores the project value. */
  property: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  defaultValue: number;
  /** The project value: the stored property, or the panel default. */
  value: number;
  /** The panel slider is logarithmic: the dialog edits the value itself,
   *  never a position on the log axis. */
  log: boolean;
  /** Range, on/off switch or named choice (sliderInput()). */
  input: SliderInput;
  formatValue?: (v: number) => string;
}

/**
 * The fields the property dialog shows for a sensor's project values. Buttons
 * (Simulate motion, Send) are actions, not values, and are left out. A custom
 * chip gets none: its attributes already have their own editor, fed from
 * chip.json and stored under properties.attrs.
 */
export function sensorProjectFields(component: {
  id: string;
  metadataId?: string;
  properties?: Record<string, unknown>;
}): SensorProjectField[] {
  if (component.metadataId === 'custom-chip') return [];
  const def = getSensorControlForComponent(component);
  if (!def) return [];
  const values = projectSensorValues(component, def);
  const fields: SensorProjectField[] = [];
  for (const ctrl of def.controls) {
    if (ctrl.type !== 'slider') continue;
    const value = values[ctrl.key];
    fields.push({
      key: ctrl.key,
      property: ctrl.propertyKey ?? ctrl.key,
      label: ctrl.label,
      min: ctrl.min,
      max: ctrl.max,
      step: ctrl.step,
      unit: ctrl.unit,
      defaultValue: ctrl.defaultValue,
      value: typeof value === 'number' ? value : ctrl.defaultValue,
      log: ctrl.scale === 'log',
      input: sliderInput(ctrl),
      formatValue: ctrl.formatValue,
    });
  }
  return fields;
}

export function registerSensorControls(defs: Record<string, SensorControlDef>): void {
  Object.assign(proSensorControls, defs);
}

export function getSensorControl(id: string | null | undefined): SensorControlDef | undefined {
  if (!id) return undefined;
  return SENSOR_CONTROLS[id] ?? proSensorControls[id];
}

/**
 * Where a sensor's control `key` starts when the project leaves it unset: the
 * control definition's default, the one number the panel, the property
 * dialog and the part all share. A part reads its starting value from here
 * instead of a literal of its own (the BMP280 used to start at 25 C while
 * its panel and dialog said 24). `fallback` is only for a part whose control
 * definition is missing, which the sensor-defaults test forbids.
 */
export function sensorControlDefault(id: string, key: string, fallback: number): number {
  const v = getSensorControl(id)?.defaultValues[key];
  return typeof v === 'number' ? v : fallback;
}

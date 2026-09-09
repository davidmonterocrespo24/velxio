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
  mpu6050: {
    title: 'MPU6050 Accelerometer + Gyroscope',
    controls: [
      // Acceleration
      {
        type: 'slider',
        key: 'accelX',
        label: 'X',
        min: -2,
        max: 2,
        step: 0.01,
        unit: 'g',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'accelY',
        label: 'Y',
        min: -2,
        max: 2,
        step: 0.01,
        unit: 'g',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'accelZ',
        label: 'Z',
        min: -2,
        max: 2,
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
        min: -250,
        max: 250,
        step: 1,
        unit: '°/sec',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'gyroY',
        label: 'Y',
        min: -250,
        max: 250,
        step: 1,
        unit: '°/sec',
        defaultValue: 0,
        formatValue: oneDecimal,
      },
      {
        type: 'slider',
        key: 'gyroZ',
        label: 'Z',
        min: -250,
        max: 250,
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
// A private build (velxio.com) registers sensor-control definitions for the
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

export function registerSensorControls(defs: Record<string, SensorControlDef>): void {
  Object.assign(proSensorControls, defs);
}

export function getSensorControl(id: string | null | undefined): SensorControlDef | undefined {
  if (!id) return undefined;
  return SENSOR_CONTROLS[id] ?? proSensorControls[id];
}

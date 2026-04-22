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
const twoDecimal = (v: number) => v.toFixed(2);

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

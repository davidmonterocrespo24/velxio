/**
 * SensorControlPanel — wokwi-style interactive sensor controls.
 *
 * Appears at the top-left of the simulation canvas when a sensor component is
 * clicked during simulation.  Provides sliders and buttons that feed values
 * directly into the running simulation via SensorUpdateRegistry.
 */

import React, { useEffect, useState } from 'react';
import {
  SENSOR_CONTROLS,
  type SensorControl,
  type SliderControl,
} from '../../simulation/sensorControlConfig';
import { dispatchSensorUpdate } from '../../simulation/SensorUpdateRegistry';
import './SensorControlPanel.css';

interface SensorControlPanelProps {
  componentId: string;
  metadataId: string;
  sensorName: string;
  onClose: () => void;
}

// ── Section grouping for MPU6050 ────────────────────────────────────────────

interface SensorSection {
  label: string;
  icon: string;
  keys: string[];
}

const MPU6050_SECTIONS: SensorSection[] = [
  { label: 'Acceleration', icon: '↗', keys: ['accelX', 'accelY', 'accelZ'] },
  { label: 'Rotation', icon: '↻', keys: ['gyroX', 'gyroY', 'gyroZ'] },
  { label: 'Temperature', icon: '🌡', keys: ['temp'] },
];

// Keys that use single-char axis labels (X / Y / Z) rather than the full key name
const AXIS_KEYS = new Set(['accelX', 'accelY', 'accelZ', 'gyroX', 'gyroY', 'gyroZ']);

// ── Component ───────────────────────────────────────────────────────────────

export const SensorControlPanel: React.FC<SensorControlPanelProps> = ({
  componentId,
  metadataId,
  sensorName,
  onClose,
}) => {
  const def = SENSOR_CONTROLS[metadataId];

  // Local slider/button state — initialised from config defaults
  const [values, setValues] = useState<Record<string, number | boolean>>(
    def ? { ...def.defaultValues } : {},
  );

  // Push initial defaults into simulation on mount
  useEffect(() => {
    if (def && Object.keys(def.defaultValues).length > 0) {
      dispatchSensorUpdate(componentId, def.defaultValues);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!def) return null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSlider = (key: string, raw: string) => {
    const v = parseFloat(raw);
    setValues((prev) => ({ ...prev, [key]: v }));
    dispatchSensorUpdate(componentId, { [key]: v });
  };

  const handleButton = (key: string) => {
    dispatchSensorUpdate(componentId, { [key]: true });
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderControl = (ctrl: SensorControl) => {
    if (ctrl.type === 'button') {
      return (
        <button
          key={ctrl.key}
          className="sensor-trigger-button"
          onClick={() => handleButton(ctrl.key)}
        >
          {ctrl.label}
        </button>
      );
    }

    // Slider
    const sc = ctrl as SliderControl;
    const val = (values[sc.key] as number) ?? sc.defaultValue;
    const displayVal = sc.formatValue ? sc.formatValue(val) : String(val);
    const isAxisKey = AXIS_KEYS.has(sc.key);

    return (
      <div key={sc.key} className="sensor-control-row">
        <span className={isAxisKey ? 'sensor-control-label' : 'sensor-control-label-wide'}>
          {isAxisKey ? sc.label : sc.label}
        </span>
        <input
          type="range"
          className="sensor-slider"
          min={sc.min}
          max={sc.max}
          step={sc.step}
          value={val}
          onChange={(e) => handleSlider(sc.key, e.target.value)}
        />
        <span className="sensor-value-display">
          {displayVal}
          {sc.unit ? ` ${sc.unit}` : ''}
        </span>
      </div>
    );
  };

  // For MPU6050 render sections; for everything else render controls flat
  const renderControls = () => {
    if (metadataId === 'mpu6050') {
      return MPU6050_SECTIONS.map((section) => {
        const sectionControls = def.controls.filter((c) => section.keys.includes(c.key));
        return (
          <React.Fragment key={section.label}>
            <div className="sensor-section-label">
              <span className="sensor-section-icon">{section.icon}</span>
              {section.label}
            </div>
            {sectionControls.map(renderControl)}
          </React.Fragment>
        );
      });
    }
    return def.controls.map(renderControl);
  };

  return (
    <div className="sensor-control-panel" onClick={(e) => e.stopPropagation()}>
      <div className="sensor-panel-header">
        <span className="sensor-panel-title">{sensorName || def.title}</span>
        <button className="sensor-panel-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      {renderControls()}
    </div>
  );
};

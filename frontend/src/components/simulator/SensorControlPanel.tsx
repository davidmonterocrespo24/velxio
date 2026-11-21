/**
 * SensorControlPanel — wokwi-style interactive sensor controls.
 *
 * Appears at the top-left of the simulation canvas when a sensor component is
 * clicked during simulation.  Provides sliders and buttons that feed values
 * directly into the running simulation via SensorUpdateRegistry.
 */

import { DropdownSelect } from '../ui/DropdownSelect';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type SensorControl, type SliderControl, LOG_SLIDER_STEPS, logSliderToValue, logValueToSlider, getSensorControlForComponent, projectSensorValues, sliderInput, nearestOption } from '../../simulation/sensorControlConfig';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import {
  dispatchSensorUpdate,
  getLastSensorValues,
  replayProjectSensorValues,
} from '../../simulation/SensorUpdateRegistry';
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
  const { t } = useTranslation();
  // Instance-aware: catalog sensors resolve by metadataId; overlay parts
  // may derive controls from the component instance (resolver seam).
  const comp = useSimulatorStore
    .getState()
    .components.find((c) => c.id === componentId);
  const def = comp ? getSensorControlForComponent(comp) : undefined;

  // The sensor's project values: what the user configured, with the panel
  // defaults only for what the project leaves unset.
  const project = comp && def ? projectSensorValues(comp, def) : {};

  // Local slider/button state — hydrated from the registry's last-known
  // values for this componentId (so reopening a sensor or switching between
  // two sensors of the same type shows each one's current state, not the
  // previous panel's). Falls back to the project values the first time a
  // sensor is opened, and after a Reset (sensorResetNonce remounts this).
  const [values, setValues] = useState<Record<string, number | boolean>>(() => {
    const cached = getLastSensorValues(componentId);
    return cached ? { ...project, ...cached } : { ...project };
  });

  // First open for this sensor: make sure the simulation holds what the
  // slider shows (a part without a project value runs on its own default).
  // A replay, not a live move: nothing is written into the project. Skipped
  // when the sensor already has cached values — the simulation still holds
  // them, no need to clobber.
  useEffect(() => {
    if (Object.keys(project).length > 0 && !getLastSensorValues(componentId)) {
      replayProjectSensorValues(componentId, project);
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

    // A switch or a choice among named cases: the same control the property
    // dialog shows for it, dispatching the same number the slider would.
    const input = sliderInput(sc);
    if (input.kind === 'toggle') {
      const id = `sensor-ctl-${componentId}-${sc.key}`;
      return (
        <div key={sc.key} className="sensor-control-row">
          <label className="sensor-control-label-wide" htmlFor={id}>
            {sc.label}
          </label>
          <input
            id={id}
            type="checkbox"
            className="sensor-check"
            checked={Number(val) >= 0.5}
            onChange={(e) => handleSlider(sc.key, e.target.checked ? '1' : '0')}
          />
        </div>
      );
    }
    if (input.kind === 'choice') {
      const id = `sensor-ctl-${componentId}-${sc.key}`;
      const current = nearestOption(input.options, Number(val));
      return (
        <div key={sc.key} className="sensor-control-row">
          <label className="sensor-control-label-wide" htmlFor={id}>
            {sc.label}
          </label>
          <DropdownSelect
            id={id}
            className="sensor-select"
            value={current ? String(current.value) : ''}
            onValueChange={(value) => handleSlider(sc.key, value)}
          >
            {input.options.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </DropdownSelect>
        </div>
      );
    }
    const displayVal = sc.formatValue ? sc.formatValue(val) : String(val);
    const isAxisKey = AXIS_KEYS.has(sc.key);
    // Log-scale sliders (illumination): the range input runs in POSITION
    // space and the value is derived, so the interesting low decades get
    // real travel instead of the first few pixels.
    const isLog = sc.scale === 'log';

    return (
      <div key={sc.key} className="sensor-control-row">
        <span className={isAxisKey ? 'sensor-control-label' : 'sensor-control-label-wide'}>
          {isAxisKey ? sc.label : sc.label}
        </span>
        <input
          type="range"
          className="sensor-slider"
          min={isLog ? 0 : sc.min}
          max={isLog ? LOG_SLIDER_STEPS : sc.max}
          step={isLog ? 1 : sc.step}
          value={isLog ? logValueToSlider(val, sc.min, sc.max) : val}
          onChange={(e) =>
            handleSlider(
              sc.key,
              isLog
                ? String(logSliderToValue(parseFloat(e.target.value), sc.min, sc.max))
                : e.target.value,
            )
          }
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
    <div
      className="sensor-control-panel"
      onClick={(e) => e.stopPropagation()}
      // The canvas treats left mousedown on empty space as a pan gesture.
      // Without stopping mousedown here, dragging the lux/temp/etc. slider
      // thumb pans the canvas instead of moving the slider.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="sensor-panel-header">
        <span className="sensor-panel-title">{sensorName || def.title}</span>
        <button className="sensor-panel-close" onClick={onClose} title={t('editor.sensorPanel.close')}>
          ×
        </button>
      </div>
      {renderControls()}
    </div>
  );
};

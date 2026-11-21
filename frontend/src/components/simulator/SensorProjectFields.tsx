/**
 * The PROJECT values of a sensor, in the property dialog: one field per slider
 * of the sensor's panel (BMP280 temperature and pressure, the NTC's
 * temperature, every overlay-registered sensor), with the slider's range, step
 * and unit. The fields come from sensorProjectFields(), i.e. from the panel's
 * own control definition, so the dialog and the panel cannot drift.
 *
 * These are where the sensor starts on Run and where Reset brings it back. A
 * slider dragged during a run is a live input and never shows here; an edit
 * here is a project edit, stopped or running (the caller delivers it to the
 * running part).
 *
 * A linear slider gets a range next to its number; a log slider (illumination)
 * gets the number alone, since its range input would move a log-axis position
 * rather than the value the project stores. A slider that is really a switch
 * ("Magnet present") gets a checkbox, and one that is a choice among named
 * cases ("Event: strike / disturber / noise") a select with those names; the
 * value stored is the same number the slider would store.
 */

import { DropdownSelect } from '../ui/DropdownSelect';
import React, { useEffect, useState } from 'react';
import { nearestOption, type SensorProjectField } from '../../simulation/sensorControlConfig';

interface SensorProjectFieldsProps {
  title: string;
  hint: string;
  fields: SensorProjectField[];
  /** Properties the part's metadata declares as strings (the IR remote keeps
      irAddress as '0x45'): the field shows and stores the control's formatted
      text for those, a number for everything else. */
  textProperties?: ReadonlySet<string>;
  onChange: (field: SensorProjectField, stored: number | string) => void;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Decimals the step implies, so 1013.25 + 0.25 never shows 1013.5000000001. */
function stepDecimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

const SensorProjectFieldRow: React.FC<{
  field: SensorProjectField;
  asText: boolean;
  onChange: (field: SensorProjectField, stored: number | string) => void;
}> = ({ field, asText, onChange }) => {
  const shown = (v: number) =>
    asText && field.formatValue ? field.formatValue(v) : String(Number(v.toFixed(stepDecimals(field.step))));
  // The typed text is kept as typed ("-", "10.", an empty box) while the
  // value it stands for is not a valid one yet; it follows the project value
  // whenever that changes from elsewhere (undo, the range input, Reset).
  const [draft, setDraft] = useState(() => shown(field.value));
  useEffect(() => {
    setDraft((d) => (Number(d.trim()) === field.value ? d : shown(field.value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.value]);

  const commit = (v: number) => {
    const next = clamp(v, field.min, field.max);
    const stored: number | string = asText
      ? field.formatValue
        ? field.formatValue(next)
        : String(next)
      : next;
    onChange(field, stored);
  };

  const onText = (text: string) => {
    setDraft(text);
    const v = text.trim() === '' ? NaN : Number(text.trim());
    // Only a value inside the range is committed while typing: on the way to
    // 1013 the box holds 1, 10 and 101, which are below the minimum.
    if (Number.isFinite(v) && v >= field.min && v <= field.max && v !== field.value) commit(v);
  };

  const onBlur = () => {
    const v = draft.trim() === '' ? NaN : Number(draft.trim());
    if (Number.isFinite(v)) {
      const next = clamp(v, field.min, field.max);
      if (next !== field.value) commit(next);
      setDraft(shown(next));
    } else {
      setDraft(shown(field.value));
    }
  };

  const label = field.unit ? `${field.label} (${field.unit})` : field.label;
  const inputId = `pid-sensor-${field.key}`;
  const store = (v: number): number | string => (asText ? String(v) : v);

  if (field.input.kind === 'toggle') {
    return (
      <div className="pid-row pid-sensor-row" data-sensor-field={field.key}>
        <label className="pid-row-label" htmlFor={inputId}>
          {label}
        </label>
        <input
          id={inputId}
          type="checkbox"
          className="pid-sensor-check"
          checked={field.value >= 0.5}
          onChange={(e) => onChange(field, store(e.target.checked ? 1 : 0))}
        />
      </div>
    );
  }

  if (field.input.kind === 'choice') {
    const current = nearestOption(field.input.options, field.value);
    return (
      <div className="pid-row pid-sensor-row" data-sensor-field={field.key}>
        <label className="pid-row-label" htmlFor={inputId}>
          {label}
        </label>
        <DropdownSelect
          id={inputId}
          className="pid-select pid-sensor-select"
          value={current ? String(current.value) : ''}
          onValueChange={(value) => {
            const v = Number(value);
            if (Number.isFinite(v)) onChange(field, store(v));
          }}
        >
          {field.input.options.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </DropdownSelect>
      </div>
    );
  }

  return (
    <div className="pid-row pid-sensor-row" data-sensor-field={field.key}>
      <label className="pid-row-label" htmlFor={inputId}>
        {label}
      </label>
      {!field.log && (
        <input
          type="range"
          className="pid-sensor-range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={clamp(field.value, field.min, field.max)}
          aria-label={label}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) commit(v);
          }}
        />
      )}
      <input
        id={inputId}
        type={asText ? 'text' : 'number'}
        inputMode="decimal"
        className="pid-input pid-sensor-input"
        min={asText ? undefined : field.min}
        max={asText ? undefined : field.max}
        step={asText ? undefined : field.step}
        value={draft}
        title={`${field.min} to ${field.max}${field.unit ? ` ${field.unit}` : ''}`}
        onChange={(e) => onText(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
};

export const SensorProjectFields: React.FC<SensorProjectFieldsProps> = ({
  title,
  hint,
  fields,
  textProperties,
  onChange,
}) => {
  if (fields.length === 0) return null;
  return (
    <div className="pid-sensor-fields">
      <div className="pid-row pid-sensor-title" title={hint}>
        {title}
      </div>
      {fields.map((f) => (
        <SensorProjectFieldRow
          key={f.key}
          field={f}
          asText={textProperties?.has(f.property) ?? false}
          onChange={onChange}
        />
      ))}
    </div>
  );
};

/**
 * Toolbar button that toggles the electrical simulation mode.
 * First activation downloads the ngspice-WASM bundle (~39 MB) and boots
 * the engine; subsequent toggles are instant.
 */
import { useElectricalStore, ELECTRICAL_SIM_ENABLED } from '../../store/useElectricalStore';

export function ElectricalModeToggle() {
  if (!ELECTRICAL_SIM_ENABLED) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const mode = useElectricalStore((s) => s.mode);
  const loading = useElectricalStore((s) => s.engineLoading);
  const ready = useElectricalStore((s) => s.engineReady);
  const error = useElectricalStore((s) => s.error);
  const setMode = useElectricalStore((s) => s.setMode);

  const onClick = () => {
    if (loading) return;
    const next = mode === 'off' ? 'spice' : 'off';
    void setMode(next);
  };

  const active = mode !== 'off' && ready;
  const label = loading
    ? 'Loading SPICE… (~39 MB)'
    : active
    ? '⚡ Electrical ON'
    : '⚡ Electrical';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      title={
        error
          ? `Electrical simulation error: ${error}`
          : active
          ? 'Electrical simulation active (ngspice). Click to turn off.'
          : 'Activate SPICE-accurate electrical simulation. First click downloads ~39 MB.'
      }
      style={{
        padding: '6px 12px',
        borderRadius: 6,
        border: active ? '1px solid #ffa500' : '1px solid #444',
        background: active ? '#3a2800' : 'transparent',
        color: active ? '#ffa500' : '#ccc',
        cursor: loading ? 'wait' : 'pointer',
        fontSize: 13,
        opacity: loading ? 0.7 : 1,
      }}
    >
      {label}
    </button>
  );
}

/**
 * Canvas-header popover for the simulation-only inputs of a board's on-board
 * sensors: which way the device is being held, and how full its battery is.
 *
 * These exist because the emulated parts are perfectly faithful and therefore
 * perfectly boring on their own — an IMU with nothing driving it reports the
 * board lying flat forever, and a battery gauge reports the one voltage it was
 * seeded with. A sketch that reacts to tilt or warns on low charge then has no
 * way to be exercised. The controls are the missing half of those models.
 *
 * Gated per board by the pro board def (builtInImu / builtInBattery), the same
 * way the Mic toggle is, and each section renders only if its flag is set.
 * Values go straight to the board's bridge (setImuAcceleration / setImuGyro /
 * setBatteryVoltage); a board whose bridge lacks a seam simply ignores it.
 *
 * Tilt is entered as roll/pitch on a drag pad rather than as three raw axes:
 * what a user wants to say is "lean it left", and gravity in the board's own
 * frame is then just its rotation applied to (0, 0, 1) g. Rotating the board
 * also spins the gyro for as long as the drag lasts, which is what a real
 * movement produces — a held tilt reads zero rotation.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getBoardSimulator, getEsp32Bridge } from '../../store/useSimulatorStore';

interface SensorBridge {
  setImuAcceleration?: (x: number, y: number, z: number) => void;
  setImuGyro?: (x: number, y: number, z: number) => void;
  setBatteryVoltage?: (millivolts: number) => void;
}

interface BoardSensorControlsProps {
  boardId: string | null;
  /** Board carries an IMU whose bridge accepts injected motion. */
  showImu: boolean;
  /** Board reads its pack voltage through the bridge. */
  showBattery: boolean;
}

/** Degrees of tilt at the edge of the pad. Past ~80 degrees gravity is nearly
 *  in the plane of the board and the pad stops being a useful way to aim it. */
const MAX_TILT_DEG = 80;
const PAD_PX = 132;

/** LiPo working range: 3.3 V is where M5Unified's UI starts calling it empty,
 *  4.2 V is a full pack straight off the charger. */
const BATT_MIN_MV = 3300;
const BATT_MAX_MV = 4200;

const RAD = Math.PI / 180;

/**
 * Gravity in the board's frame for a given roll (Y tilt) and pitch (X tilt).
 * Flat is (0, 0, 1) g; rolling right pushes gravity onto -X, pitching forward
 * onto +Y — the sign convention M5Unified reports for this part, so a sketch
 * written against the real board reads the same numbers here.
 */
export function gravityFor(rollDeg: number, pitchDeg: number): [number, number, number] {
  const r = rollDeg * RAD;
  const p = pitchDeg * RAD;
  return [-Math.sin(r) * Math.cos(p), Math.sin(p), Math.cos(r) * Math.cos(p)];
}

export const BoardSensorControls: React.FC<BoardSensorControlsProps> = ({
  boardId,
  showImu,
  showBattery,
}) => {
  const [open, setOpen] = useState(false);
  const [roll, setRoll] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [batteryMv, setBatteryMv] = useState(4000);
  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  /** Previous angles + timestamp, so a drag can be turned into a rotation rate. */
  const lastRef = useRef<{ roll: number; pitch: number; t: number } | null>(null);
  const gyroStopRef = useRef<number | null>(null);

  /**
   * Where the tilt and battery go.
   *
   * The ESP32 bridge first, because that is what most boards with an IMU run
   * on. But a board can carry one without being an ESP32 - an overlay board
   * emulated in the browser has a simulator, not a bridge - and resolving only
   * the bridge rendered the pad and the slider for those boards and sent their
   * values nowhere. So: whichever of the two implements the method, chosen by
   * asking rather than by a list of board kinds.
   */
  const bridge = useCallback(() => {
    if (!boardId) return undefined;
    const esp32 = getEsp32Bridge(boardId) as SensorBridge | undefined;
    if (typeof esp32?.setImuAcceleration === 'function' || typeof esp32?.setBatteryVoltage === 'function') {
      return esp32;
    }
    const sim = getBoardSimulator(boardId) as SensorBridge | undefined;
    if (typeof sim?.setImuAcceleration === 'function' || typeof sim?.setBatteryVoltage === 'function') {
      return sim;
    }
    return esp32;
  }, [boardId]);

  // Push the current attitude whenever it changes — including on mount and on
  // every re-run, since a fresh bridge starts back at flat-on-table.
  useEffect(() => {
    if (!showImu) return;
    const [x, y, z] = gravityFor(roll, pitch);
    bridge()?.setImuAcceleration?.(x, y, z);
  }, [roll, pitch, showImu, bridge]);

  useEffect(() => {
    if (!showBattery) return;
    bridge()?.setBatteryVoltage?.(batteryMv);
  }, [batteryMv, showBattery, bridge]);

  // A rotation rate only exists while the board is actually being turned. The
  // timer parks the gyro back at zero shortly after the drag stops, which is
  // what a real part reports once the movement ends.
  const spinGyro = useCallback(
    (nextRoll: number, nextPitch: number) => {
      const now = performance.now();
      const last = lastRef.current;
      lastRef.current = { roll: nextRoll, pitch: nextPitch, t: now };
      if (!last) return;
      const dt = Math.max(1, now - last.t) / 1000;
      const gx = (nextPitch - last.pitch) / dt;
      const gy = (nextRoll - last.roll) / dt;
      bridge()?.setImuGyro?.(gx, gy, 0);
      if (gyroStopRef.current !== null) window.clearTimeout(gyroStopRef.current);
      gyroStopRef.current = window.setTimeout(() => {
        bridge()?.setImuGyro?.(0, 0, 0);
        lastRef.current = null;
      }, 150);
    },
    [bridge],
  );

  useEffect(
    () => () => {
      if (gyroStopRef.current !== null) window.clearTimeout(gyroStopRef.current);
    },
    [],
  );

  const applyPointer = useCallback(
    (clientX: number, clientY: number) => {
      const pad = padRef.current;
      if (!pad) return;
      const r = pad.getBoundingClientRect();
      // Clamp to the pad: a drag that leaves the box keeps tilting to the edge
      // rather than snapping back to centre.
      const nx = Math.max(-1, Math.min(1, ((clientX - r.left) / r.width) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, ((clientY - r.top) / r.height) * 2 - 1));
      const nextRoll = Math.round(nx * MAX_TILT_DEG);
      const nextPitch = Math.round(ny * MAX_TILT_DEG);
      setRoll(nextRoll);
      setPitch(nextPitch);
      spinGyro(nextRoll, nextPitch);
    },
    [spinGyro],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    applyPointer(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (draggingRef.current) applyPointer(e.clientX, e.clientY);
  };
  const onPointerUp = () => {
    draggingRef.current = false;
  };

  const resetTilt = () => {
    setRoll(0);
    setPitch(0);
    lastRef.current = null;
    bridge()?.setImuGyro?.(0, 0, 0);
  };

  const [ax, ay, az] = gravityFor(roll, pitch);
  const dotX = (roll / MAX_TILT_DEG) * (PAD_PX / 2 - 10);
  const dotY = (pitch / MAX_TILT_DEG) * (PAD_PX / 2 - 10);
  const battPct = Math.round(((batteryMv - BATT_MIN_MV) / (BATT_MAX_MV - BATT_MIN_MV)) * 100);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!boardId}
        title="Tilt the board and set its battery level (simulation inputs)"
        style={{
          backgroundColor: open ? 'rgba(88,166,255,0.15)' : 'transparent',
          border: `1px solid ${open ? '#58a6ff' : 'transparent'}`,
          borderRadius: 4,
          padding: '4px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: open ? '#58a6ff' : 'var(--wb-12)',
          fontSize: 13,
          cursor: boardId ? 'pointer' : 'not-allowed',
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M15.5 8.5l-2 5-5 2 2-5z" />
        </svg>
        <span>Sensors</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 40,
            background: 'var(--wb-5)',
            border: '1px solid var(--wb-6)',
            borderRadius: 6,
            padding: 12,
            width: 200,
            boxShadow: 'var(--shadow-3)',
            color: 'var(--wb-12)',
            fontSize: 12,
          }}
        >
          {showImu && (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginBottom: 6,
                }}
              >
                <strong style={{ fontSize: 12 }}>Tilt</strong>
                <button
                  onClick={resetTilt}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-action-primary)',
                    cursor: 'pointer',
                    fontSize: 11,
                    padding: 0,
                  }}
                >
                  flat
                </button>
              </div>
              <div
                ref={padRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={{
                  position: 'relative',
                  width: PAD_PX,
                  height: PAD_PX,
                  margin: '0 auto',
                  borderRadius: '50%',
                  border: '1px solid var(--wb-6)',
                  background:
                    'radial-gradient(circle at 50% 50%, var(--wb-4) 0%, var(--wb-3) 60%, var(--wb-2) 100%)',
                  cursor: 'grab',
                  touchAction: 'none',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 14,
                    height: 14,
                    marginLeft: -7 + dotX,
                    marginTop: -7 + dotY,
                    borderRadius: '50%',
                    background: '#58a6ff',
                    boxShadow: '0 0 8px rgba(88,166,255,0.6)',
                  }}
                />
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: 'var(--wb-11)',
                  textAlign: 'center',
                }}
              >
                {ax.toFixed(2)} / {ay.toFixed(2)} / {az.toFixed(2)} g
              </div>
            </>
          )}

          {showBattery && (
            <div style={{ marginTop: showImu ? 12 : 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <strong style={{ fontSize: 12 }}>Battery</strong>
                <span style={{ fontFamily: 'monospace', color: 'var(--wb-11)' }}>
                  {batteryMv} mV - {battPct}%
                </span>
              </div>
              <input
                type="range"
                min={BATT_MIN_MV}
                max={BATT_MAX_MV}
                step={10}
                value={batteryMv}
                onChange={(e) => setBatteryMv(Number(e.target.value))}
                style={{ width: '100%' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

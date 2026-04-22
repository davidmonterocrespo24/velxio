import React from 'react';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';

const BOARD_DESCRIPTIONS: Record<BoardKind, string> = {
  'arduino-uno': '8-bit AVR, 32KB flash, 14 digital I/O',
  'arduino-nano': 'Compact 8-bit AVR, same as Uno',
  'arduino-mega': '8-bit AVR, 256KB flash, 54 digital I/O',
  'raspberry-pi-pico': 'RP2040 dual-core Cortex-M0+',
  'raspberry-pi-3': 'ARM64 Cortex-A53 quad-core, Linux/Python (QEMU)',
  esp32: 'Xtensa LX6 dual-core, WiFi+BT, 38 GPIO (QEMU)',
  'esp32-s3': 'Xtensa LX7 dual-core, WiFi+BT, AI accel (QEMU)',
  'esp32-c3': 'RISC-V single-core, WiFi+BLE, 22 GPIO (QEMU)',
};

const BOARD_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
};

interface BoardPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectBoard: (kind: BoardKind) => void;
}

const BOARDS: BoardKind[] = [
  'arduino-uno',
  'arduino-nano',
  'arduino-mega',
  'raspberry-pi-pico',
  'raspberry-pi-3',
  'esp32',
  'esp32-s3',
  'esp32-c3',
];

export const BoardPickerModal = ({ isOpen, onClose, onSelectBoard }: BoardPickerModalProps) => {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#1e1e1e',
          border: '1px solid #444',
          borderRadius: 8,
          padding: 24,
          minWidth: 380,
          maxWidth: 480,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ color: '#ccc', margin: '0 0 16px 0', fontSize: 16 }}>Add Board</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {BOARDS.map((kind) => (
            <button
              key={kind}
              onClick={() => {
                onSelectBoard(kind);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                background: '#2d2d2d',
                border: '1px solid #555',
                borderRadius: 6,
                cursor: 'pointer',
                color: '#ddd',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#3a3a3a')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#2d2d2d')}
            >
              <span
                style={{
                  fontSize: 20,
                  width: 28,
                  textAlign: 'center',
                  color: kind.startsWith('raspberry')
                    ? '#c22'
                    : kind.startsWith('esp')
                      ? '#e8a020'
                      : '#4af',
                }}
              >
                {BOARD_ICON[kind]}
              </span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{BOARD_KIND_LABELS[kind]}</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                  {BOARD_DESCRIPTIONS[kind]}
                </div>
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={onClose}
          style={{
            marginTop: 16,
            padding: '6px 14px',
            background: 'transparent',
            border: '1px solid #555',
            borderRadius: 4,
            color: '#888',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

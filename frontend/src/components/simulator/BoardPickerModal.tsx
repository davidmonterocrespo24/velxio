import { BoardFallbackIcon } from '../ui/CustomIcons';
import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';

/** Neutral chip glyph for overlay-registered boards without a bespoke icon. */
const PRO_FALLBACK_ICON = (
  <BoardFallbackIcon />
);


const BOARD_DESCRIPTIONS: Record<BoardKind, string> = {
  'arduino-uno': '8-bit AVR, 32KB flash, 14 digital I/O',
  'arduino-nano': 'Compact 8-bit AVR, same as Uno',
  'arduino-mega': '8-bit AVR, 256KB flash, 54 digital I/O',
  'raspberry-pi-pico': 'RP2040 dual-core Cortex-M0+',
  'raspberry-pi-3': 'ARM64 Cortex-A53 quad-core, Linux/Python (QEMU)',
  'raspberry-pi-4': 'ARM64 Cortex-A72 quad-core, Linux/Python (QEMU)',
  'raspberry-pi-5': 'ARM64 Cortex-A76 quad-core + RP1 I/O, Linux/Python (QEMU)',
  esp32: 'Xtensa LX6 dual-core, WiFi+BT, 38 GPIO (QEMU)',
  'esp32-s3': 'Xtensa LX7 dual-core, WiFi+BT, AI accel (QEMU)',
  'esp32-c3': 'RISC-V single-core, WiFi+BLE, 22 GPIO (QEMU)',
  'stm32-bluepill': 'STM32F103C8 Cortex-M3, 64KB flash, 37 GPIO (QEMU)',
  'stm32-blackpill': 'STM32F411CE Cortex-M4, 512KB flash, 50 GPIO (QEMU)',
};

const BOARD_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  'raspberry-pi-4': '⬛',
  'raspberry-pi-5': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
  'stm32-bluepill': '◈',
  'stm32-blackpill': '◈',
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
  'raspberry-pi-4',
  'raspberry-pi-5',
  'esp32',
  'esp32-s3',
  'esp32-c3',
  'stm32-bluepill',
  'stm32-blackpill',
];

export const BoardPickerModal = ({ isOpen, onClose, onSelectBoard }: BoardPickerModalProps) => {
  const { t } = useTranslation();
  if (!isOpen) return null;

  // Portal to <body>: escape the canvas subtree so no ancestor stacking
  // context can pin the dialog below floating panels (e.g. the AI chat).
  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Above every floating panel, including the pro AI chat (8000/8001).
        zIndex: 9000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--wb-2)',
          border: '1px solid var(--wb-7)',
          borderRadius: 8,
          padding: 24,
          minWidth: 380,
          maxWidth: 480,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ color: 'var(--wb-12)', margin: '0 0 16px 0', fontSize: 16 }}>{t('editor.boardPicker.title')}</h3>

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
                background: 'var(--wb-5)',
                border: '1px solid var(--wb-8)',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--wb-12)',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--wb-7)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--wb-5)')}
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
                {BOARD_ICON[kind] ?? PRO_FALLBACK_ICON}
              </span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{BOARD_KIND_LABELS[kind]}</div>
                <div style={{ fontSize: 11, color: 'var(--wb-10)', marginTop: 2 }}>
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
            border: '1px solid var(--wb-8)',
            borderRadius: 4,
            color: 'var(--wb-10)',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body
  );
};

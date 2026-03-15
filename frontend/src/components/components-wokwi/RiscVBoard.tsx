/**
 * RISC-V Board visual component — CH32V003F4P6 SOP-20 style.
 *
 * Renders a minimal chip outline with:
 * - 10 pins on each side (PA0-PA7, PC0-PC1 left; PC2-PC7, PD0-PD5 right)
 * - Built-in LED on PD6 (common test LED on CH32V003 eval boards)
 * - Green accent color distinct from Arduino blue
 */

interface RiscVBoardProps {
  id?: string;
  x?: number;
  y?: number;
  /** PD6 state — built-in LED */
  ledBuiltIn?: boolean;
}

const W  = 200;
const H  = 140;
const BX = 40;
const BY = 10;
const BW = 120;
const BH = 120;
const PIN_LEN = 34;
const PIN_SPACING = 12;
const PINS_PER_SIDE = 10;

// Y positions for 10 pins, centred in the body
const PIN_Y = Array.from({ length: PINS_PER_SIDE }, (_, i) => BY + 5 + i * PIN_SPACING);

// Left-side labels (top → bottom): PA0-PA7, PC0, PC1
const LEFT_LABELS  = ['PA0','PA1','PA2','PA3','PA4','PA5','PA6','PA7','PC0','PC1'];
// Right-side labels (top → bottom): PC2-PC7, PD0-PD5
const RIGHT_LABELS = ['PC2','PC3','PC4','PC5','PC6','PC7','PD0','PD1','PD2','PD3'];

export const RiscVBoard = ({
  id = 'riscv-generic',
  x = 0,
  y = 0,
  ledBuiltIn = false,
}: RiscVBoardProps) => {
  return (
    <svg
      id={id}
      style={{ position: 'absolute', left: x, top: y, overflow: 'visible' }}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
    >
      {/* Pin stubs — left side */}
      {PIN_Y.map((py, i) => (
        <line
          key={`lp-${i}`}
          x1={BX} y1={py}
          x2={BX - PIN_LEN} y2={py}
          stroke="#5a9a5a"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      ))}

      {/* Pin stubs — right side */}
      {PIN_Y.map((py, i) => (
        <line
          key={`rp-${i}`}
          x1={BX + BW} y1={py}
          x2={BX + BW + PIN_LEN} y2={py}
          stroke="#5a9a5a"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      ))}

      {/* IC body */}
      <rect
        x={BX} y={BY}
        width={BW} height={BH}
        rx={5} ry={5}
        fill="#0d1f0d"
        stroke="#2d6a2d"
        strokeWidth="1.5"
      />

      {/* Orientation notch */}
      <path
        d={`M${BX + BW / 2 - 8} ${BY} A8 8 0 0 1 ${BX + BW / 2 + 8} ${BY}`}
        fill="none"
        stroke="#2d6a2d"
        strokeWidth="1.5"
      />

      {/* Pin 1 dot */}
      <circle cx={BX + 8} cy={BY + BH - 8} r={2.5} fill="#3a7a3a" />

      {/* Chip label */}
      <text
        x={BX + BW / 2}
        y={BY + BH / 2 - 10}
        fontSize="9"
        fontWeight="bold"
        fontFamily="monospace"
        fill="#7acc7a"
        textAnchor="middle"
      >
        CH32V003
      </text>
      <text
        x={BX + BW / 2}
        y={BY + BH / 2 + 4}
        fontSize="7.5"
        fontFamily="monospace"
        fill="#4a8a4a"
        textAnchor="middle"
      >
        RISC-V RV32EC
      </text>
      <text
        x={BX + BW / 2}
        y={BY + BH / 2 + 16}
        fontSize="7"
        fontFamily="monospace"
        fill="#3a7a3a"
        textAnchor="middle"
      >
        48 MHz · 16K Flash
      </text>

      {/* Built-in LED (PD6) — right side below body */}
      <circle
        cx={BX + BW + PIN_LEN + 8}
        cy={BY + BH + 10}
        r={5}
        fill={ledBuiltIn ? '#44ff44' : '#1a3a1a'}
        stroke={ledBuiltIn ? '#22cc22' : '#2d4a2d'}
        strokeWidth="1"
        style={{ filter: ledBuiltIn ? 'drop-shadow(0 0 5px #44ff44)' : 'none' }}
      />
      <text
        x={BX + BW + PIN_LEN + 18}
        y={BY + BH + 14}
        fontSize="6"
        fontFamily="monospace"
        fill="#4a8a4a"
        textAnchor="start"
      >
        PD6
      </text>

      {/* Pin labels — left */}
      {LEFT_LABELS.map((label, i) => (
        <text
          key={`ll-${i}`}
          x={BX - PIN_LEN - 3}
          y={PIN_Y[i] + 3}
          fontSize="6.5"
          fontFamily="monospace"
          fill="#5aaa5a"
          textAnchor="end"
        >
          {label}
        </text>
      ))}

      {/* Pin labels — right */}
      {RIGHT_LABELS.map((label, i) => (
        <text
          key={`rl-${i}`}
          x={BX + BW + PIN_LEN + 4}
          y={PIN_Y[i] + 3}
          fontSize="6.5"
          fontFamily="monospace"
          fill="#5aaa5a"
          textAnchor="start"
        >
          {label}
        </text>
      ))}
    </svg>
  );
};

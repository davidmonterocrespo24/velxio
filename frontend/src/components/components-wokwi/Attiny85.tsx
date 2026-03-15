/**
 * ATtiny85 visual component — DIP-8 package (Digispark-style layout)
 *
 * Pin layout (DIP-8):
 *   Left side (top to bottom):  PB5/RST, PB3, PB4, GND
 *   Right side (bottom to top): PB0, PB1, PB2, VCC
 *
 * Built-in LED on PB1 (standard Digispark LED pin).
 */

interface Attiny85Props {
  id?: string;
  x?: number;
  y?: number;
  /** State of PB1 (built-in LED pin on Digispark) */
  led1?: boolean;
}

// DIP-8 dimensions
const W = 160;   // total SVG width
const H = 100;   // total SVG height
const BX = 30;   // chip body left
const BY = 10;   // chip body top
const BW = 100;  // chip body width
const BH = 80;   // chip body height
const PIN_W = 28; // pin stub length (horizontal)
const PIN_SPACING = 20; // vertical spacing between pins

// 4 pins on each side, centred vertically in the body
const PIN_STARTS_Y = [BY + 10, BY + 30, BY + 50, BY + 70];

const PIN_LABELS_LEFT  = ['PB5/RST', 'PB3', 'PB4', 'GND'];
const PIN_LABELS_RIGHT = ['VCC', 'PB2', 'PB1', 'PB0'];

export const Attiny85 = ({
  id = 'attiny85',
  x = 0,
  y = 0,
  led1 = false,
}: Attiny85Props) => {
  return (
    <svg
      id={id}
      style={{ position: 'absolute', left: x, top: y, overflow: 'visible' }}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
    >
      {/* Pin stubs — left side */}
      {PIN_STARTS_Y.map((py, i) => (
        <line
          key={`lpin-${i}`}
          x1={BX} y1={py}
          x2={BX - PIN_W} y2={py}
          stroke="#aaa"
          strokeWidth="3"
          strokeLinecap="round"
        />
      ))}

      {/* Pin stubs — right side (reversed: bottom=PB0) */}
      {PIN_STARTS_Y.map((py, i) => (
        <line
          key={`rpin-${i}`}
          x1={BX + BW} y1={py}
          x2={BX + BW + PIN_W} y2={py}
          stroke="#aaa"
          strokeWidth="3"
          strokeLinecap="round"
        />
      ))}

      {/* IC body */}
      <rect
        x={BX} y={BY}
        width={BW} height={BH}
        rx={4} ry={4}
        fill="#1a1a2e"
        stroke="#4a4a7a"
        strokeWidth="1.5"
      />

      {/* Orientation notch (top centre of body) */}
      <path
        d={`M${BX + BW / 2 - 7} ${BY} A7 7 0 0 1 ${BX + BW / 2 + 7} ${BY}`}
        fill="none"
        stroke="#4a4a7a"
        strokeWidth="1.5"
      />

      {/* Pin 1 dot (bottom-left corner of body → PB5/RST) */}
      <circle cx={BX + 8} cy={BY + BH - 8} r={2.5} fill="#7a7aaa" />

      {/* Chip label */}
      <text
        x={BX + BW / 2}
        y={BY + BH / 2 - 8}
        fontSize="10"
        fontWeight="bold"
        fontFamily="monospace"
        fill="#c8c8f0"
        textAnchor="middle"
      >
        ATtiny85
      </text>
      <text
        x={BX + BW / 2}
        y={BY + BH / 2 + 8}
        fontSize="8"
        fontFamily="monospace"
        fill="#7a7aaa"
        textAnchor="middle"
      >
        8-bit AVR
      </text>

      {/* Built-in LED (PB1) — right side, 3rd pin from top = index 2 reversed */}
      {/* Right pins are bottom-to-top: index 3=PB0, 2=PB1, 1=PB2, 0=VCC */}
      <circle
        cx={BX + BW + PIN_W + 6}
        cy={PIN_STARTS_Y[2]}
        r={5}
        fill={led1 ? '#ffee44' : '#333'}
        stroke={led1 ? '#ffcc00' : '#555'}
        strokeWidth="1"
        style={{ filter: led1 ? 'drop-shadow(0 0 4px #ffcc00)' : 'none' }}
      />

      {/* Pin labels — left */}
      {PIN_LABELS_LEFT.map((label, i) => (
        <text
          key={`ll-${i}`}
          x={BX - PIN_W - 2}
          y={PIN_STARTS_Y[i] + 4}
          fontSize="7"
          fontFamily="monospace"
          fill={label === 'GND' ? '#888' : '#aac'}
          textAnchor="end"
        >
          {label}
        </text>
      ))}

      {/* Pin labels — right */}
      {PIN_LABELS_RIGHT.map((label, i) => (
        <text
          key={`rl-${i}`}
          x={BX + BW + PIN_W + 14}
          y={PIN_STARTS_Y[i] + 4}
          fontSize="7"
          fontFamily="monospace"
          fill={label === 'VCC' ? '#888' : label === 'PB1' ? '#ffdd88' : '#aac'}
          textAnchor="start"
        >
          {label}
        </text>
      ))}
    </svg>
  );
};

/**
 * InlineComponentSVGs — simple schematic-style icons for the components
 * whose SVG isn't pre-rendered into /component-svgs/ (transistors, MOSFETs,
 * diodes, capacitors, relays, optocouplers, op-amps, logic gates, signal
 * generators, batteries, regulators, motor drivers, etc.).
 *
 * Used by CircuitPreview.tsx to keep the /examples gallery cards visually
 * representative even for parts that weren't extracted from wokwi-elements.
 *
 * Each renderer receives {w, h} (canvas-space size) and fills its box with
 * a recognizable schematic glyph. Sizes chosen to match the on-canvas size
 * of the corresponding custom web component, so bounding boxes line up.
 */
import React from 'react';

interface InlineSVGProps {
  w: number;
  h: number;
}

// ─── Transistors ───────────────────────────────────────────────────────────
const BjtNpn: React.FC<InlineSVGProps> = ({ w, h }) => (
  <svg width={w} height={h} viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
    <circle cx="36" cy="36" r="24" fill="#f6f1e8" stroke="#555" strokeWidth="1" />
    <line x1="0" y1="36" x2="22" y2="36" stroke="#555" strokeWidth="2" />
    <line x1="22" y1="20" x2="22" y2="52" stroke="#222" strokeWidth="3" />
    <line x1="22" y1="24" x2="44" y2="6" stroke="#222" strokeWidth="2" />
    <line x1="44" y1="6" x2="60" y2="6" stroke="#555" strokeWidth="2" />
    <line x1="22" y1="48" x2="44" y2="66" stroke="#222" strokeWidth="2" />
    <line x1="44" y1="66" x2="60" y2="66" stroke="#555" strokeWidth="2" />
    <polygon points="40,60 44,66 36,65" fill="#222" />
    <text x="50" y="40" fontSize="8" fill="#333">
      NPN
    </text>
  </svg>
);

const BjtPnp: React.FC<InlineSVGProps> = ({ w, h }) => (
  <svg width={w} height={h} viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
    <circle cx="36" cy="36" r="24" fill="#f6f1e8" stroke="#555" strokeWidth="1" />
    <line x1="0" y1="36" x2="22" y2="36" stroke="#555" strokeWidth="2" />
    <line x1="22" y1="20" x2="22" y2="52" stroke="#222" strokeWidth="3" />
    <line x1="22" y1="24" x2="44" y2="6" stroke="#222" strokeWidth="2" />
    <line x1="44" y1="6" x2="60" y2="6" stroke="#555" strokeWidth="2" />
    <line x1="22" y1="48" x2="44" y2="66" stroke="#222" strokeWidth="2" />
    <line x1="44" y1="66" x2="60" y2="66" stroke="#555" strokeWidth="2" />
    <polygon points="26,28 22,24 32,26" fill="#222" />
    <text x="50" y="40" fontSize="8" fill="#333">
      PNP
    </text>
  </svg>
);

const Mosfet: React.FC<InlineSVGProps> = ({ w, h }) => (
  <svg width={w} height={h} viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
    <circle cx="36" cy="36" r="24" fill="#f6f1e8" stroke="#555" strokeWidth="1" />
    <line x1="0" y1="36" x2="20" y2="36" stroke="#555" strokeWidth="2" />
    <line x1="20" y1="22" x2="20" y2="50" stroke="#222" strokeWidth="2" />
    <line x1="24" y1="20" x2="24" y2="32" stroke="#222" strokeWidth="3" />
    <line x1="24" y1="40" x2="24" y2="52" stroke="#222" strokeWidth="3" />
    <line x1="24" y1="26" x2="48" y2="8" stroke="#222" strokeWidth="2" />
    <line x1="48" y1="8" x2="60" y2="8" stroke="#555" strokeWidth="2" />
    <line x1="24" y1="46" x2="48" y2="64" stroke="#222" strokeWidth="2" />
    <line x1="48" y1="64" x2="60" y2="64" stroke="#555" strokeWidth="2" />
    <polygon points="32,40 28,36 32,32" fill="#222" />
    <text x="46" y="42" fontSize="8" fill="#333">
      MOS
    </text>
  </svg>
);

// ─── Diodes ────────────────────────────────────────────────────────────────
function diodeGlyph(label: string, w: number, h: number): React.ReactElement {
  return (
    <svg width={w} height={h} viewBox="0 0 72 40" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="14"
        y="12"
        width="44"
        height="16"
        rx="2"
        fill="#2a2a2a"
        stroke="#111"
        strokeWidth="1"
      />
      <rect x="18" y="12" width="4" height="16" fill="#eee" />
      <line x1="0" y1="20" x2="14" y2="20" stroke="#888" strokeWidth="2" />
      <line x1="58" y1="20" x2="72" y2="20" stroke="#888" strokeWidth="2" />
      <text x="36" y="25" fontSize="8" fill="#eee" textAnchor="middle" fontFamily="sans-serif">
        {label}
      </text>
    </svg>
  );
}
const Diode1N4007: React.FC<InlineSVGProps> = ({ w, h }) => diodeGlyph('1N4007', w, h);
const Diode1N5817: React.FC<InlineSVGProps> = ({ w, h }) => diodeGlyph('1N5817', w, h);
const DiodeZener: React.FC<InlineSVGProps> = ({ w, h }) => diodeGlyph('ZD', w, h);

// ─── Passives ──────────────────────────────────────────────────────────────
const Capacitor: React.FC<InlineSVGProps> = ({ w, h }) => (
  <svg width={w} height={h} viewBox="0 0 56 36" xmlns="http://www.w3.org/2000/svg">
    <line x1="0" y1="18" x2="22" y2="18" stroke="#555" strokeWidth="2" />
    <line x1="34" y1="18" x2="56" y2="18" stroke="#555" strokeWidth="2" />
    <line x1="22" y1="6" x2="22" y2="30" stroke="#222" strokeWidth="3" />
    <line x1="34" y1="6" x2="34" y2="30" stroke="#222" strokeWidth="3" />
    <text x="28" y="34" fontSize="6" fill="#666" textAnchor="middle">
      C
    </text>
  </svg>
);

// ─── Relay ─────────────────────────────────────────────────────────────────
const Relay: React.FC<InlineSVGProps> = ({ w, h }) => (
  <svg width={w} height={h} viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
    <rect
      x="10"
      y="8"
      width="76"
      height="80"
      rx="4"
      fill="#f8f4ee"
      stroke="#2a2a2a"
      strokeWidth="1.5"
    />
    <line x1="0" y1="16" x2="18" y2="16" stroke="#555" strokeWidth="2" />
    <line x1="0" y1="80" x2="18" y2="80" stroke="#555" strokeWidth="2" />
    <line x1="22" y1="16" x2="22" y2="80" stroke="#8a5a00" strokeWidth="1.5" />
    {[24, 34, 44, 54, 64, 74].map((cy) => (
      <circle key={cy} cx="22" cy={cy} r="3" fill="none" stroke="#8a5a00" strokeWidth="1.5" />
    ))}
    <line x1="60" y1="48" x2="80" y2="48" stroke="#555" strokeWidth="2" />
    <line x1="72" y1="20" x2="86" y2="16" stroke="#2a2a2a" strokeWidth="2" />
    <line x1="86" y1="16" x2="96" y2="16" stroke="#555" strokeWidth="2" />
    <line x1="86" y1="80" x2="96" y2="80" stroke="#555" strokeWidth="2" />
    <text x="48" y="54" textAnchor="middle" fontSize="9" fill="#333" fontWeight="bold">
      RELAY
    </text>
  </svg>
);

// ─── Optocoupler ───────────────────────────────────────────────────────────
function optoGlyph(label: string, w: number, h: number): React.ReactElement {
  return (
    <svg width={w} height={h} viewBox="0 0 80 64" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="10"
        y="8"
        width="60"
        height="48"
        rx="3"
        fill="#f8f4ee"
        stroke="#2a2a2a"
        strokeWidth="1.5"
      />
      <line
        x1="40"
        y1="8"
        x2="40"
        y2="56"
        stroke="#2a2a2a"
        strokeWidth="0.8"
        strokeDasharray="2,2"
      />
      <polygon points="18,22 18,38 30,30" fill="#f8f4ee" stroke="#2a2a2a" strokeWidth="1.2" />
      <line x1="30" y1="22" x2="30" y2="38" stroke="#2a2a2a" strokeWidth="1.5" />
      <line x1="46" y1="20" x2="46" y2="40" stroke="#2a2a2a" strokeWidth="2" />
      <line x1="46" y1="25" x2="58" y2="18" stroke="#2a2a2a" strokeWidth="1.2" />
      <line x1="46" y1="35" x2="58" y2="42" stroke="#2a2a2a" strokeWidth="1.2" />
      <line x1="0" y1="16" x2="10" y2="16" stroke="#555" strokeWidth="2" />
      <line x1="0" y1="48" x2="10" y2="48" stroke="#555" strokeWidth="2" />
      <line x1="70" y1="16" x2="80" y2="16" stroke="#555" strokeWidth="2" />
      <line x1="70" y1="48" x2="80" y2="48" stroke="#555" strokeWidth="2" />
      <text x="40" y="62" textAnchor="middle" fontSize="7" fill="#333" fontWeight="bold">
        {label}
      </text>
    </svg>
  );
}
const Opto4N25: React.FC<InlineSVGProps> = ({ w, h }) => optoGlyph('4N25', w, h);

// ─── DIP IC block (motor driver, etc.) ─────────────────────────────────────
function dipGlyph(label: string, w: number, h: number): React.ReactElement {
  return (
    <svg width={w} height={h} viewBox="0 0 100 80" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="10"
        y="4"
        width="80"
        height="72"
        rx="4"
        fill="#1f2937"
        stroke="#eef3fa"
        strokeWidth="1"
      />
      <circle cx="18" cy="12" r="2" fill="#eef3fa" />
      {[12, 20, 28, 36, 44, 52, 60, 68].map((y) => (
        <React.Fragment key={y}>
          <line x1="0" y1={y} x2="10" y2={y} stroke="#bbb" strokeWidth="1.5" />
          <line x1="90" y1={y} x2="100" y2={y} stroke="#bbb" strokeWidth="1.5" />
        </React.Fragment>
      ))}
      <text x="50" y="44" textAnchor="middle" fontSize="10" fill="#e5e7eb" fontWeight="bold">
        {label}
      </text>
    </svg>
  );
}
const MotorDriverL293D: React.FC<InlineSVGProps> = ({ w, h }) => dipGlyph('L293D', w, h);

// ─── Op-amp ────────────────────────────────────────────────────────────────
function opampGlyph(label: string, w: number, h: number): React.ReactElement {
  return (
    <svg width={w} height={h} viewBox="0 0 80 72" xmlns="http://www.w3.org/2000/svg">
      <polygon points="20,8 20,64 66,36" fill="#f8f4ee" stroke="#2a2a2a" strokeWidth="1.5" />
      <line x1="0" y1="22" x2="20" y2="22" stroke="#555" strokeWidth="2" />
      <line x1="0" y1="50" x2="20" y2="50" stroke="#555" strokeWidth="2" />
      <line x1="66" y1="36" x2="80" y2="36" stroke="#555" strokeWidth="2" />
      <text x="26" y="26" fontSize="10" fill="#333" fontWeight="bold">
        −
      </text>
      <text x="26" y="55" fontSize="10" fill="#333" fontWeight="bold">
        +
      </text>
      <text x="40" y="68" textAnchor="middle" fontSize="7" fill="#666">
        {label}
      </text>
    </svg>
  );
}
const OpampLM358: React.FC<InlineSVGProps> = ({ w, h }) => opampGlyph('LM358', w, h);

// ─── Logic gates ───────────────────────────────────────────────────────────
function gateShape(
  shape: 'and' | 'nand' | 'or' | 'nor' | 'xor' | 'xnor' | 'not',
  w: number,
  h: number,
): React.ReactElement {
  const negated = shape === 'nand' || shape === 'nor' || shape === 'xnor' || shape === 'not';
  const exclusive = shape === 'xor' || shape === 'xnor';
  const isOr = shape === 'or' || shape === 'nor' || shape === 'xor' || shape === 'xnor';
  const isNot = shape === 'not';
  const body = isNot ? (
    <polygon points="12,10 12,38 46,24" fill="#f8f4ee" stroke="#2a2a2a" strokeWidth="1.5" />
  ) : isOr ? (
    <path
      d="M 10 8 Q 28 24 10 40 Q 38 40 54 24 Q 38 8 10 8 Z"
      fill="#f8f4ee"
      stroke="#2a2a2a"
      strokeWidth="1.5"
    />
  ) : (
    <path
      d="M 10 8 L 30 8 Q 54 8 54 24 Q 54 40 30 40 L 10 40 Z"
      fill="#f8f4ee"
      stroke="#2a2a2a"
      strokeWidth="1.5"
    />
  );
  return (
    <svg width={w} height={h} viewBox="0 0 72 48" xmlns="http://www.w3.org/2000/svg">
      <line x1="0" y1="16" x2="10" y2="16" stroke="#555" strokeWidth="2" />
      {!isNot && <line x1="0" y1="32" x2="10" y2="32" stroke="#555" strokeWidth="2" />}
      {body}
      {exclusive && <path d="M 4 8 Q 14 24 4 40" fill="none" stroke="#2a2a2a" strokeWidth="1.5" />}
      {negated && (
        <circle
          cx={isNot ? 50 : 58}
          cy="24"
          r="3"
          fill="#f8f4ee"
          stroke="#2a2a2a"
          strokeWidth="1.5"
        />
      )}
      <line
        x1={negated ? (isNot ? 53 : 61) : isNot ? 46 : 54}
        y1="24"
        x2="72"
        y2="24"
        stroke="#555"
        strokeWidth="2"
      />
    </svg>
  );
}
const GateAnd: React.FC<InlineSVGProps> = ({ w, h }) => gateShape('and', w, h);
const GateNand: React.FC<InlineSVGProps> = ({ w, h }) => gateShape('nand', w, h);
const GateOr: React.FC<InlineSVGProps> = ({ w, h }) => gateShape('or', w, h);
const GateNor: React.FC<InlineSVGProps> = ({ w, h }) => gateShape('nor', w, h);
const GateXor: React.FC<InlineSVGProps> = ({ w, h }) => gateShape('xor', w, h);
const GateXnor: React.FC<InlineSVGProps> = ({ w, h }) => gateShape('xnor', w, h);
const GateNot: React.FC<InlineSVGProps> = ({ w, h }) => gateShape('not', w, h);

// ─── Power / instruments ───────────────────────────────────────────────────
function reg3pinGlyph(label: string, w: number, h: number): React.ReactElement {
  return (
    <svg width={w} height={h} viewBox="0 0 72 56" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="8"
        y="8"
        width="56"
        height="40"
        rx="4"
        fill="#2a2a2a"
        stroke="#111"
        strokeWidth="1.5"
      />
      <line x1="20" y1="48" x2="20" y2="56" stroke="#888" strokeWidth="2" />
      <line x1="36" y1="48" x2="36" y2="56" stroke="#888" strokeWidth="2" />
      <line x1="52" y1="48" x2="52" y2="56" stroke="#888" strokeWidth="2" />
      <text x="36" y="32" textAnchor="middle" fontSize="10" fill="#eee" fontWeight="bold">
        {label}
      </text>
    </svg>
  );
}
const Reg7805: React.FC<InlineSVGProps> = ({ w, h }) => reg3pinGlyph('7805', w, h);
const RegLM317: React.FC<InlineSVGProps> = ({ w, h }) => reg3pinGlyph('LM317', w, h);

const Battery9V: React.FC<InlineSVGProps> = ({ w, h }) => (
  <svg width={w} height={h} viewBox="0 0 48 72" xmlns="http://www.w3.org/2000/svg">
    <rect
      x="6"
      y="12"
      width="36"
      height="52"
      rx="3"
      fill="#c9a23a"
      stroke="#7a5e00"
      strokeWidth="1.5"
    />
    <rect x="14" y="4" width="8" height="10" rx="1" fill="#ddd" stroke="#777" strokeWidth="1" />
    <rect x="26" y="4" width="8" height="10" rx="1" fill="#ddd" stroke="#777" strokeWidth="1" />
    <text x="24" y="40" textAnchor="middle" fontSize="12" fill="#3a2d00" fontWeight="bold">
      9V
    </text>
  </svg>
);

const SignalGenerator: React.FC<InlineSVGProps> = ({ w, h }) => (
  <svg width={w} height={h} viewBox="0 0 80 64" xmlns="http://www.w3.org/2000/svg">
    <rect
      x="4"
      y="4"
      width="72"
      height="56"
      rx="5"
      fill="#1f2937"
      stroke="#eef3fa"
      strokeWidth="1.2"
    />
    <rect
      x="10"
      y="10"
      width="60"
      height="20"
      rx="2"
      fill="#061018"
      stroke="#0e8c70"
      strokeWidth="1"
    />
    <path
      d="M 14 20 Q 22 12 30 20 T 46 20 T 62 20"
      fill="none"
      stroke="#4ade80"
      strokeWidth="1.5"
    />
    <circle cx="20" cy="46" r="5" fill="#374151" stroke="#9ca3af" strokeWidth="1" />
    <text x="56" y="50" textAnchor="middle" fontSize="7" fill="#e5e7eb">
      SIG GEN
    </text>
  </svg>
);

function meterGlyph(label: string, w: number, h: number): React.ReactElement {
  return (
    <svg width={w} height={h} viewBox="0 0 72 56" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="2"
        y="2"
        width="68"
        height="52"
        rx="4"
        fill="#111827"
        stroke="#e5e7eb"
        strokeWidth="1.2"
      />
      <rect
        x="8"
        y="8"
        width="56"
        height="22"
        rx="2"
        fill="#0b1220"
        stroke="#22d3ee"
        strokeWidth="1"
      />
      <text x="36" y="24" textAnchor="middle" fontSize="10" fill="#22d3ee" fontFamily="monospace">
        {label}
      </text>
      <line x1="0" y1="48" x2="8" y2="48" stroke="#888" strokeWidth="2" />
      <line x1="64" y1="48" x2="72" y2="48" stroke="#888" strokeWidth="2" />
    </svg>
  );
}
const Voltmeter: React.FC<InlineSVGProps> = ({ w, h }) => meterGlyph('V', w, h);
const Ammeter: React.FC<InlineSVGProps> = ({ w, h }) => meterGlyph('A', w, h);

// ─── Registry ──────────────────────────────────────────────────────────────
interface InlineEntry {
  component: React.FC<InlineSVGProps>;
  w: number;
  h: number;
}

export const INLINE_SVGS: Record<string, InlineEntry> = {
  // BJTs
  'wokwi-bjt-2n2222': { component: BjtNpn, w: 72, h: 72 },
  'wokwi-bjt-2n3904': { component: BjtNpn, w: 72, h: 72 },
  'wokwi-bjt-2n3906': { component: BjtPnp, w: 72, h: 72 },
  'wokwi-bjt-bc547': { component: BjtNpn, w: 72, h: 72 },
  // MOSFETs
  'wokwi-mosfet-2n7000': { component: Mosfet, w: 72, h: 72 },
  'wokwi-mosfet-irf540n': { component: Mosfet, w: 72, h: 72 },
  'wokwi-mosfet-bs170': { component: Mosfet, w: 72, h: 72 },
  // Diodes
  'wokwi-diode': { component: Diode1N4007, w: 72, h: 40 },
  'wokwi-diode-1n4007': { component: Diode1N4007, w: 72, h: 40 },
  'wokwi-diode-1n4148': { component: Diode1N4007, w: 72, h: 40 },
  'wokwi-diode-1n5817': { component: Diode1N5817, w: 72, h: 40 },
  'wokwi-diode-1n5819': { component: Diode1N5817, w: 72, h: 40 },
  'wokwi-zener-1n4733': { component: DiodeZener, w: 72, h: 40 },
  // Passives
  'wokwi-capacitor': { component: Capacitor, w: 56, h: 36 },
  'velxio-capacitor-electrolytic': { component: Capacitor, w: 36, h: 56 },
  'wokwi-inductor': { component: Capacitor, w: 56, h: 36 },
  // Electromechanical
  'velxio-relay': { component: Relay, w: 96, h: 96 },
  // Optocouplers
  'velxio-opto-4n25': { component: Opto4N25, w: 80, h: 64 },
  'velxio-opto-pc817': { component: Opto4N25, w: 80, h: 64 },
  // IC
  'velxio-motor-driver-l293d': { component: MotorDriverL293D, w: 100, h: 80 },
  'wokwi-ic-74hc00': { component: MotorDriverL293D, w: 100, h: 80 },
  'wokwi-ic-74hc04': { component: MotorDriverL293D, w: 100, h: 80 },
  'wokwi-ic-74hc08': { component: MotorDriverL293D, w: 100, h: 80 },
  'wokwi-ic-74hc14': { component: MotorDriverL293D, w: 100, h: 80 },
  'wokwi-ic-74hc32': { component: MotorDriverL293D, w: 100, h: 80 },
  'wokwi-ic-74hc86': { component: MotorDriverL293D, w: 100, h: 80 },
  // Op-amps
  'wokwi-opamp-ideal': { component: OpampLM358, w: 80, h: 72 },
  'wokwi-opamp-lm358': { component: OpampLM358, w: 80, h: 72 },
  'wokwi-opamp-lm741': { component: OpampLM358, w: 80, h: 72 },
  'wokwi-opamp-lm324': { component: OpampLM358, w: 80, h: 72 },
  'wokwi-opamp-tl072': { component: OpampLM358, w: 80, h: 72 },
  // Logic gates — examples use both `velxio-logic-gate-*` and `velxio-logic-*` naming
  'velxio-logic-gate-and': { component: GateAnd, w: 72, h: 48 },
  'velxio-logic-gate-or': { component: GateOr, w: 72, h: 48 },
  'velxio-logic-gate-nand': { component: GateNand, w: 72, h: 48 },
  'velxio-logic-gate-nor': { component: GateNor, w: 72, h: 48 },
  'velxio-logic-gate-xor': { component: GateXor, w: 72, h: 48 },
  'velxio-logic-gate-xnor': { component: GateXnor, w: 72, h: 48 },
  'velxio-logic-gate-not': { component: GateNot, w: 72, h: 48 },
  'velxio-logic-and': { component: GateAnd, w: 72, h: 48 },
  'velxio-logic-or': { component: GateOr, w: 72, h: 48 },
  'velxio-logic-nand': { component: GateNand, w: 72, h: 48 },
  'velxio-logic-nor': { component: GateNor, w: 72, h: 48 },
  'velxio-logic-xor': { component: GateXor, w: 72, h: 48 },
  'velxio-logic-xnor': { component: GateXnor, w: 72, h: 48 },
  'velxio-logic-not': { component: GateNot, w: 72, h: 48 },
  // Power
  'wokwi-reg-7805': { component: Reg7805, w: 72, h: 56 },
  'wokwi-reg-7812': { component: Reg7805, w: 72, h: 56 },
  'wokwi-reg-7905': { component: Reg7805, w: 72, h: 56 },
  'wokwi-reg-lm317': { component: RegLM317, w: 72, h: 56 },
  'wokwi-battery-9v': { component: Battery9V, w: 48, h: 72 },
  'wokwi-battery-aa': { component: Battery9V, w: 48, h: 72 },
  'wokwi-signal-generator': { component: SignalGenerator, w: 80, h: 64 },
  // Instruments
  'velxio-instr-voltmeter': { component: Voltmeter, w: 72, h: 56 },
  'velxio-instr-ammeter': { component: Ammeter, w: 72, h: 56 },
};

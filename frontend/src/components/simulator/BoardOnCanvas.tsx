import React from 'react';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { isBoardSeated } from '../../utils/socketSnap';
import { getProBoard } from '../../lib/proBoardRegistry';
import type { BoardInstance, BoardLedVisuals } from '../../types/board';
import { ArduinoUno } from '../velxio-components/ArduinoUno';
import { ArduinoNano } from '../velxio-components/ArduinoNano';
import { ArduinoMega } from '../velxio-components/ArduinoMega';
// NanoRP2040 (wokwi-nano-rp2040-connect) used to back the 'raspberry-pi-pico'
// boardKind by mistake — kept the import out so future contributors don't
// re-wire it back in. If someone genuinely needs a Nano RP2040 Connect
// board (D2..D13 labels), add a new boardKind 'arduino-nano-rp2040'.
import { RaspberryPiZero } from '../velxio-components/RaspberryPiZero';
import { RaspberryPi1 } from '../velxio-components/RaspberryPi1';
import { RaspberryPi2 } from '../velxio-components/RaspberryPi2';
import { RaspberryPi3 } from '../velxio-components/RaspberryPi3';
import { RaspberryPi4 } from '../velxio-components/RaspberryPi4';
import { RaspberryPi5 } from '../velxio-components/RaspberryPi5';
import { Esp32 } from '../velxio-components/Esp32';
import { Attiny85 } from '../velxio-components/Attiny85';
import { PiPicoW } from '../velxio-components/PiPicoW';
import {
  Stm32BluePill,
  Stm32BlackPill,
  Stm32BluePillF103CB,
  Stm32BlackPillF401,
  Stm32F4Discovery,
  Stm32OlimexH405,
  Stm32NetduinoPlus2,
  Stm32Netduino2,
} from '../velxio-components/Stm32BluePill';
import { PinOverlay } from './PinOverlay';

// The size table lives in utils/boardGeometry (the store needs it too, for
// rotated pin positions); re-exported for existing importers.
export { BOARD_SIZE } from '../../utils/boardGeometry';
import { boardBox, boardSize, normalizeRotation } from '../../utils/boardGeometry';

interface BoardOnCanvasProps {
  board: BoardInstance;
  running: boolean;
  /** The on-board LEDs' visual state, keyed by LED id (BOARD_ONBOARD_LEDS),
   * polarity already applied: `led: true` is a lit user LED. */
  onboardLeds?: BoardLedVisuals;
  isActive?: boolean;
  /** When false, the pin overlay is hidden — keeps the canvas uncluttered when
   * the user isn't hovering, isn't selecting, and isn't actively wiring. */
  showPins?: boolean;
  /** True while a wire is in progress — forwarded to PinOverlay so dense
   * boards paint every square (they're all valid wire targets). */
  wiring?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPinClick: (componentId: string, pinName: string, x: number, y: number) => void;
  zoom?: number;
}

export const BoardOnCanvas = ({
  board,
  running,
  onboardLeds,
  isActive = false,
  showPins = true,
  wiring = false,
  onMouseDown,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  onPinClick,
  zoom = 1,
}: BoardOnCanvasProps) => {
  const { id, boardKind, x, y } = board;
  // The AVR elements take one boolean for their single LED.
  const led13 = onboardLeds?.led === true;
  const size = boardSize(boardKind);
  const rotation = normalizeRotation(board.rotation);
  // Canvas-space box of the rotated board (status dot anchors to it).
  const box = boardBox(board);
  // Seated on a socket component (Round Display back header)? Decides the
  // stacking below. Recomputed on every position change; the check is a few
  // pad lookups over the component list, cheap at render rate.
  const components = useSimulatorStore((st) => st.components);
  // The seat check reads pinInfo/boardSocket off DOM elements; on the FIRST
  // render neither this board nor the socket component is mounted yet, so
  // the memo would freeze on "not seated" for an example that OPENS with the
  // board already stacked. Re-check after mount, twice: next frame, and once
  // more after custom-element upgrade has had time to land.
  const [seatEpoch, setSeatEpoch] = React.useState(0);
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => setSeatEpoch((n) => n + 1));
    const t = setTimeout(() => setSeatEpoch((n) => n + 1), 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, []);
  const seated = React.useMemo(
    () => isBoardSeated(id, boardKind, x, y, components),
    [id, boardKind, x, y, components, seatEpoch],
  );
  // Drag-to-front rank: 0 = never dragged (static layering applies).
  const zRaise = useSimulatorStore((st) => st.zOrders[id] ?? 0);

  // Status dot color: green=running, amber=compiled, gray=idle
  const statusColor = board.running ? '#22c55e' : board.compiledProgram ? '#f59e0b' : '#6b7280';

  const boardEl = (() => {
    // Overlay-registered board (proBoardRegistry): the overlay either provides
    // a render function or we mount its custom element directly — the element
    // was defined by the overlay's import, and pinInfo lives on the DOM node
    // like any other board Web Component.
    const proDef = getProBoard(boardKind);
    if (proDef) {
      if (proDef.render) return proDef.render({ id, x, y, running: !!board.running });
      return React.createElement(proDef.tag, {
        id,
        style: { position: 'absolute', left: x, top: y },
      });
    }
    switch (boardKind) {
      case 'arduino-uno':
        return <ArduinoUno id={id} x={x} y={y} led13={led13} />;
      case 'arduino-nano':
        return <ArduinoNano id={id} x={x} y={y} led13={led13} />;
      case 'arduino-mega':
        return <ArduinoMega id={id} x={x} y={y} led13={led13} />;
      // 'raspberry-pi-pico' used to render <NanoRP2040> (a wokwi-nano-
      // rp2040-connect element with D2-D13 pin labels). That was a
      // misnaming bug — the Nano RP2040 Connect is a different board.
      // Use the same Pico Web Component as 'pi-pico-w' so the pins are
      // labeled GP0..GP28, 3V3, VBUS, etc. — matching the FQBN
      // (rp2040:rp2040:rpipico) and every Pi-Pico sketch's #defines.
      case 'raspberry-pi-pico':
      case 'pi-pico-w':
        return <PiPicoW id={id} x={x} y={y} />;
      // Each Pi draws as itself. Zero/1/2 used to borrow the Pi 3's picture
      // "because the header is the canvas identity" — but the Zero is 65x30 mm
      // against the Pi 3's 85x56, ships its header unpopulated and has neither
      // Ethernet nor full-size USB, so that shortcut drew a board the student
      // was not holding. 1B+ and 2B do share the Pi 3's outline; their silicon
      // and silkscreen do not.
      case 'raspberry-pi-zero':
        return <RaspberryPiZero id={id} x={x} y={y} />;
      case 'raspberry-pi-1':
        return <RaspberryPi1 id={id} x={x} y={y} />;
      case 'raspberry-pi-2':
        return <RaspberryPi2 id={id} x={x} y={y} />;
      case 'raspberry-pi-3':
        return <RaspberryPi3 id={id} x={x} y={y} />;
      case 'raspberry-pi-4':
        return <RaspberryPi4 id={id} x={x} y={y} />;
      case 'raspberry-pi-5':
        return <RaspberryPi5 id={id} x={x} y={y} />;
      case 'esp32':
      case 'esp32-devkit-c-v4':
      case 'esp32-cam':
      case 'wemos-lolin32-lite':
      case 'esp32-s3':
      case 'xiao-esp32-s3':
      case 'arduino-nano-esp32':
      case 'esp32-c3':
      case 'xiao-esp32-c3':
      case 'aitewinrobot-esp32c3-supermini':
        return <Esp32 id={id} x={x} y={y} boardKind={boardKind} onboardLeds={onboardLeds} />;
      case 'stm32-bluepill':
        return <Stm32BluePill id={id} x={x} y={y} />;
      case 'stm32-blackpill':
        return <Stm32BlackPill id={id} x={x} y={y} />;
      case 'stm32-bluepill-f103cb':
        return <Stm32BluePillF103CB id={id} x={x} y={y} />;
      case 'stm32-blackpill-f401':
        return <Stm32BlackPillF401 id={id} x={x} y={y} />;
      case 'stm32-f4-discovery':
        return <Stm32F4Discovery id={id} x={x} y={y} />;
      case 'stm32-olimex-h405':
        return <Stm32OlimexH405 id={id} x={x} y={y} />;
      case 'stm32-netduino-plus2':
        return <Stm32NetduinoPlus2 id={id} x={x} y={y} />;
      case 'stm32-netduino2':
        return <Stm32Netduino2 id={id} x={x} y={y} />;
      case 'attiny85':
        return <Attiny85 id={id} x={x} y={y} led1={led13} />;
    }
  })();

  return (
    // Zero-size positioned wrapper: children keep their absolute canvas
    // coords, but board + pins now share ONE stacking context, so this
    // board's pins can never paint above a component/board covering it.
    // z 0 keeps every board below components (their groups use z 1/2).
    // Hover handlers live HERE, on the wrapper that owns both the drag
    // overlay AND the pin squares — putting them on the drag overlay (a
    // sibling of PinOverlay) made moving onto a pin fire mouseleave, which
    // cleared the hover and hid the pins before you could click one.
    <div
      // Stacking: boards normally sit BELOW components (z 0 vs their 1/2) —
      // a resistor next to an Arduino must be visible on top, and a blanket
      // z bump here once hid it behind the board in every ordinary example.
      // Two exceptions:
      //  - a board SEATED on a socket component (the Round Display / reSpeaker
      //    back header): then the board is the thing you see, the way the
      //    physical XIAO stacks on the shield;
      //  - a board the user has DRAGGED (zRaise > 0): drag-to-front puts
      //    whatever you dragged last above everything it overlaps, so a board
      //    dropped over a part is never lost underneath it — and dragging the
      //    part afterwards wins the stack right back.
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: zRaise > 0 ? 10 + zRaise : seated ? 3 : 0,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Right-click opens the board inspector in EVERY mode. It used to live
      // on the drag overlay only, which is hidden while running — so during a
      // simulation there was no way to open the SD panel and grab the files
      // the sketch just wrote. Bubbling from the board element lands here
      // without covering the board (its buttons/screen stay interactive).
      onContextMenu={onContextMenu}
    >
      {/* The board, its selection ring and its drag surface turn together
          about the footprint centre. Pins (PinOverlay below) stay outside and
          rotate their positions instead, so their hover labels read upright. */}
      <div
        data-board-rotation={rotation}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          transformOrigin: `${x + size.w / 2}px ${y + size.h / 2}px`,
        }}
      >
      {boardEl}

      {/* Active board highlight ring */}
      {isActive && (
        <div
          style={{
            position: 'absolute',
            left: x - 3,
            top: y - 3,
            width: size.w + 6,
            height: size.h + 6,
            border: '2px solid #007acc',
            borderRadius: 6,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}

      {/* Drag overlay — hidden during simulation */}
      {!running && (
        <div
          data-board-overlay="true"
          data-board-id={id}
          style={{
            position: 'absolute',
            left: x,
            top: y,
            width: size.w,
            height: size.h,
            cursor: 'move',
            zIndex: 1,
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onMouseDown(e);
          }}
        />
      )}

      </div>

      {/* Status dot — top-right corner */}
      <div
        style={{
          position: 'absolute',
          left: box.left + box.w - 10,
          top: box.top - 6,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: statusColor,
          border: '2px solid #1e1e1e',
          pointerEvents: 'none',
          zIndex: 10,
          transition: 'background 0.3s',
        }}
        title={board.running ? 'Running' : board.compiledProgram ? 'Compiled' : 'Idle'}
      />

      {/* The board's controls (SD, camera, mic, sensors, edit actions) are
          its BoardDock, drawn by SimulatorCanvas in a layer above components
          and wires so a part placed under the board cannot cover them. */}

      {/* Pin overlay for wire connections */}
      <PinOverlay
        componentId={id}
        componentX={x}
        componentY={y}
        onPinClick={onPinClick}
        showPins={showPins}
        wrapperOffsetX={0}
        wrapperOffsetY={0}
        rotation={rotation}
        pivotBox={size}
        zoom={zoom}
        wiring={wiring}
      />
    </div>
  );
};

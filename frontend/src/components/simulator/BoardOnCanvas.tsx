import React from 'react';
import type { BoardInstance } from '../../types/board';
import { ArduinoUno } from '../components-wokwi/ArduinoUno';
import { ArduinoNano } from '../components-wokwi/ArduinoNano';
import { ArduinoMega } from '../components-wokwi/ArduinoMega';
import { NanoRP2040 } from '../components-wokwi/NanoRP2040';
import { RaspberryPi3 } from '../components-wokwi/RaspberryPi3';
import { Esp32 } from '../components-wokwi/Esp32';
import { Attiny85 } from '../components-wokwi/Attiny85';
import { RiscVBoard } from '../components-wokwi/RiscVBoard';
import { PiPicoW } from '../components-wokwi/PiPicoW';
import { PinOverlay } from './PinOverlay';

// Board visual dimensions (width × height) for the drag-overlay sizing.
// ESP32 sizes match the wokwi-boards SVG rendered at 5 px/mm.
const BOARD_SIZE: Record<string, { w: number; h: number }> = {
  'arduino-uno':       { w: 360, h: 250 },
  'arduino-nano':      { w: 175, h:  70 },
  'arduino-mega':      { w: 530, h: 195 },
  'raspberry-pi-pico': { w: 280, h: 180 },
  'raspberry-pi-3':    { w: 320, h: 205 },
  'esp32':    { w: 141, h: 265 },  // esp32-devkit-v1: 28.2 × 53 mm
  'esp32-s3': { w: 128, h: 350 },  // esp32-s3-devkitc-1: 25.5 × 70 mm
  'esp32-c3': { w: 127, h: 215 },  // esp32-c3-devkitm-1: 25.4 × 42.9 mm
  'pi-pico-w':     { w: 105, h: 264 },
  'esp32-devkit-c-v4':  { w: 140, h: 283 },
  'esp32-cam':          { w: 136, h: 202 },
  'wemos-lolin32-lite': { w: 128, h: 250 },
  'xiao-esp32-s3':      { w:  91, h: 117 },
  'arduino-nano-esp32': { w: 217, h:  90 },
  'xiao-esp32-c3':      { w:  91, h: 117 },
  'aitewinrobot-esp32c3-supermini': { w: 90, h: 123 },
  'attiny85':      { w: 160, h: 100 },
  'riscv-generic': { w: 200, h: 140 },
};

interface BoardOnCanvasProps {
  board: BoardInstance;
  running: boolean;
  led13?: boolean;
  isActive?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onPinClick: (componentId: string, pinName: string, x: number, y: number) => void;
}

export const BoardOnCanvas = ({
  board,
  running,
  led13 = false,
  isActive = false,
  onMouseDown,
  onPinClick,
}: BoardOnCanvasProps) => {
  const { id, boardKind, x, y } = board;
  const size = BOARD_SIZE[boardKind] ?? { w: 300, h: 200 };

  // Status dot color: green=running, amber=compiled, gray=idle
  const statusColor = board.running
    ? '#22c55e'
    : board.compiledProgram
    ? '#f59e0b'
    : '#6b7280';

  const boardEl = (() => {
    switch (boardKind) {
      case 'arduino-uno':
        return <ArduinoUno id={id} x={x} y={y} led13={led13} />;
      case 'arduino-nano':
        return <ArduinoNano id={id} x={x} y={y} led13={led13} />;
      case 'arduino-mega':
        return <ArduinoMega id={id} x={x} y={y} led13={led13} />;
      case 'raspberry-pi-pico':
        return <NanoRP2040 id={id} x={x} y={y} ledBuiltIn={led13} />;
      case 'pi-pico-w':
        return <PiPicoW id={id} x={x} y={y} />;
      case 'raspberry-pi-3':
        return <RaspberryPi3 id={id} x={x} y={y} />;
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
        return <Esp32 id={id} x={x} y={y} boardKind={boardKind} />;
      case 'attiny85':
        return <Attiny85 id={id} x={x} y={y} led1={led13} />;
      case 'riscv-generic':
        return <RiscVBoard id={id} x={x} y={y} ledBuiltIn={led13} />;
    }
  })();

  return (
    <>
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

      {/* Status dot — top-right corner */}
      <div
        style={{
          position: 'absolute',
          left: x + size.w - 10,
          top: y - 6,
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
          onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e); }}
        />
      )}

      {/* Pin overlay for wire connections */}
      <PinOverlay
        componentId={id}
        componentX={x}
        componentY={y}
        onPinClick={onPinClick}
        showPins={true}
        wrapperOffsetX={0}
        wrapperOffsetY={0}
      />
    </>
  );
};

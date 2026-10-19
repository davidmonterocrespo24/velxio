import './Esp32Element';
import { useRef, useEffect } from 'react';
import type { BoardKind, BoardLedVisuals } from '../../types/board';

interface Esp32Props {
  id?: string;
  x?: number;
  y?: number;
  boardKind?: BoardKind;
  /** The on-board LEDs' visual state, keyed by LED id; see BOARD_ONBOARD_LEDS. */
  onboardLeds?: BoardLedVisuals;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'velxio-esp32': any;
    }
  }
}

export const Esp32 = ({
  id = 'esp32',
  x = 0,
  y = 0,
  boardKind = 'esp32',
  onboardLeds,
}: Esp32Props) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    // Same shape as the Arduino wrappers' led13: a property on the element,
    // which is where the drawing lives. The element applies it to whichever
    // footprints this kind has.
    if (ref.current) {
      (ref.current as HTMLElement & { onboardLeds?: BoardLedVisuals }).onboardLeds = onboardLeds;
    }
  }, [onboardLeds]);

  return (
    <velxio-esp32
      id={id}
      ref={ref}
      board-kind={boardKind}
      style={{ position: 'absolute', left: `${x}px`, top: `${y}px` }}
    />
  );
};

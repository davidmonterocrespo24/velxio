/**
 * ATtiny85 — React wrapper around the `velxio-attiny85` Web Component.
 *
 * The wire system reads `pinInfo` directly from the rendered DOM element,
 * so the actual SVG + pin coordinates live in `Attiny85Element.ts`. This
 * file just renders the custom element and forwards the `led1` prop.
 */
import './Attiny85Element';
import { useEffect, useRef } from 'react';

interface Attiny85Props {
  id?: string;
  x?: number;
  y?: number;
  /** State of PB1 (built-in LED on Digispark) */
  led1?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'velxio-attiny85': any;
    }
  }
}

export const Attiny85 = ({ id = 'attiny85', x = 0, y = 0, led1 = false }: Attiny85Props) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ref.current) (ref.current as any).led1 = led1;
  }, [led1]);

  return (
    <velxio-attiny85
      id={id}
      ref={ref}
      style={{ position: 'absolute', left: `${x}px`, top: `${y}px` }}
    />
  );
};

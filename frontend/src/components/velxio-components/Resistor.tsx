import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface ResistorProps {
  id?: string;
  value?: number; // Resistance in ohms
  x?: number;
  y?: number;
}

export const Resistor = ({ id, value = 1000, x = 0, y = 0 }: ResistorProps) => {
  const resistorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (resistorRef.current) {
      (resistorRef.current as any).value = value.toString();
    }
  }, [value]);

  return (
    <wokwi-resistor
      id={id}
      ref={resistorRef}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

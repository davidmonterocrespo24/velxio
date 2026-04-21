import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface ArduinoNanoProps {
  id?: string;
  x?: number;
  y?: number;
  led13?: boolean;
}

export const ArduinoNano = ({
  id = 'arduino-nano',
  x = 0,
  y = 0,
  led13 = false,
}: ArduinoNanoProps) => {
  const nanoRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (nanoRef.current) {
      (nanoRef.current as any).led13 = led13;
    }
  }, [led13]);

  return (
    <wokwi-arduino-nano
      id={id}
      ref={nanoRef}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

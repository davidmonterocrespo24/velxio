import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface ArduinoMegaProps {
  id?: string;
  x?: number;
  y?: number;
  led13?: boolean;
}

export const ArduinoMega = ({
  id = 'arduino-mega',
  x = 0,
  y = 0,
  led13 = false,
}: ArduinoMegaProps) => {
  const megaRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (megaRef.current) {
      (megaRef.current as any).led13 = led13;
    }
  }, [led13]);

  return (
    <wokwi-arduino-mega
      id={id}
      ref={megaRef}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

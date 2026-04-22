import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface ArduinoUnoProps {
  id?: string;
  x?: number;
  y?: number;
  led13?: boolean;
}

export const ArduinoUno = ({
  id = 'arduino-uno',
  x = 0,
  y = 0,
  led13 = false,
}: ArduinoUnoProps) => {
  const arduinoRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (arduinoRef.current) {
      // Control built-in LED (pin 13)
      (arduinoRef.current as any).led13 = led13;
    }
  }, [led13]);

  return (
    <wokwi-arduino-uno
      id={id}
      ref={arduinoRef}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

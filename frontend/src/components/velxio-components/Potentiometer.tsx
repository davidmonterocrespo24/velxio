import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface PotentiometerProps {
  id?: string;
  value?: number; // 0-100
  x?: number;
  y?: number;
  onChange?: (value: number) => void;
}

export const Potentiometer = ({ id, value = 50, x = 0, y = 0, onChange }: PotentiometerProps) => {
  const potRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (potRef.current) {
      (potRef.current as any).value = value;
    }
  }, [value]);

  useEffect(() => {
    const element = potRef.current;
    if (!element || !onChange) return;

    const handleChange = (e: any) => {
      onChange(e.detail.value);
    };

    element.addEventListener('wokwi-potentiometer-change', handleChange);

    return () => {
      element.removeEventListener('wokwi-potentiometer-change', handleChange);
    };
  }, [onChange]);

  return (
    <wokwi-potentiometer
      id={id}
      ref={potRef}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

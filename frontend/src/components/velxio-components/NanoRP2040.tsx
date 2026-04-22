import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface NanoRP2040Props {
  id?: string;
  x?: number;
  y?: number;
  ledBuiltIn?: boolean;
}

export const NanoRP2040 = ({
  id = 'nano-rp2040',
  x = 0,
  y = 0,
  ledBuiltIn = false,
}: NanoRP2040Props) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ref.current) {
      (ref.current as any).ledBuiltIn = ledBuiltIn;
    }
  }, [ledBuiltIn]);

  return (
    // @ts-expect-error -- wokwi-nano-rp2040-connect is a custom element not in base JSX types
    <wokwi-nano-rp2040-connect
      id={id}
      ref={ref}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

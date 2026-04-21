import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface LEDProps {
  id?: string;
  color?: 'red' | 'green' | 'blue' | 'yellow' | 'white' | 'orange';
  value?: boolean;
  /** PWM brightness 0.0–1.0. When set, overrides value for intermediate brightness. */
  brightness?: number;
  label?: string;
  x?: number;
  y?: number;
  onPinClick?: (pinName: string) => void;
}

export const LED = ({
  id,
  color = 'red',
  value = false,
  brightness,
  label,
  x = 0,
  y = 0,
  onPinClick,
}: LEDProps) => {
  const ledRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ledRef.current) {
      const el = ledRef.current as any;
      // If brightness given, use it (wokwi-led supports 0.0–1.0 via `value` float)
      if (brightness !== undefined) {
        el.value = brightness > 0;
        // wokwi-led doesn't natively support float brightness; we simulate via opacity
        (ledRef.current as HTMLElement).style.opacity = String(brightness);
      } else {
        el.value = value;
        (ledRef.current as HTMLElement).style.opacity = '';
      }
      el.color = color;
      if (label) el.label = label;
    }
  }, [value, brightness, color, label]);

  useEffect(() => {
    if (ledRef.current && onPinClick) {
      const element = ledRef.current as any;
      // wokwi-elements expose pinInfo for pin positions
      const pinInfo = element.pinInfo; // [{ name: 'A', x, y }, { name: 'C', x, y }]

      if (pinInfo) {
        pinInfo.forEach((pin: any) => {
          const pinElement = element.shadowRoot?.querySelector(`[data-pin="${pin.name}"]`);
          if (pinElement) {
            pinElement.addEventListener('click', () => onPinClick(pin.name));
          }
        });
      }
    }
  }, [onPinClick]);

  return (
    <wokwi-led
      id={id}
      ref={ledRef}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

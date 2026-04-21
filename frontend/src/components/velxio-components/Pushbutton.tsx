import '@wokwi/elements';
import { useRef, useEffect } from 'react';

interface PushbuttonProps {
  id?: string;
  color?: 'red' | 'green' | 'blue' | 'yellow' | 'white' | 'black';
  pressed?: boolean;
  x?: number;
  y?: number;
  onPress?: () => void;
  onRelease?: () => void;
}

export const Pushbutton = ({
  id,
  color = 'red',
  pressed = false,
  x = 0,
  y = 0,
  onPress,
  onRelease,
}: PushbuttonProps) => {
  const buttonRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (buttonRef.current) {
      (buttonRef.current as any).color = color;
      (buttonRef.current as any).pressed = pressed;
    }
  }, [color, pressed]);

  useEffect(() => {
    const element = buttonRef.current;
    if (!element) return;

    const handlePress = () => onPress?.();
    const handleRelease = () => onRelease?.();

    element.addEventListener('button-press', handlePress);
    element.addEventListener('button-release', handleRelease);

    return () => {
      element.removeEventListener('button-press', handlePress);
      element.removeEventListener('button-release', handleRelease);
    };
  }, [onPress, onRelease]);

  return (
    <wokwi-pushbutton
      id={id}
      ref={buttonRef}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
      }}
    />
  );
};

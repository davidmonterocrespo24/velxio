import './PiPicoWElement';

interface PiPicoWProps {
  id?: string;
  x?: number;
  y?: number;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'wokwi-pi-pico-w': any;
    }
  }
}

export const PiPicoW = ({ id = 'pi-pico-w', x = 0, y = 0 }: PiPicoWProps) => (
  <wokwi-pi-pico-w
    id={id}
    style={{ position: 'absolute', left: `${x}px`, top: `${y}px` }}
  />
);

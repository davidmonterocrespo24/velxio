import { useEffect, useRef } from 'react';
import raspberryPi3Svg from '../../assets/Raspberry_Pi_3_illustration.svg';

interface RaspberryPi3Props {
  id?: string;
  x?: number;
  y?: number;
}

// Raspberry Pi 3 GPIO 40-pin header (2 rows × 20 cols).
// Coordinates are in CSS pixels relative to the top-left of the board image
// rendered at 320×205 px.
// Physical layout: pin 1 top-left, pins go left→right, odd=top row, even=bottom row.
//   Top row (odd pins 1,3,5,…39) : y ≈ 8 px
//   Bottom row (even pins 2,4,6,…40): y ≈ 17 px
//   First column x ≈ 15 px, step ≈ 9 px
function buildPinInfo() {
  const PIN_X_START = 15;
  const PIN_X_STEP = 9;
  const PIN_Y_TOP = 8;
  const PIN_Y_BOT = 17;

  const GPIO_NAMES: Record<number, string> = {
    1: '3V3',
    2: '5V',
    3: 'GPIO2',
    4: '5V',
    5: 'GPIO3',
    6: 'GND',
    7: 'GPIO4',
    8: 'GPIO14',
    9: 'GND',
    10: 'GPIO15',
    11: 'GPIO17',
    12: 'GPIO18',
    13: 'GPIO27',
    14: 'GND',
    15: 'GPIO22',
    16: 'GPIO23',
    17: '3V3',
    18: 'GPIO24',
    19: 'GPIO10',
    20: 'GND',
    21: 'GPIO9',
    22: 'GPIO25',
    23: 'GPIO11',
    24: 'GPIO8',
    25: 'GND',
    26: 'GPIO7',
    27: 'ID_SD',
    28: 'ID_SC',
    29: 'GPIO5',
    30: 'GND',
    31: 'GPIO6',
    32: 'GPIO12',
    33: 'GPIO13',
    34: 'GND',
    35: 'GPIO19',
    36: 'GPIO16',
    37: 'GPIO26',
    38: 'GPIO20',
    39: 'GND',
    40: 'GPIO21',
  };

  const pins = [];
  for (let col = 0; col < 20; col++) {
    const oddPin = col * 2 + 1; // top row
    const evenPin = col * 2 + 2; // bottom row
    const px = PIN_X_START + col * PIN_X_STEP;
    pins.push({ name: GPIO_NAMES[oddPin] ?? `P${oddPin}`, x: px, y: PIN_Y_TOP });
    pins.push({ name: GPIO_NAMES[evenPin] ?? `P${evenPin}`, x: px, y: PIN_Y_BOT });
  }
  return pins;
}

export const RaspberryPi3 = ({ id = 'raspberry-pi-3', x = 0, y = 0 }: RaspberryPi3Props) => {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (imgRef.current) {
      (imgRef.current as any).pinInfo = buildPinInfo();
    }
  }, []);

  return (
    <img
      ref={imgRef}
      id={id}
      src={raspberryPi3Svg}
      alt="Raspberry Pi 3"
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        width: '320px',
        height: '205px',
        display: 'block',
        userSelect: 'none',
        pointerEvents: 'none',
      }}
    />
  );
};

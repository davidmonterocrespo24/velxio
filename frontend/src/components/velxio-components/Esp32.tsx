import './Esp32Element';
import type { BoardKind } from '../../types/board';

interface Esp32Props {
  id?: string;
  x?: number;
  y?: number;
  boardKind?: BoardKind;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'velxio-esp32': any;
    }
  }
}

export const Esp32 = ({ id = 'esp32', x = 0, y = 0, boardKind = 'esp32' }: Esp32Props) => (
  <velxio-esp32
    id={id}
    board-kind={boardKind}
    style={{ position: 'absolute', left: `${x}px`, top: `${y}px` }}
  />
);

import React, { useEffect, useRef } from 'react';
import { Voltmeter } from './Voltmeter';
import { Ammeter } from './Ammeter';

type InstrumentMetadataId = 'instr-voltmeter' | 'instr-ammeter';

interface InstrumentComponentProps {
  id: string;
  metadataId: InstrumentMetadataId;
  x: number;
  y: number;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}

const PIN_INFO: Record<
  InstrumentMetadataId,
  Array<{ name: string; x: number; y: number; signals: unknown[] }>
> = {
  'instr-voltmeter': [
    { name: 'V+', x: 4, y: 24, signals: [] },
    { name: 'V-', x: 4, y: 48, signals: [] },
  ],
  'instr-ammeter': [
    { name: 'A+', x: 4, y: 36, signals: [] },
    { name: 'A-', x: 118, y: 36, signals: [] },
  ],
};

export const InstrumentComponent: React.FC<InstrumentComponentProps> = ({
  id,
  metadataId,
  x,
  y,
  isSelected,
  onMouseDown,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!wrapperRef.current) return;
    (wrapperRef.current as any).pinInfo = PIN_INFO[metadataId];
  }, [metadataId]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    onMouseDown(e);
  };

  return (
    <div
      id={id}
      ref={wrapperRef}
      className="dynamic-component-wrapper"
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        cursor: 'move',
        border: isSelected ? '2px dashed #007acc' : '2px solid transparent',
        borderRadius: '4px',
        padding: '4px',
        userSelect: 'none',
        zIndex: isSelected ? 5 : 1,
        pointerEvents: 'auto',
      }}
      onMouseDown={handleMouseDown}
      data-component-id={id}
      data-component-type={metadataId}
    >
      {metadataId === 'instr-voltmeter' ? <Voltmeter id={id} /> : <Ammeter id={id} />}
    </div>
  );
};

/**
 * Examples Page Component
 *
 * Displays the examples gallery
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ExamplesGallery } from '../components/examples/ExamplesGallery';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { ExampleProject } from '../data/examples';
import { trackOpenExample } from '../utils/analytics';

export const ExamplesPage: React.FC = () => {
  const navigate = useNavigate();
  const { setCode } = useEditorStore();
  const { setComponents, setWires, setBoardType } = useSimulatorStore();

  const handleLoadExample = (example: ExampleProject) => {
    console.log('Loading example:', example.title);
    trackOpenExample(example.title);

    // Switch board type if the example specifies one
    const targetBoard = example.boardType || 'arduino-uno';
    setBoardType(targetBoard);

    // Load the code into the editor
    setCode(example.code);

    // Filter out board components from examples (board is rendered separately in SimulatorCanvas)
    const componentsWithoutBoard = example.components.filter(
      (comp) => !comp.type.includes('arduino') && !comp.type.includes('pico')
    );

    // Load components into the simulator
    // Convert component type to metadataId (e.g., 'wokwi-led' -> 'led')
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: comp.type.replace('wokwi-', ''),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      }))
    );

    // Load wires (need to convert to full wire format with positions)
    // For now, just set empty wires - wire positions will be calculated when components are loaded
    const wiresWithPositions = example.wires.map((wire) => ({
      id: wire.id,
      start: {
        componentId: wire.start.componentId,
        pinName: wire.start.pinName,
        x: 0, // Will be calculated by SimulatorCanvas
        y: 0,
      },
      end: {
        componentId: wire.end.componentId,
        pinName: wire.end.pinName,
        x: 0,
        y: 0,
      },
      color: wire.color,
      controlPoints: [],
      isValid: true,
      signalType: 'digital' as const,
    }));

    setWires(wiresWithPositions);

    // Navigate to the editor
    navigate('/editor');
  };

  return <ExamplesGallery onLoadExample={handleLoadExample} />;
};

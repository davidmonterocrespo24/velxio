import { useState } from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore, BOARD_FQBN } from '../../store/useSimulatorStore';
import { compileCode } from '../../services/compilation';
import './EditorToolbar.css';

export const EditorToolbar = () => {
  const { code } = useEditorStore();
  const {
    boardType,
    setCompiledHex,
    setCompiledBinary,
    startSimulation,
    stopSimulation,
    resetSimulation,
    running,
    compiledHex,
  } = useSimulatorStore();
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleCompile = async () => {
    setCompiling(true);
    setMessage(null);

    try {
      const fqbn = BOARD_FQBN[boardType];
      console.log('Starting compilation for board:', fqbn);
      const result = await compileCode(code, fqbn);
      console.log('Compilation result:', result);

      if (result.success) {
        if (result.hex_content) {
          // AVR path
          setCompiledHex(result.hex_content);
          setMessage({ type: 'success', text: 'Compilation successful! Ready to run.' });
        } else if (result.binary_content) {
          // RP2040 path
          setCompiledBinary(result.binary_content);
          setMessage({ type: 'success', text: 'Compilation successful! Ready to run.' });
        } else {
          setMessage({ type: 'error', text: 'Compilation produced no output' });
        }
      } else {
        const errorMsg = result.error || result.stderr || 'Compilation failed';
        console.error('Compilation error:', errorMsg);
        setMessage({ type: 'error', text: errorMsg });
      }
    } catch (err) {
      console.error('Compilation exception:', err);
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Compilation failed',
      });
    } finally {
      setCompiling(false);
    }
  };

  const handleRun = () => {
    if (compiledHex) {
      startSimulation();
      setMessage({ type: 'success', text: 'Simulation started' });
    } else {
      setMessage({ type: 'error', text: 'Please compile the code first' });
    }
  };

  const handleStop = () => {
    stopSimulation();
    setMessage({ type: 'success', text: 'Simulation stopped' });
  };

  const handleReset = () => {
    resetSimulation();
    setMessage({ type: 'success', text: 'Simulation reset' });
  };

  return (
    <div className="editor-toolbar">
      <div className="toolbar-buttons">
        <button onClick={handleCompile} disabled={compiling} className="btn btn-primary">
          {compiling ? 'Compiling...' : 'Compile'}
        </button>
        <button
          onClick={handleRun}
          disabled={running || !compiledHex}
          className="btn btn-success"
        >
          Run
        </button>
        <button onClick={handleStop} disabled={!running} className="btn btn-danger">
          Stop
        </button>
        <button onClick={handleReset} disabled={!compiledHex} className="btn btn-secondary">
          Reset
        </button>
      </div>
      {message && (
        <div className={`toolbar-message ${message.type}`}>{message.text}</div>
      )}
    </div>
  );
};

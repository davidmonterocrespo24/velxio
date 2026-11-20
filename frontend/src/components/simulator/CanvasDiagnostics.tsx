import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { describeSolverError } from '../../simulation/spice/solverFaultReporter';
import { boardDisplayName } from '../../types/board';

interface Diagnostic {
  source: string;
  message: string;
  severity: 'warning' | 'error';
  onDismiss?: () => void;
}

function DiagnosticMenu({ items }: { items: Diagnostic[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const label = t('editor.canvas.diagnostics', 'Circuit diagnostics');
  const hasError = items.some(({ severity }) => severity === 'error');
  const Icon = hasError ? CircleAlert : TriangleAlert;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return (
    <div
      className="canvas-diagnostics-menu"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        type="button"
        className="canvas-diagnostics-trigger"
        data-severity={hasError ? 'error' : 'warning'}
        ref={trigger}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon size={15} aria-hidden />
        {items.length}
      </button>
      {open && (
        <section
          className="canvas-diagnostics-panel"
          id={panelId}
          aria-labelledby={`${panelId}-title`}
          tabIndex={0}
        >
          <h2 id={`${panelId}-title`}>{label}</h2>
          <ul>
            {items.map(({ source, message, severity, onDismiss }) => {
              const IssueIcon = severity === 'error' ? CircleAlert : TriangleAlert;
              return (
                <li key={source}>
                  <div className="canvas-diagnostics-source" data-severity={severity}>
                    <IssueIcon size={14} aria-hidden />
                    <strong>{source}</strong>
                  </div>
                  <p>{message}</p>
                  {onDismiss && (
                    <button
                      type="button"
                      className="canvas-diagnostics-dismiss"
                      onClick={() => {
                        trigger.current?.focus();
                        onDismiss();
                      }}
                    >
                      {t('editor.canvas.dismiss')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

export function CanvasDiagnostics() {
  const { t } = useTranslation();
  const converged = useElectricalStore((state) => state.converged);
  const error = useElectricalStore((state) => state.error);
  const hasVoltages = useElectricalStore((state) => Object.keys(state.nodeVoltages).length > 0);
  const mode = useElectricalStore((state) => (state.analysisMode === 'op' ? 'DC' : 'AC'));
  const esp32CrashBoardId = useSimulatorStore((state) => state.esp32CrashBoardId);
  const dismissEsp32Crash = useSimulatorStore((state) => state.dismissEsp32Crash);
  const crashedBoard = useSimulatorStore((state) => state.boards.find(({ id }) => id === state.esp32CrashBoardId));
  const spiceMessage = error && !/^note:/i.test(error.trim())
    ? describeSolverError(error)
    : !converged && !hasVoltages
      ? t('editor.canvas.spiceDidNotConverge', 'Analysis did not converge.')
      : null;
  const items: Diagnostic[] = [];

  if (esp32CrashBoardId) {
    items.push({
      source: 'ESP32',
      severity: 'error',
      message: t(
        'editor.canvas.esp32RuntimeFault',
        'Simulation stopped after {{board}} reported a runtime error.',
        { board: crashedBoard ? boardDisplayName(crashedBoard) : esp32CrashBoardId },
      ),
      onDismiss: dismissEsp32Crash,
    });
  }
  if (spiceMessage) {
    items.push({ source: `SPICE (${mode})`, severity: hasVoltages ? 'warning' : 'error', message: spiceMessage });
  }

  if (items.length === 0) return null;

  return (
    <div className="canvas-diagnostics">
      <DiagnosticMenu items={items} />
    </div>
  );
}

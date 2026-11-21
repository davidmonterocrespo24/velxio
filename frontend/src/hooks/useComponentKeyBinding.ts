import { useEffect, useState } from 'react';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { isKeyBindable, isModifierKey, normalizeKey } from '../utils/keyButtonBindings';

export function useComponentKeyBinding(
  componentId: string,
  value: unknown,
  onPropertyChange?: (componentId: string, propertyName: string, value: unknown) => void,
) {
  const [capture, setCapture] = useState({ componentId, active: false });
  const capturingKey = capture.componentId === componentId && capture.active;
  if (capture.componentId !== componentId) {
    setCapture({ componentId, active: false });
  }
  const boundKey = typeof value === 'string' ? value : '';
  const normalizedKey = normalizeKey(boundKey);
  const keyInUseElsewhere = useSimulatorStore(
    (s) =>
      !!normalizedKey &&
      s.components.some(
        (c) =>
          c.id !== componentId &&
          isKeyBindable(c.metadataId) &&
          typeof c.properties.key === 'string' &&
          normalizeKey(c.properties.key) === normalizedKey,
      ),
  );

  useEffect(() => {
    if (!capturingKey) return;
    const onCaptureKey = (e: KeyboardEvent) => {
      // Capture before the dialog, canvas shortcuts, or simulator handle the key.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapture({ componentId, active: false });
        return;
      }
      if (isModifierKey(e.key)) return;
      onPropertyChange?.(componentId, 'key', normalizeKey(e.key));
      setCapture({ componentId, active: false });
    };
    window.addEventListener('keydown', onCaptureKey, true);
    return () => window.removeEventListener('keydown', onCaptureKey, true);
  }, [capturingKey, componentId, onPropertyChange]);

  return {
    boundKey,
    capturingKey,
    keyInUseElsewhere,
    onToggleCapture: () => setCapture((current) => ({ componentId, active: !current.active })),
    onClear: () => onPropertyChange?.(componentId, 'key', ''),
  };
}

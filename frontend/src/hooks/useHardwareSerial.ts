import { useEffect, useRef, useState } from 'react';
import { getBrowserFlashSerial } from '../lib/browserFlashSerial';
import { connectHardwareSerial } from '../lib/hardwareSerial';

const MAX_LOG_LENGTH = 64_000;
type Status = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

export function useHardwareSerial() {
  const [status, setStatus] = useState<Status>('disconnected');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string>();
  const session = useRef<ReturnType<typeof connectHardwareSerial> | null>(null);
  const mounted = useRef(false);
  const pending = useRef('');
  const frame = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      void session.current?.disconnect().catch(() => {});
    };
  }, []);

  const reportError = (cause: unknown) => {
    if (mounted.current && !(cause instanceof DOMException && cause.name === 'NotFoundError')) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const connect = async (baudRate: number) => {
    if (session.current) return;
    setError(undefined);
    setStatus('connecting');
    try {
      const next = connectHardwareSerial(
        baudRate,
        (text) => {
          if (!text || !mounted.current) return;
          pending.current = (pending.current + text).slice(-MAX_LOG_LENGTH);
          if (frame.current !== null) return;
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            const chunk = pending.current;
            pending.current = '';
            setOutput((current) => (current + chunk).slice(-MAX_LOG_LENGTH));
          });
        },
        (cause) => {
          session.current = null;
          if (mounted.current) setStatus('disconnected');
          if (cause !== undefined) reportError(cause);
        },
      );
      session.current = next;
      await next.ready;
      if (mounted.current && session.current === next) {
        setStatus((current) => (current === 'connecting' ? 'connected' : current));
      }
    } catch (cause) {
      if (mounted.current) setStatus('disconnected');
      reportError(cause);
    }
  };

  return {
    available: !!getBrowserFlashSerial(),
    status,
    output,
    error,
    connect,
    disconnect: async () => {
      if (!session.current) return;
      setStatus('disconnecting');
      await session.current.disconnect().catch(reportError);
    },
    write: (text: string) => session.current?.write(text).catch(reportError),
    clear: () => {
      pending.current = '';
      setOutput('');
    },
  };
}

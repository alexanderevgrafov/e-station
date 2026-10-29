import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { SensorInfo } from './api.ts';

// The server polls the sensors itself; this only mirrors what it last read,
// so the editor can show live values next to the placeholders. Polled more
// often than the server reads, so a fresh value shows up within seconds.
export function useSensors(everyMs = 15_000): { sensors: SensorInfo | null; error: string | null } {
  const [sensors, setSensors] = useState<SensorInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.sensors().then(
        (info) => {
          if (cancelled) return;
          setSensors(info);
          setError(null);
        },
        (caught: unknown) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
        },
      );
    void load();
    const timer = setInterval(load, everyMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [everyMs]);

  return { sensors, error };
}

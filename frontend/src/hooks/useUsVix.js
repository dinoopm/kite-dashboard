import { useEffect, useState } from 'react';
import { fetchWithAbort } from './useFetchWithAbort';

export default function useUsVix() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetchWithAbort('/api/us/vix', { signal: controller.signal, timeoutMs: 35_000 });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('US VIX could not be loaded.');
        const result = await response.json();
        if (!Number.isFinite(result.current)) throw new Error('US VIX data unavailable.');
        if (!controller.signal.aborted) { setData(result); setError(null); }
      } catch (e) { if (!controller.signal.aborted) setError(e.message); }
    }
    load();
    const timer = setInterval(load, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);
  return { data, error, retry: () => setRefresh(value => value + 1) };
}

export function vixAsOf(data) {
  if (!data) return '';
  if (data.kind === 'daily-close') return `${data.asOf} close`;
  return `${new Date(data.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
}
export function vixTiming(data) {
  return data?.kind === 'daily-close' ? 'Daily close' : data?.delayMinutes > 0 ? `${data.delayMinutes}-min delayed` : data?.delayMinutes === 0 ? 'Latest quote' : 'Quote · delay unspecified';
}

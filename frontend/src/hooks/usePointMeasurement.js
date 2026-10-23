import { useCallback, useEffect, useState } from 'react';
const EMPTY = { active: false, start: null, end: null, preview: null };

export default function usePointMeasurement(context) {
  const [saved, setSaved] = useState({ context, ...EMPTY });
  // A new instrument, range or price basis starts with a clean measurement.
  const state = saved.context === context ? saved : EMPTY;
  const clear = useCallback(() => setSaved({ context, ...EMPTY }), [context]);
  const toggle = () => setSaved(previous => ({ context, ...EMPTY, active: previous.context === context ? !previous.active : true }));
  const select = point => setSaved(previous => {
    if (previous.context !== context || !previous.active || !point) return previous;
    if (!previous.start) return point.price > 0 ? { ...previous, start: point } : previous;
    return { ...previous, end: point, preview: null, active: false };
  });
  const preview = point => setSaved(previous => previous.context === context && previous.active && previous.start && point
    ? { ...previous, preview: point } : previous);
  useEffect(() => {
    if (!state.active && !state.start) return;
    const onKey = event => {
      if (event.key === 'Escape' && !event.target?.matches?.('input, textarea, select, [contenteditable="true"]')) {
        event.preventDefault(); clear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.active, state.start, clear]);
  return { state, toggle, clear, select, preview };
}

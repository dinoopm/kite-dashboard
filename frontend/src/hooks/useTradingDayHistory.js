import { useEffect, useState } from 'react';
import { fetchWithAbort } from './useFetchWithAbort';

export default function useTradingDayHistory(indices, usIndices) {
  const [history, setHistory] = useState({});

  useEffect(() => {
    if (!indices && !usIndices) return;
    const controller = new AbortController();
    const indianCards = Object.values(indices || {})
      .filter(quote => quote.instrument_token)
      .map(quote => ({
        key: `india:${quote.instrument_token}`,
        url: `/api/historical/${quote.instrument_token}?tf=1M`,
      }));
    const usCards = (usIndices || []).map(item => ({
      key: `us:${item.symbol}`,
      url: `/api/us/bars/${encodeURIComponent(item.symbol)}?range=1M`,
    }));

    const loadMarket = async cards => {
      // Fetch each market progressively, without holding up the quote cards.
      for (const card of cards) {
        if (controller.signal.aborted) return;
        try {
          const response = await fetchWithAbort(card.url, { signal: controller.signal });
          const result = await response.json();
          if (!response.ok || result.isError || result.error) throw new Error('History unavailable');
          const candles = result.bars ?? JSON.parse(result.content?.[0]?.text || 'null');
          if (!Array.isArray(candles)) throw new Error('History unavailable');
          if (controller.signal.aborted) return;
          setHistory(previous => ({ ...previous, [card.key]: candles }));
        } catch {
          if (controller.signal.aborted) return;
          setHistory(previous => ({ ...previous, [card.key]: [] }));
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    };

    loadMarket(indianCards);
    loadMarket(usCards);
    return () => controller.abort();
  }, [indices, usIndices]);

  return history;
}

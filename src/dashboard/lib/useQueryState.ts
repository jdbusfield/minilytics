import { useCallback, useEffect, useState } from 'react';
import type { Filters, Query } from './api';

/** Period, granularity, filters and the humans-only switch live in the URL so a refresh or shared link keeps them. */
function read(): Query {
  const p = new URLSearchParams(window.location.search);
  let filters: Filters = {};
  try {
    filters = JSON.parse(p.get('filters') || '{}');
  } catch {}
  return {
    period: p.get('period') || '30d',
    from: p.get('from') || undefined,
    to: p.get('to') || undefined,
    granularity: p.get('granularity') || undefined,
    filters,
    everyone: p.get('all') === '1',
  };
}

export function useQueryState() {
  const [q, setQ] = useState<Query>(read);

  useEffect(() => {
    const on = () => setQ(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const update = useCallback((patch: Partial<Query>) => {
    setQ((prev) => {
      const next = { ...prev, ...patch };
      if (patch.period && patch.period !== 'custom') {
        next.from = undefined;
        next.to = undefined;
      }
      const p = new URLSearchParams();
      p.set('period', next.period);
      if (next.from) p.set('from', next.from);
      if (next.to) p.set('to', next.to);
      if (next.granularity) p.set('granularity', next.granularity);
      if (Object.keys(next.filters).length) p.set('filters', JSON.stringify(next.filters));
      if (next.everyone) p.set('all', '1');
      window.history.replaceState(null, '', `${window.location.pathname}?${p}`);
      return next;
    });
  }, []);

  return [q, update] as const;
}

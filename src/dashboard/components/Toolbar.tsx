import { useEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import type { Overview, Query, Site } from '../lib/api';
import { dayInTz } from '../lib/format';
import { ThemeIcon, toggleTheme, useTheme } from '../lib/theme';
import { Favicon } from './Icons';

export const PERIODS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const GRANULARITIES = [
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

export function Dropdown({
  button,
  children,
  align = 'left',
  className = '',
}: {
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  return (
    <div className={`relative flex ${className}`} ref={ref}>
      <div className="flex flex-1" onClick={() => setOpen((o) => !o)}>
        {button}
      </div>
      {open && (
        <div className={`card absolute top-full z-40 mt-2 min-w-[200px] overflow-hidden p-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

function itemCls(active: boolean) {
  return `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-stone-100 ${active ? 'font-medium text-ink' : 'text-stone-600'}`;
}

export function Toolbar({
  site,
  sites,
  q,
  update,
  overview,
  onRefresh,
  loading,
}: {
  site: Site;
  sites: Site[];
  q: Query;
  update: (p: Partial<Query>) => void;
  overview: Overview | null;
  onRefresh: () => void;
  loading: boolean;
}) {
  const theme = useTheme();
  const [from, setFrom] = useState(q.from ?? '');
  const [to, setTo] = useState(q.to ?? '');

  const label =
    q.period === 'custom'
      ? q.from === q.to
        ? new Date(q.from + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : `${q.from} → ${q.to}`
      : PERIODS.find((p) => p.value === q.period)?.label ?? 'Last 30 days';

  function shift(dir: -1 | 1) {
    if (!overview) return;
    const { from, to } = overview.range;
    const span = Math.max(to - from, 86_400_000);
    const nf = from + dir * span;
    const nt = nf + span - 1;
    if (nf > Date.now()) return;
    update({ period: 'custom', from: dayInTz(nf, site.timezone), to: dayInTz(Math.min(nt, Date.now()), site.timezone) });
  }
  const canForward = overview ? overview.range.to < Date.now() - 60_000 : false;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dropdown
        className="order-1 min-w-0 sm:order-none"
        button={
          <button className="btn h-11 px-4 text-base">
            <Favicon domain={site.domain} size={22} />
            <span className="max-w-[180px] truncate font-semibold">{site.name}</span>
            <Chevron />
          </button>
        }
      >
        {(close) => (
          <>
            {sites.map((s) => (
              <button
                key={s.id}
                className={itemCls(s.id === site.id)}
                onClick={() => {
                  close();
                  navigate(`/site/${s.id}${window.location.search}`);
                }}
              >
                <Favicon domain={s.domain} size={16} /> {s.name}
              </button>
            ))}
            <div className="my-1 border-t border-stone-100" />
            <button className={itemCls(false)} onClick={() => navigate(`/site/${site.id}/settings`)}>
              ⚙️ Site settings & install
            </button>
            <button className={itemCls(false)} onClick={() => navigate('/')}>
              ＋ All websites
            </button>
            <button
              className={itemCls(false)}
              onClick={() => {
                close();
                toggleTheme();
              }}
            >
              <ThemeIcon theme={theme} /> {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </>
        )}
      </Dropdown>

      {/* Phones: the date range, granularity and refresh get their own full-width row. */}
      <div className="order-3 flex w-full gap-2 sm:contents">
        <div className="flex h-11 min-w-0 flex-1 items-stretch rounded-xl border border-stone-200 bg-surface shadow-card sm:flex-initial">
          <button className="rounded-l-xl px-2 text-xl text-stone-500 hover:bg-stone-50 sm:px-3" onClick={() => shift(-1)} aria-label="Previous period">
            ‹
          </button>
          <Dropdown
            className="flex-1"
            button={
              <button className="flex h-full w-full items-center justify-center gap-2 whitespace-nowrap border-x border-stone-200 px-2 text-base font-medium hover:bg-stone-50 sm:px-4">
                {label} <Chevron />
              </button>
            }
          >
            {(close) => (
              <>
                {PERIODS.map((p) => (
                  <button
                    key={p.value}
                    className={itemCls(q.period === p.value)}
                    onClick={() => {
                      close();
                      update({ period: p.value, granularity: undefined });
                    }}
                  >
                    {p.label}
                  </button>
                ))}
                <div className="my-1 border-t border-stone-100" />
                <form
                  className="space-y-2 p-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!from || !to) return;
                    close();
                    update({ period: 'custom', from, to: to < from ? from : to, granularity: undefined });
                  }}
                >
                  <div className="text-xs font-medium text-stone-500">Custom range</div>
                  <input type="date" className="input py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
                  <input type="date" className="input py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
                  <button className="btn-dark w-full py-1.5">Apply</button>
                </form>
              </>
            )}
          </Dropdown>
          <button
            className="rounded-r-xl px-2 text-xl text-stone-500 hover:bg-stone-50 disabled:opacity-30 sm:px-3"
            onClick={() => shift(1)}
            disabled={!canForward}
            aria-label="Next period"
          >
            ›
          </button>
        </div>

        <Dropdown
          align="right"
          button={
            <button className="btn h-11 px-3 text-base sm:px-4">
              {GRANULARITIES.find((g) => g.value === (q.granularity ?? overview?.range.granularity))?.label ?? 'Daily'} <Chevron />
            </button>
          }
        >
          {(close) =>
            GRANULARITIES.map((g) => (
              <button
                key={g.value}
                className={itemCls((q.granularity ?? overview?.range.granularity) === g.value)}
                onClick={() => {
                  close();
                  update({ granularity: g.value });
                }}
              >
                {g.label}
              </button>
            ))
          }
        </Dropdown>

        <button className="btn h-11 w-11 shrink-0 px-0" onClick={onRefresh} aria-label="Refresh">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'animate-spin' : ''}>
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      </div>

      <button
        className="btn order-2 ml-auto h-11 px-3 text-base sm:order-none sm:ml-0"
        onClick={() => update({ everyone: !q.everyone })}
        role="switch"
        aria-checked={!q.everyone}
        title="Hide visits with no mouse, touch or key input: crawlers that load pages like a browser. Revenue always counts."
      >
        <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${q.everyone ? 'bg-stone-200 dark:bg-stone-300' : 'bg-ink'}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-all ${q.everyone ? 'left-0.5' : 'left-[18px]'}`} />
        </span>
        Hide bots
      </button>
    </div>
  );
}

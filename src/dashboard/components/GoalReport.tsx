import { useState, type ReactNode } from 'react';
import { qs } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';
import { SourceIcon } from './Icons';

interface CountRow {
  label: string;
  visitors: number;
  completions: number;
  extra?: string | null;
}

interface Report {
  visitors: number;
  completions: number;
  pages: CountRow[];
  props: { key: string; rows: CountRow[] }[];
  sources: CountRow[];
  entries: CountRow[];
  before: CountRow[];
  visits: CountRow[];
}

/** Friendlier names for the props sites usually send with a goal. Anything else shows its own key. */
const PROP_LABELS: Record<string, string> = {
  placement: 'Button',
  variant: 'Button style',
  plan: 'Plan',
  provider: 'League site',
  method: 'Sign-up method',
  source: 'From',
  kind: 'Kind',
  mode: 'Mode',
  arm: 'Test arm',
};
export const propLabel = (k: string) => PROP_LABELS[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function List({ rows, total, render, empty, share }: { rows: CountRow[]; total: number; render?: (r: CountRow) => ReactNode; empty: string; share?: boolean }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className="py-4 text-center text-sm text-stone-400">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <div className="space-y-1">
      {shown.map((r) => (
        <div key={r.label} className="relative flex h-9 items-center rounded-lg" title={`${r.label}: ${r.visitors} visitors, ${r.completions} times`}>
          <div className="absolute inset-y-0 left-0 rounded-lg bg-visitorsSoft" style={{ width: `${(r.visitors / max) * 100}%`, minWidth: 4 }} />
          <div className="relative flex min-w-0 flex-1 items-center gap-2 px-3 text-sm">{render ? render(r) : <span className="truncate">{r.label}</span>}</div>
          <div className="relative shrink-0 pr-3 text-sm font-medium">
            {share ? fmtPct(total ? r.visitors / total : 0) : fmtNumber(r.visitors)}
          </div>
        </div>
      ))}
      {rows.length > 8 && (
        <button className="mx-auto mt-1 block text-xs font-semibold uppercase tracking-wider text-stone-500 hover:text-ink" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

function Section({ title, hint, children, right }: { title: string; hint: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-stone-100 p-3">
      <div className="mb-2 flex items-start justify-between gap-2 px-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-stone-500">{hint}</p>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Everything that led up to one goal, opened from the Goals table. */
export function GoalReport({ name, totalVisitors, onFilter }: { name: string; totalVisitors: number; onFilter: () => void }) {
  const { site, q, reloadKey } = useDash();
  const { data, error } = useApi<Report>(`/api/sites/${site.id}/goals/${encodeURIComponent(name)}?${qs(q)}`, reloadKey);
  const [propKey, setPropKey] = useState<string | null>(null);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <div className="h-96 animate-pulse" />;
  if (!data.completions) return <p className="py-8 text-center text-sm text-stone-500">Nobody did this in the selected period.</p>;

  const prop = data.props.find((p) => p.key === propKey) ?? data.props[0];
  const total = data.visitors;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Stat label="People" value={fmtNumber(data.visitors)} />
          <Stat label="Times" value={fmtNumber(data.completions)} />
          <Stat label="Of all visitors" value={totalVisitors ? fmtPct(data.visitors / totalVisitors, 1) : '—'} />
        </div>
        <button className="btn py-1.5 text-sm" onClick={onFilter} title="Show the whole dashboard for just these visitors">
          Filter dashboard to these people
        </button>
      </div>

      {data.visits.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-stone-500">Which visit it happened on</div>
          <div className="flex h-7 overflow-hidden rounded-lg text-xs font-medium">
            {data.visits.map((v, i) => (
              <div
                key={v.label}
                className={`flex min-w-0 items-center justify-center truncate px-2 ${['bg-visitors/80 text-white', 'bg-visitors/50', 'bg-visitorsSoft'][i] ?? 'bg-stone-100'}`}
                style={{ width: `${(v.visitors / total) * 100}%` }}
                title={`${v.label}: ${v.visitors} people`}
              >
                {v.visitors / total >= 0.12 ? `${v.label} ${fmtPct(v.visitors / total)}` : fmtPct(v.visitors / total)}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Section title="Page they were on" hint="Where it happened">
          <List rows={data.pages} total={total} empty="No page recorded" />
        </Section>

        <Section
          title={prop ? propLabel(prop.key) : 'Details'}
          hint={prop ? `The ${propLabel(prop.key).toLowerCase()} sent with it` : 'Details sent with the goal'}
          right={
            data.props.length > 1 && (
              <select className="input w-auto py-1 text-xs" value={prop?.key} onChange={(e) => setPropKey(e.target.value)}>
                {data.props.map((p) => (
                  <option key={p.key} value={p.key}>
                    {propLabel(p.key)}
                  </option>
                ))}
              </select>
            )
          }
        >
          <List rows={prop?.rows ?? []} total={total} empty="This goal is sent without details" />
        </Section>

        <Section title="Where they came from" hint="Source of the visit it happened in">
          <List
            rows={data.sources}
            total={total}
            empty="No source"
            render={(r) => (
              <>
                <SourceIcon source={r.label} domain={r.extra ?? null} />
                <span className="truncate">{r.label}</span>
              </>
            )}
          />
        </Section>

        <Section title="First page of the visit" hint="Where that visit landed">
          <List rows={data.entries} total={total} empty="No landing page" />
        </Section>
      </div>

      <Section title="Pages seen on the way" hint="Share of these people who viewed each page earlier in the same visit">
        <List rows={data.before} total={total} share empty="No pages recorded" />
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-stone-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

// What leads people to a goal, and how far they get through a funnel. Pure functions over rows the
// SQL in stats.ts fetches, so the counting rules can be tested without D1.

export interface CountRow {
  label: string;
  visitors: number;
  completions: number;
  extra?: string | null;
}

/** One goal event, with the visit it happened in. */
export interface GoalRow {
  visitor_id: string;
  session_id: string;
  ts: number;
  path: string | null;
  props: string | null;
  source: string | null;
  referrer_domain: string | null;
  entry_page: string | null;
  /** The visitor's visit number when this happened (1 = their first visit). */
  visit_no: number;
}

/** A page viewed in the same visit, at or before the visit's first completion of the goal. */
export interface BeforeRow {
  visitor_id: string;
  path: string;
}

/** Props that name one event (an order, a league, a price) rather than describe how it happened. */
const SKIP_PROPS = new Set(['transaction_id', 'league_id', 'value', 'currency', 'page_path', 'path']);
const MAX_PROP_VALUES = 60;

export function parseProps(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      out[k] = String(v).slice(0, 120);
    }
    return out;
  } catch {
    return {};
  }
}

/** Visitors + completions per label, most visitors first. */
function tally(items: { label: string; visitor: string; extra?: string | null }[]): CountRow[] {
  const m = new Map<string, { v: Set<string>; n: number; extra?: string | null }>();
  for (const it of items) {
    const e = m.get(it.label) ?? { v: new Set<string>(), n: 0, extra: it.extra };
    e.v.add(it.visitor);
    e.n++;
    if (!e.extra && it.extra) e.extra = it.extra;
    m.set(it.label, e);
  }
  return [...m.entries()]
    .map(([label, e]) => ({ label, visitors: e.v.size, completions: e.n, ...(e.extra ? { extra: e.extra } : {}) }))
    .sort((a, b) => b.visitors - a.visitors || b.completions - a.completions || a.label.localeCompare(b.label));
}

export interface GoalReport {
  visitors: number;
  completions: number;
  /** The page people were on when they did it. */
  pages: CountRow[];
  /** One breakdown per descriptive prop (placement, plan, provider…), busiest first. */
  props: { key: string; rows: CountRow[] }[];
  /** Where the visit that led to it came from. */
  sources: CountRow[];
  /** The first page of that visit. */
  entries: CountRow[];
  /** Pages seen earlier in that visit, as a share of the people who did it. */
  before: CountRow[];
  /** First visit / 2nd-3rd / 4th or later, counting each visitor once (their first completion). */
  visits: CountRow[];
}

export function summarizeGoal(rows: GoalRow[], before: BeforeRow[]): GoalReport {
  const visitors = new Set(rows.map((r) => r.visitor_id));

  const propItems = new Map<string, { label: string; visitor: string }[]>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(parseProps(r.props))) {
      if (SKIP_PROPS.has(k)) continue;
      const list = propItems.get(k) ?? [];
      list.push({ label: v, visitor: r.visitor_id });
      propItems.set(k, list);
    }
  }
  const props = [...propItems.entries()]
    .map(([key, items]) => ({ key, rows: tally(items), seen: items.length }))
    // Ids slip through under other names: a key whose values are nearly all different isn't a breakdown.
    .filter((p) => p.rows.length <= MAX_PROP_VALUES && !(p.rows.length > 5 && p.rows.length > p.seen * 0.8))
    .sort((a, b) => b.seen - a.seen || a.key.localeCompare(b.key))
    .map(({ key, rows }) => ({ key, rows }));

  // A visitor's first completion decides which visit it was.
  const first = new Map<string, GoalRow>();
  for (const r of rows) {
    const f = first.get(r.visitor_id);
    if (!f || r.ts < f.ts) first.set(r.visitor_id, r);
  }
  const visitLabel = (n: number) => (n <= 1 ? 'First visit' : n <= 3 ? '2nd or 3rd visit' : '4th visit or later');
  const order = ['First visit', '2nd or 3rd visit', '4th visit or later'];
  const visits = tally([...first.values()].map((r) => ({ label: visitLabel(r.visit_no), visitor: r.visitor_id }))).sort(
    (a, b) => order.indexOf(a.label) - order.indexOf(b.label),
  );

  // Each page counts a visitor once however often they viewed it.
  const seen = new Set<string>();
  const beforeItems: { label: string; visitor: string }[] = [];
  for (const b of before) {
    const key = `${b.visitor_id}\n${b.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    beforeItems.push({ label: b.path, visitor: b.visitor_id });
  }

  return {
    visitors: visitors.size,
    completions: rows.length,
    pages: tally(rows.map((r) => ({ label: r.path ?? '(unknown)', visitor: r.visitor_id }))),
    props,
    sources: tally(rows.map((r) => ({ label: r.source ?? 'Direct/None', visitor: r.visitor_id, extra: r.referrer_domain }))),
    entries: tally(rows.map((r) => ({ label: r.entry_page ?? '(unknown)', visitor: r.visitor_id }))),
    before: tally(beforeItems),
    visits,
  };
}

// ---------- funnels

export interface FunnelStep {
  type: 'page' | 'goal';
  /** Page paths support * wildcards (/blog/*). Goals may list alternatives: "purchase, trial_start". */
  value: string;
  label?: string;
}

export interface FunnelEvent {
  v: string;
  ts: number;
  type: string;
  name: string | null;
  path: string;
  props: string | null;
  source: string | null;
  entry_page: string | null;
}

/** "source", "entry_page", or "prop:<key>" (read from the first goal step's event). */
export type FunnelSplit = '' | 'source' | 'entry_page' | `prop:${string}`;

export const goalNames = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function stepMatcher(st: FunnelStep): (e: FunnelEvent) => boolean {
  if (st.type === 'goal') {
    const names = new Set(goalNames(st.value));
    return (e) => e.type === 'goal' && e.name !== null && names.has(e.name);
  }
  const re = new RegExp('^' + st.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return (e) => e.type === 'pageview' && re.test(e.path);
}

export interface FunnelResult {
  steps: (FunnelStep & { visitors: number })[];
  /** Per split value: visitors reaching each step. Empty without a split. */
  groups: { label: string; counts: number[] }[];
  /** Prop keys the first goal step carries, offered as splits. */
  splitKeys: string[];
}

const MAX_GROUPS = 25;

/**
 * Visitors who completed each step in order within the period. With a split, each visitor is
 * grouped by where they were at the step that defines the split: the first step for source and
 * landing page, the first goal step for a prop (which Go Pro button they clicked, say).
 */
export function funnelProgress(events: FunnelEvent[], steps: FunnelStep[], split: FunnelSplit = ''): FunnelResult {
  const matchers = steps.map(stepMatcher);
  const propStep = steps.findIndex((s) => s.type === 'goal');
  const progress = new Map<string, number>();
  const group = new Map<string, string>();
  const keys = new Set<string>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const at = progress.get(e.v) ?? 0;
    if (at >= steps.length || !matchers[at](e)) continue;
    progress.set(e.v, at + 1);
    if (at === propStep) for (const k of Object.keys(parseProps(e.props))) if (!SKIP_PROPS.has(k)) keys.add(k);
    if (!split) continue;
    if (split.startsWith('prop:')) {
      if (at === propStep) group.set(e.v, parseProps(e.props)[split.slice(5)] ?? '(not set)');
    } else if (at === 0) {
      group.set(e.v, (split === 'source' ? e.source ?? 'Direct/None' : e.entry_page) ?? '(unknown)');
    }
  }

  const counts = steps.map(() => 0);
  const byGroup = new Map<string, number[]>();
  for (const [v, reached] of progress) {
    for (let i = 0; i < reached; i++) counts[i]++;
    const g = group.get(v);
    if (g === undefined) continue;
    const c = byGroup.get(g) ?? steps.map(() => 0);
    for (let i = 0; i < reached; i++) c[i]++;
    byGroup.set(g, c);
  }
  // Grouped by a goal prop, people who never reached that step have no group; the rows then start there.
  const groups = [...byGroup.entries()]
    .map(([label, c]) => ({ label, counts: c }))
    .sort((a, b) => b.counts[0] - a.counts[0] || b.counts.at(-1)! - a.counts.at(-1)! || a.label.localeCompare(b.label))
    .slice(0, MAX_GROUPS);

  return { steps: steps.map((st, i) => ({ ...st, visitors: counts[i] })), groups, splitKeys: [...keys].sort() };
}

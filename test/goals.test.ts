import { describe, expect, it } from 'vitest';
import { funnelProgress, summarizeGoal, type FunnelEvent, type GoalRow } from '../src/worker/goals';

const goal = (o: Partial<GoalRow>): GoalRow => ({
  visitor_id: 'v1',
  session_id: 's1',
  ts: 1,
  path: '/',
  props: null,
  source: 'Google',
  referrer_domain: 'google.com',
  entry_page: '/',
  visit_no: 1,
  ...o,
});

describe('summarizeGoal', () => {
  it('counts pages, sources and landing pages by visitor', () => {
    const r = summarizeGoal(
      [
        goal({ visitor_id: 'a', path: '/rankings', entry_page: '/blog/x' }),
        goal({ visitor_id: 'a', path: '/rankings', entry_page: '/blog/x', ts: 2 }),
        goal({ visitor_id: 'b', path: '/pro', source: 'Reddit', referrer_domain: 'reddit.com', entry_page: '/' }),
      ],
      [],
    );
    expect(r.visitors).toBe(2);
    expect(r.completions).toBe(3);
    expect(r.pages[0]).toEqual({ label: '/rankings', visitors: 1, completions: 2 });
    expect(r.sources.map((s) => s.label).sort()).toEqual(['Google', 'Reddit']);
    expect(r.sources.find((s) => s.label === 'Reddit')?.extra).toBe('reddit.com');
    expect(r.entries.map((e) => e.label).sort()).toEqual(['/', '/blog/x']);
  });

  it('breaks down descriptive props and skips ids and prices', () => {
    const rows = ['header', 'header', 'sidebar'].map((placement, i) =>
      goal({ visitor_id: `v${i}`, props: JSON.stringify({ placement, transaction_id: `sub_${i}`, value: 20, page_path: '/x' }) }),
    );
    const r = summarizeGoal(rows, []);
    expect(r.props.map((p) => p.key)).toEqual(['placement']);
    expect(r.props[0].rows).toEqual([
      { label: 'header', visitors: 2, completions: 2 },
      { label: 'sidebar', visitors: 1, completions: 1 },
    ]);
  });

  it('drops props whose values are nearly all different', () => {
    const rows = Array.from({ length: 10 }, (_, i) => goal({ visitor_id: `v${i}`, props: JSON.stringify({ player: `p${i}`, plan: 'yearly' }) }));
    expect(summarizeGoal(rows, []).props.map((p) => p.key)).toEqual(['plan']);
  });

  it('uses each visitor’s first completion for the visit number', () => {
    const r = summarizeGoal(
      [
        goal({ visitor_id: 'a', ts: 5, visit_no: 4 }),
        goal({ visitor_id: 'a', ts: 1, visit_no: 1 }),
        goal({ visitor_id: 'b', ts: 2, visit_no: 2 }),
      ],
      [],
    );
    expect(r.visits).toEqual([
      { label: 'First visit', visitors: 1, completions: 1 },
      { label: '2nd or 3rd visit', visitors: 1, completions: 1 },
    ]);
  });

  it('counts a page seen on the way once per visitor', () => {
    const r = summarizeGoal(
      [goal({ visitor_id: 'a' }), goal({ visitor_id: 'b' })],
      [
        { visitor_id: 'a', path: '/blog/x' },
        { visitor_id: 'a', path: '/blog/x' },
        { visitor_id: 'b', path: '/blog/x' },
        { visitor_id: 'b', path: '/pro' },
      ],
    );
    expect(r.before[0]).toEqual({ label: '/blog/x', visitors: 2, completions: 2 });
    expect(r.before[1]).toEqual({ label: '/pro', visitors: 1, completions: 1 });
  });
});

const ev = (o: Partial<FunnelEvent>): FunnelEvent => ({
  v: 'v1',
  ts: 1,
  type: 'pageview',
  name: null,
  path: '/',
  props: null,
  source: 'Google',
  entry_page: '/',
  ...o,
});

describe('funnelProgress', () => {
  const steps = [
    { type: 'page' as const, value: '/*' },
    { type: 'goal' as const, value: 'go_pro_click' },
    { type: 'goal' as const, value: 'purchase, trial_start' },
  ];
  const events = [
    ev({ v: 'a', ts: 1, source: 'Reddit' }),
    ev({ v: 'a', ts: 2, type: 'goal', name: 'go_pro_click', props: JSON.stringify({ placement: 'header' }) }),
    ev({ v: 'a', ts: 3, type: 'goal', name: 'trial_start' }),
    ev({ v: 'b', ts: 1 }),
    ev({ v: 'b', ts: 2, type: 'goal', name: 'go_pro_click', props: JSON.stringify({ placement: 'sidebar' }) }),
    ev({ v: 'c', ts: 1 }),
    // Out of order: a purchase before any click doesn't count as step 3.
    ev({ v: 'd', ts: 1 }),
    ev({ v: 'd', ts: 2, type: 'goal', name: 'purchase' }),
  ];

  it('counts steps in order and accepts alternative goals', () => {
    expect(funnelProgress(events, steps).steps.map((s) => s.visitors)).toEqual([4, 2, 1]);
  });

  it('splits by the first step’s source', () => {
    const r = funnelProgress(events, steps, 'source');
    expect(r.groups).toEqual([
      { label: 'Google', counts: [3, 1, 0] },
      { label: 'Reddit', counts: [1, 1, 1] },
    ]);
  });

  it('splits by a prop of the first goal step and offers its keys', () => {
    const r = funnelProgress(events, steps, 'prop:placement');
    expect(r.splitKeys).toEqual(['placement']);
    expect(r.groups).toEqual([
      { label: 'header', counts: [1, 1, 1] },
      { label: 'sidebar', counts: [1, 1, 0] },
    ]);
  });
});

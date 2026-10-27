import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { normalizePath } from './collect';
import { bucketSql, tzOffset } from './lib/time';
import { currencyDecimals, siteFromApiKey } from './payments';
import { findKnownSource } from '../shared/sources';

// Ad revenue (e.g. Raptive, AdSense). The ad network reports a day's earnings the next morning, so:
//  - a reported day is spread over that day's human pageviews by rate, scaled to exactly what was paid;
//  - a day not reported yet (today) is estimated from its human pageviews x their rates.
// A pageview's rate is a base rate x its page's factor x its traffic source's factor, all from recent
// reported days: a Reddit visitor can be worth a fraction of a direct one on the same page. Rates are
// per human pageview *as Minilytics counts them*, so the gap between the ad network's pageview count
// and ours is already priced in.

/** Most recent reported days used to work out the rates. */
const RATE_DAYS = 28;
/** Pageviews a page or source needs before its own rate outweighs the average. */
const PRIOR_PAGEVIEWS = 100;
const MAX_DAYS_PER_CALL = 62;
const MAX_PAGES_PER_DAY = 20_000;
const MAX_SOURCES_PER_DAY = 500;
// D1 allows 100 bound parameters per statement.
const ROWS_PER_INSERT = 16;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
/** ad_rates key prefix for a traffic source's factor. Paths start with '/', so the keys never collide. */
const SOURCE_KEY = 'source:';

export interface ViewCount {
  path: string;
  source: string;
  n: number;
}

/** An ad network report (by page or by source): what each key earned, and our human pageviews on its days. */
export interface AdReport {
  earnings: Map<string, number>;
  views: ViewCount[];
}

/** How a key's share of earnings compares with its share of pageviews, pulled toward 1 when it has few. */
const shrunk = (expectedViews: number, views: number) => (expectedViews + PRIOR_PAGEVIEWS) / (views + PRIOR_PAGEVIEWS);

function total(values: Iterable<number>) {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

/**
 * The ad network's traffic source label as a Minilytics source name ("Google Search" -> "Google",
 * "Direct" -> "Direct/None"), or '' when it names no source we know ("Other").
 */
export function adSourceName(label: string): string {
  const k = label.trim().toLowerCase();
  if (/^\(?direct\)?(\s*\/\s*\(?none\)?)?$/.test(k)) return 'Direct/None';
  return (findKnownSource(k) ?? findKnownSource(k.split(/\s+/)[0]))?.name ?? '';
}

/**
 * Ad rates from `earnings` over `views` (human pageviews by page and source): '*' is the base rate per
 * pageview, a path's rate is base x its page factor, and 'source:<name>' is a source's factor, with
 * 'source:' for every source the network doesn't name. A pageview is worth (path rate, else '*') x
 * (its source's factor, else 'source:', else 1). Source factors come first, so a page read mostly by
 * low-paying visitors isn't marked down twice. Null when there are no pageviews to price.
 */
export function computeAdRates(
  earnings: number,
  views: ViewCount[],
  pages?: AdReport | null,
  sources?: AdReport | null,
): Map<string, number> | null {
  const bucket = (source: string) => (sources?.earnings.has(source) ? source : '');
  const sourceFactor = new Map<string, number>();
  const sourceEarnings = sources ? total(sources.earnings.values()) : 0;
  if (sources && sourceEarnings > 0) {
    const bySource = new Map<string, number>();
    for (const v of sources.views) bySource.set(bucket(v.source), (bySource.get(bucket(v.source)) ?? 0) + v.n);
    const sourceViews = total(bySource.values());
    if (sourceViews) {
      for (const [s, e] of sources.earnings) sourceFactor.set(s, shrunk((e * sourceViews) / sourceEarnings, bySource.get(s) ?? 0));
    }
  }
  const factorOf = (source: string) => sourceFactor.get(bucket(source)) ?? 1;

  // Page factors compare a page's earnings with its pageviews weighted by where they came from.
  const pageFactor = new Map<string, number>();
  const pageEarnings = pages ? total(pages.earnings.values()) : 0;
  if (pages && pageEarnings > 0) {
    const weighted = new Map<string, number>();
    for (const v of pages.views) weighted.set(v.path, (weighted.get(v.path) ?? 0) + v.n * factorOf(v.source));
    const weightedViews = total(weighted.values());
    if (weightedViews) {
      for (const [path, w] of weighted) pageFactor.set(path, shrunk(((pages.earnings.get(path) ?? 0) * weightedViews) / pageEarnings, w));
    }
  }

  let expected = 0;
  for (const v of views) expected += v.n * (pageFactor.get(v.path) ?? 1) * factorOf(v.source);
  if (!expected) return null;
  const base = earnings / expected;
  const rates = new Map([['*', base]]);
  for (const [path, f] of pageFactor) rates.set(path, base * f);
  for (const [s, f] of sourceFactor) rates.set(SOURCE_KEY + s, f);
  return rates;
}

/** Human pageviews (events `e` joined to sessions `s`); `joins` adds tables before the WHERE. Binds the site id. */
const humanViews = (joins = '') => `events e JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id ${joins}
  WHERE e.site_id = ? AND e.type = 'pageview' AND s.human = 1`;

/** Tables for AD_RATE, on events `e` joined to sessions `s`. */
export const AD_RATE_JOINS = `JOIN ad_rates w ON w.site_id = e.site_id AND w.path = '*'
  LEFT JOIN ad_rates r ON r.site_id = e.site_id AND r.path = e.path
  LEFT JOIN ad_rates m ON m.site_id = e.site_id AND m.path = '${SOURCE_KEY}' || s.source
  LEFT JOIN ad_rates o ON o.site_id = e.site_id AND o.path = '${SOURCE_KEY}'`;
/** Each pageview's ad rate: its page's (else the base one) x its source's factor (else the rest's, else 1). */
export const AD_RATE = 'COALESCE(r.rate, w.rate) * COALESCE(m.rate, o.rate, 1)';

/**
 * Added after the first ad revenue release; created on use so existing installs need no migration
 * (same as migrations/0006_ad_sources.sql).
 */
export const adSourcesTable = (db: D1Database) =>
  db.prepare(`CREATE TABLE IF NOT EXISTS ad_sources (
    site_id TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL, earnings REAL NOT NULL, pageviews INTEGER NOT NULL,
    PRIMARY KEY (site_id, day, source))`);

/** Midnight of a YYYY-MM-DD day, using one fixed offset (the same one the day SQL uses). */
const dayStart = (day: string, offset: number) => Date.parse(day + 'T00:00:00Z') - offset;

/** Rebuilds ad_rates from the latest reported days, then each reported day's `est`. Returns how many pages got a rate. */
export async function recomputeAdRates(db: D1Database, site: Site): Promise<number> {
  const offset = tzOffset(site.timezone);
  const day = bucketSql('e.ts', 'day', offset);

  // The first day with human visits was only partly tracked; pricing it would overstate the rate.
  const first = await db
    .prepare(`SELECT MIN(started_at) AS t FROM sessions WHERE site_id = ? AND human = 1`)
    .bind(site.id)
    .first<{ t: number | null }>();
  if (!first?.t) return 0;
  const firstFullDay = new Date(first.t + offset + DAY).toISOString().slice(0, 10);

  const window = (
    await db
      .prepare(`SELECT day, earnings FROM ad_days WHERE site_id = ? AND day >= ? ORDER BY day DESC LIMIT ?`)
      .bind(site.id, firstFullDay, RATE_DAYS)
      .all<{ day: string; earnings: number }>()
  ).results;

  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM ad_rates WHERE site_id = ?').bind(site.id)];
  let rates: Map<string, number> | null = null;
  if (window.length) {
    const from = window[window.length - 1].day;
    const inWindow = `IN (SELECT day FROM ad_days WHERE site_id = ? AND day >= ? ORDER BY day DESC LIMIT ${RATE_DAYS})`;
    const [views, pages, pageDays, sources, sourceDays] = await db.batch([
      db
        .prepare(
          `SELECT ${day} AS day, e.path AS path, s.source AS source, COUNT(*) AS n
           FROM ${humanViews()} AND e.ts >= ? AND ${day} ${inWindow} GROUP BY 1, 2, 3`,
        )
        .bind(site.id, dayStart(from, offset), site.id, firstFullDay),
      db.prepare(`SELECT path AS k, SUM(earnings) AS e FROM ad_pages WHERE site_id = ? AND day ${inWindow} GROUP BY path`).bind(site.id, site.id, firstFullDay),
      db.prepare(`SELECT DISTINCT day FROM ad_pages WHERE site_id = ? AND day ${inWindow}`).bind(site.id, site.id, firstFullDay),
      db.prepare(`SELECT source AS k, SUM(earnings) AS e FROM ad_sources WHERE site_id = ? AND day ${inWindow} GROUP BY source`).bind(site.id, site.id, firstFullDay),
      db.prepare(`SELECT DISTINCT day FROM ad_sources WHERE site_id = ? AND day ${inWindow}`).bind(site.id, site.id, firstFullDay),
    ]);
    const viewRows = views.results as (ViewCount & { day: string })[];
    // Each report is matched with our pageviews on the days it covers (it can lag the earnings by a day).
    const report = (earned: D1Result, days: D1Result): AdReport | null => {
      if (!earned.results.length) return null;
      const covered = new Set((days.results as { day: string }[]).map((r) => r.day));
      return {
        earnings: new Map((earned.results as { k: string; e: number }[]).map((r) => [r.k, r.e])),
        views: viewRows.filter((v) => covered.has(v.day)),
      };
    };
    rates = computeAdRates(
      window.reduce((a, d) => a + d.earnings, 0),
      viewRows,
      report(pages, pageDays),
      report(sources, sourceDays),
    );
  }
  if (!rates) {
    // No fully tracked day reported yet (e.g. the morning after setup): price by the ad network's own
    // pageviews until there is one. Usually a bit low, since Minilytics counts fewer pageviews.
    const [days, pages] = await db.batch([
      db.prepare(`SELECT SUM(earnings) AS e FROM ad_days WHERE site_id = ? AND day IN (SELECT day FROM ad_pages WHERE site_id = ?)`).bind(site.id, site.id),
      db.prepare(`SELECT path, SUM(earnings) AS e, SUM(pageviews) AS n FROM ad_pages WHERE site_id = ? GROUP BY path`).bind(site.id),
    ]);
    const network = pages.results as { path: string; e: number; n: number }[];
    const networkViews = network.map((r) => ({ path: r.path, source: '', n: r.n }));
    rates = computeAdRates((days.results[0] as { e: number | null } | undefined)?.e ?? 0, networkViews, {
      earnings: new Map(network.map((r) => [r.path, r.e])),
      views: networkViews,
    });
  }
  const rows = [...(rates ?? [])];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    stmts.push(
      db
        .prepare(`INSERT INTO ad_rates (site_id, path, rate) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`)
        .bind(...chunk.flatMap(([path, rate]) => [site.id, path, rate])),
    );
  }

  // What the rates predict for each reported day; the dashboard scales by earnings / est.
  stmts.push(db.prepare('UPDATE ad_days SET est = 0 WHERE site_id = ?').bind(site.id));
  await db.batch(stmts);
  if (!rates) return 0;
  const est = await db
    .prepare(
      `SELECT ${day} AS day, SUM(${AD_RATE}) AS est
       FROM ${humanViews(AD_RATE_JOINS)} AND e.ts >= ? AND ${day} IN (SELECT day FROM ad_days WHERE site_id = ?)
       GROUP BY 1`,
    )
    .bind(site.id, dayStart(firstFullDay, offset) - DAY, site.id)
    .all<{ day: string; est: number }>();
  if (est.results.length) {
    await db.batch(
      est.results.map((r) => db.prepare('UPDATE ad_days SET est = ? WHERE site_id = ? AND day = ?').bind(r.est, site.id, r.day)),
    );
  }
  return rows.filter(([k]) => k.startsWith('/')).length;
}

interface AdRowInput {
  key: string;
  earnings: number;
  pageviews: number;
}

/** Sums a day's report rows by key; rows without a string `field`, or whose key comes out null, are skipped. */
function sumReport(rows: unknown[], field: string, key: (raw: string) => string | null, minor: number): AdRowInput[] {
  const byKey = new Map<string, AdRowInput>();
  for (const p of rows as Record<string, unknown>[]) {
    const raw = p?.[field];
    if (typeof raw !== 'string') continue;
    const k = key(raw);
    if (k === null) continue;
    const row = byKey.get(k) ?? { key: k, earnings: 0, pageviews: 0 };
    row.earnings += Math.max(0, Number(p.earnings) || 0) * minor;
    row.pageviews += Math.max(0, Math.round(Number(p.pageviews) || 0));
    byKey.set(k, row);
  }
  return [...byKey.values()];
}

/** Replaces one day's rows of a report table (ad_pages or ad_sources). */
function replaceDay(db: D1Database, site: Site, table: 'ad_pages' | 'ad_sources', col: 'path' | 'source', day: string, rows: AdRowInput[]) {
  const stmts = [db.prepare(`DELETE FROM ${table} WHERE site_id = ? AND day = ?`).bind(site.id, day)];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    stmts.push(
      db
        .prepare(`INSERT INTO ${table} (site_id, day, ${col}, earnings, pageviews) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
        .bind(...chunk.flatMap((r) => [site.id, day, r.key, r.earnings, r.pageviews])),
    );
  }
  return stmts;
}

/**
 * Ad network earnings, sent by the site's backend once the network reports a day.
 * POST /api/v1/ad-revenue  Authorization: Bearer <site api key>
 * { "days": [{ "date": "2026-10-25", "earnings": 41.27,
 *              "pages": [{ "path": "/blog/some-post", "earnings": 3.10, "pageviews": 220 }],
 *              "sources": [{ "source": "Google Search", "earnings": 12.40, "pageviews": 900 }] }] }
 * Amounts are in major units (dollars). Sending a day again replaces it; leave out `pages` or `sources` to
 * keep that day's report (e.g. while the network's traffic numbers for it are still partial).
 */
export async function handleAdRevenueApi(c: Context<AppEnv>) {
  const site = await siteFromApiKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  const b = await c.req.json<{ days?: unknown }>().catch(() => null);
  const days = Array.isArray(b?.days) ? (b.days as Record<string, unknown>[]) : null;
  if (!days?.length || days.length > MAX_DAYS_PER_CALL) {
    return c.json({ error: `days must be a list of 1 to ${MAX_DAYS_PER_CALL} { date, earnings, pages?, sources? }` }, 400);
  }
  const minor = 10 ** currencyDecimals(site.currency);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [adSourcesTable(db)];
  let pageRows = 0;
  let sourceRows = 0;
  for (const d of days) {
    const earnings = Number(d?.earnings);
    if (typeof d?.date !== 'string' || !DAY_RE.test(d.date) || !Number.isFinite(earnings) || earnings < 0) {
      return c.json({ error: 'each day needs date (YYYY-MM-DD) and earnings (a number, e.g. 41.27)' }, 400);
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO ad_days (site_id, day, earnings) VALUES (?, ?, ?)
           ON CONFLICT (site_id, day) DO UPDATE SET earnings = excluded.earnings`,
        )
        .bind(site.id, d.date, earnings * minor),
    );
    if (Array.isArray(d.pages)) {
      // Same path rules as the tracker, so pages line up with pageviews.
      const rows = sumReport(d.pages.slice(0, MAX_PAGES_PER_DAY), 'path', (p) => normalizePath(p.split(/[?#]/)[0]), minor);
      pageRows += rows.length;
      stmts.push(...replaceDay(db, site, 'ad_pages', 'path', d.date, rows));
    }
    if (Array.isArray(d.sources)) {
      const rows = sumReport(d.sources.slice(0, MAX_SOURCES_PER_DAY), 'source', adSourceName, minor);
      sourceRows += rows.length;
      stmts.push(...replaceDay(db, site, 'ad_sources', 'source', d.date, rows));
    }
  }
  await db.batch(stmts);
  const pricedPages = await recomputeAdRates(db, site);
  return c.json({ ok: true, days: days.length, pages: pageRows, sources: sourceRows, priced_pages: pricedPages });
}

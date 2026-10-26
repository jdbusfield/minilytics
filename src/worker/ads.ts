import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { normalizePath } from './collect';
import { bucketSql, tzOffset } from './lib/time';
import { currencyDecimals, siteFromApiKey } from './payments';

// Ad revenue (e.g. Raptive, AdSense). The ad network reports a day's earnings the next morning, so:
//  - a reported day is spread over that day's human pageviews by page rate, scaled to exactly what was paid;
//  - a day not reported yet (today) is estimated from its human pageviews x the page rates.
// Rates are earnings per human pageview *as Minilytics counts them*, so the gap between the ad network's
// pageview count and ours is already priced in.

/** Most recent reported days used to work out the rates. */
const RATE_DAYS = 28;
/** Pageviews a page needs before its own rate outweighs the sitewide one. */
const PRIOR_PAGEVIEWS = 100;
const MAX_DAYS_PER_CALL = 62;
const MAX_PAGES_PER_DAY = 20_000;
// D1 allows 100 bound parameters per statement.
const ROWS_PER_INSERT = 16;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

/**
 * Earnings per human pageview, per path, plus '*' for the whole site. A page with few pageviews leans on
 * the sitewide rate. Page earnings are scaled to the daily total (the per-page report runs a few % above it).
 * Null when there are no pageviews to price.
 */
export function computeAdRates(
  earnings: number,
  pageEarnings: Map<string, number>,
  humanPageviews: Map<string, number>,
): Map<string, number> | null {
  let views = 0;
  for (const n of humanPageviews.values()) views += n;
  if (!views) return null;
  const site = earnings / views;
  const rates = new Map([['*', site]]);
  let pageSum = 0;
  for (const e of pageEarnings.values()) pageSum += e;
  if (pageSum <= 0) return rates;
  const k = earnings / pageSum;
  for (const [path, n] of humanPageviews) {
    rates.set(path, ((pageEarnings.get(path) ?? 0) * k + PRIOR_PAGEVIEWS * site) / (n + PRIOR_PAGEVIEWS));
  }
  return rates;
}

/** Human pageviews (events `e` joined to sessions `s`); `joins` adds tables before the WHERE. Binds the site id. */
const humanViews = (joins = '') => `events e JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id ${joins}
  WHERE e.site_id = ? AND e.type = 'pageview' AND s.human = 1`;

/** Each pageview's ad rate: `COALESCE(r.rate, w.rate)` (its page's, else the sitewide one). */
export const AD_RATE_JOINS = `JOIN ad_rates w ON w.site_id = e.site_id AND w.path = '*'
  LEFT JOIN ad_rates r ON r.site_id = e.site_id AND r.path = e.path`;

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
    const [views, pages] = await db.batch([
      db
        .prepare(`SELECT e.path AS path, COUNT(*) AS n FROM ${humanViews()} AND e.ts >= ? AND ${day} ${inWindow} GROUP BY e.path`)
        .bind(site.id, dayStart(from, offset), site.id, firstFullDay),
      db
        .prepare(`SELECT path, SUM(earnings) AS e FROM ad_pages WHERE site_id = ? AND day ${inWindow} GROUP BY path`)
        .bind(site.id, site.id, firstFullDay),
    ]);
    rates = computeAdRates(
      window.reduce((a, d) => a + d.earnings, 0),
      new Map((pages.results as { path: string; e: number }[]).map((r) => [r.path, r.e])),
      new Map((views.results as { path: string; n: number }[]).map((r) => [r.path, r.n])),
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
    rates = computeAdRates(
      (days.results[0] as { e: number | null } | undefined)?.e ?? 0,
      new Map(network.map((r) => [r.path, r.e])),
      new Map(network.map((r) => [r.path, r.n])),
    );
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
      `SELECT ${day} AS day, SUM(COALESCE(r.rate, w.rate)) AS est
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
  return rates.size - 1;
}

interface AdPageInput {
  path: string;
  earnings: number;
  pageviews: number;
}

/**
 * Ad network earnings, sent by the site's backend once the network reports a day.
 * POST /api/v1/ad-revenue  Authorization: Bearer <site api key>
 * { "days": [{ "date": "2026-10-25", "earnings": 41.27,
 *              "pages": [{ "path": "/blog/some-post", "earnings": 3.10, "pageviews": 220 }] }] }
 * Amounts are in major units (dollars). Sending a day again replaces it; leave out `pages` to keep that
 * day's page report (e.g. while the network's traffic numbers for it are still partial).
 */
export async function handleAdRevenueApi(c: Context<AppEnv>) {
  const site = await siteFromApiKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  const b = await c.req.json<{ days?: unknown }>().catch(() => null);
  const days = Array.isArray(b?.days) ? (b.days as Record<string, unknown>[]) : null;
  if (!days?.length || days.length > MAX_DAYS_PER_CALL) {
    return c.json({ error: `days must be a list of 1 to ${MAX_DAYS_PER_CALL} { date, earnings, pages? }` }, 400);
  }
  const minor = 10 ** currencyDecimals(site.currency);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  let pageRows = 0;
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
    if (!Array.isArray(d.pages)) continue;

    // Same path rules as the tracker, so pages line up with pageviews.
    const byPath = new Map<string, AdPageInput>();
    for (const p of (d.pages as Record<string, unknown>[]).slice(0, MAX_PAGES_PER_DAY)) {
      if (typeof p?.path !== 'string') continue;
      const path = normalizePath(p.path.split(/[?#]/)[0]);
      const row = byPath.get(path) ?? { path, earnings: 0, pageviews: 0 };
      row.earnings += Math.max(0, Number(p.earnings) || 0) * minor;
      row.pageviews += Math.max(0, Math.round(Number(p.pageviews) || 0));
      byPath.set(path, row);
    }
    stmts.push(db.prepare('DELETE FROM ad_pages WHERE site_id = ? AND day = ?').bind(site.id, d.date));
    const rows = [...byPath.values()];
    pageRows += rows.length;
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + ROWS_PER_INSERT);
      stmts.push(
        db
          .prepare(`INSERT INTO ad_pages (site_id, day, path, earnings, pageviews) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
          .bind(...chunk.flatMap((r) => [site.id, d.date, r.path, r.earnings, r.pageviews])),
      );
    }
  }
  await db.batch(stmts);
  const pricedPages = await recomputeAdRates(db, site);
  return c.json({ ok: true, days: days.length, pages: pageRows, priced_pages: pricedPages });
}

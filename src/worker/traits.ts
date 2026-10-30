import { belongsTo } from './collect';

/**
 * What identify() can add about a signed-in visitor beyond name and email: their plan ("pro", "free")
 * and a link to them in your own admin. Added after the first release; created on use so existing
 * installs need no migration (same as migrations/0007_visitor_traits.sql).
 */
export const visitorTraitsTable = (db: D1Database) =>
  db.prepare(`CREATE TABLE IF NOT EXISTS visitor_traits (
    site_id TEXT NOT NULL, visitor_id TEXT NOT NULL, plan TEXT, url TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (site_id, visitor_id))`);

let ready: Promise<unknown> | null = null;
/** Creates the table once per Worker instance, before the first read that joins it. */
export function ensureVisitorTraits(db: D1Database) {
  ready ??= visitorTraitsTable(db)
    .run()
    .catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}

/** The admin link, only when it points at the site's own domain: the dashboard renders it as a link. */
export function traitUrl(s: unknown, domain: string): string | null {
  if (typeof s !== 'string' || s.length > 500) return null;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && belongsTo(u.hostname, domain) ? u.href : null;
  } catch {
    return null;
  }
}

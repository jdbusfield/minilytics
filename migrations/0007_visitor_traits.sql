-- What identify() says about a signed-in visitor beyond name and email: their plan ("pro", "free") and
-- a link to them in your own admin (only kept when it's on the site's domain). The Worker also creates
-- this table itself on first use (src/worker/traits.ts), so running this migration by hand is optional.
CREATE TABLE IF NOT EXISTS visitor_traits (
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  plan TEXT,
  url TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, visitor_id)
);

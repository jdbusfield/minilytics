-- The ad network's earnings by traffic source (Google, Reddit, Direct...), sent with each day like the
-- page report. `source` is the Minilytics source name the network's label matches, or '' for the rest.
-- The Worker also creates this table itself on the first ad revenue call (src/worker/ads.ts), so running
-- this migration by hand is optional.
CREATE TABLE IF NOT EXISTS ad_sources (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  earnings REAL NOT NULL,
  pageviews INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, source)
);

-- Ad network earnings, sent by the site's backend (POST /api/v1/ad-revenue). Amounts are in minor units
-- (cents) and can be fractional. Days are calendar days in the site's time zone.

-- What the ad network paid for a day. `est` is what the page rates below predict for that day's human
-- pageviews; each pageview is scaled by earnings / est so the day adds up to exactly what was paid.
CREATE TABLE ad_days (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  earnings REAL NOT NULL,
  est REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day)
);

-- The ad network's per-page report, used to work out what a pageview on each page is worth.
CREATE TABLE ad_pages (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  earnings REAL NOT NULL,
  pageviews INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, path)
);

-- Ad earnings per human pageview, per page, from recent days. Path '*' is the sitewide rate, used for
-- pages without their own.
CREATE TABLE ad_rates (
  site_id TEXT NOT NULL,
  path TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (site_id, path)
);

-- 1 when the visit had a real mouse, touch or key input (the tracker reports the first one).
-- Crawlers that run JavaScript load pages but never do this; the dashboard can show only these visits.
ALTER TABLE sessions ADD COLUMN human INTEGER NOT NULL DEFAULT 0;

-- Visits recorded before the tracker sent that signal: best guess from engaged time, leaving out
-- desktop Linux and unrecognised browsers, which is where headless crawlers show up.
UPDATE sessions SET human = 1 WHERE duration >= 5000 AND os != 'Other' AND NOT (os = 'Linux' AND device = 'Desktop');

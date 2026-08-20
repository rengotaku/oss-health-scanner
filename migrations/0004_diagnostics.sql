-- Per-source outcome for one analysis.
--
-- The health stage runs after the response is sent (ctx.waitUntil), and its
-- console output does not reach the local dev server's stdout, so a source that
-- fails silently is invisible. Recording the outcome per source makes "this
-- figure is N/A" answerable — both while developing and for a reader asking why
-- a panel is empty.

ALTER TABLE analyses ADD COLUMN diagnostics_json TEXT;

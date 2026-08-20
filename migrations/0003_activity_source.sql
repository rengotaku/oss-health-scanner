-- Records which source produced the activity figures.
--
-- GitHub's stats/* endpoints answer 202 Accepted while recomputing, and on busy
-- repositories that state persists (observed on curl/curl on 2026-08-20: four
-- consecutive 202s across an 8 second budget). When that happens the activity
-- numbers come from the ecosyste.ms past-year total, which has no 30/90-day
-- windows and no per-week breakdown, so those columns are NULL rather than 0.

ALTER TABLE activity_metrics ADD COLUMN source TEXT;

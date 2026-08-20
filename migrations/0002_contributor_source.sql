-- Records which source produced the contributor figures.
--
-- GitHub's per-contributor weekly statistics reach 29-71 MB on large
-- repositories (measured 2026-08-20 on kubernetes, curl and linux), which a
-- Worker cannot parse, so most analyses use the pre-aggregated ecosyste.ms
-- commit data instead. The two sources have different fidelity — notably the
-- 90-day window and per-contributor active weeks exist only in the GitHub
-- data — so which one was used has to be stored alongside the numbers.

ALTER TABLE contributor_metrics ADD COLUMN source TEXT;
ALTER TABLE contributor_metrics ADD COLUMN core_maintainers_partial INTEGER NOT NULL DEFAULT 0;

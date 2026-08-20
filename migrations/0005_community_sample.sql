-- Records the commit sample the concentration shares were drawn from.
--
-- Calibrated 2026-08-20: chalk/ansi-styles had 6 commits in the trailing year,
-- and the shares computed from them ("Top 1 67%" = 4 of 6, "Top 3 100%" = only
-- three people committed) were restatements of the sample size. Storing the
-- sample makes it possible to say why a share is N/A, and to re-evaluate the
-- threshold later without re-fetching.

ALTER TABLE contributor_metrics ADD COLUMN human_commits_365d INTEGER;
ALTER TABLE contributor_metrics ADD COLUMN sample_too_small INTEGER NOT NULL DEFAULT 0;

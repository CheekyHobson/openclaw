# Sidebar visible order attribution experiment

This experiment evaluates `visibleSessionRowsInOrder` in isolation. It makes no runtime change.

The previous campaign attributed about 1,304 ms inclusive to this function in a 240-event replay. The current implementation delegates row selection, section projection, and personal-pin resolution before concatenating the already ordered visible rows. Before proposing a cache, reproduce the function in the faithful Team-scale benchmark and distinguish its own work from work in its callees.

Use a quiet AWS c7a.4xlarge, repository Playwright Chromium, and the production bundle. Profile one baseline live-event replay with the source-mapped benchmark. A comparison requires a candidate that preserves pin descriptor arrival, snapshot handoff, grouping, selection, and snooze behavior within the lane's one-function limit. No performance improvement is claimed by this experiment.

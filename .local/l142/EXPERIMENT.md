# Older-history page-size experiment

Measure 1, 2, 3, and 5 MiB older-history budgets on synthetic normal and tool-heavy sessions through the Control UI history owner. Keep initial loading unchanged. Use one quiet AWS c7a.4xlarge lease, source-mapped CPU attribution, and at least seven interleaved baseline/candidate pairs before selecting a production change. Report page arrival frames, time to fill, requests to reach the beginning, raw bytes, and estimated compressed bytes separately.

This draft is an experiment transport for the campaign's fresh-PR remote-clone workflow. It must not merge without the measured result, a reviewed implementation, focused tests, and exact-head CI.

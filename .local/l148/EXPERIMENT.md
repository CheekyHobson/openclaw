# L148: timestamp formatting during backscroll

Compare unchanged timestamp rendering with locale/time-zone-keyed Intl formatter reuse using the canonical Team-scale bench and L142's synthetic older-history driver. Gate on seven interleaved baseline/candidate pairs on one AWS c7a.4xlarge: page-arrival frames and traversal improve, reload blocking does not regress. Preserve exact labels and accessibility strings. This draft is an experiment transport; do not merge.

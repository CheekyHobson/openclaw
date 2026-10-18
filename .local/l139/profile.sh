#!/usr/bin/env bash
set -euo pipefail
export CI=1
printf 'revision=%s\n' "$(git rev-parse HEAD)"
printf 'cpus=%s\n' "$(nproc)"
free -m
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium --with-deps
corepack pnpm exec tsx scripts/bench-control-ui-cold-load.ts \
  --runs 1 --live-events --session-event-churn --sidebar-view sessions --cpu-profile \
  --output .artifacts/l139-profile
l139_bundle=$(find .artifacts/l139-profile -mindepth 2 -maxdepth 2 -type d -name ui -print -quit)
corepack pnpm exec tsx scripts/bench-control-ui-cold-load.ts \
  --bundle-dir "$l139_bundle" --runs 1 --live-events --session-event-churn \
  --sidebar-view online --cpu-profile --output .artifacts/l139-online-profile

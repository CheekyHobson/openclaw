# Codex recovery fault injection

This opt-in integration fixture runs the real Gateway agent RPC, Codex harness, and an installed native app-server against a local synthetic Responses server (HTTP/SSE and WebSocket). An authenticated WebSocket proxy uses a non-loopback hostname mapped to loopback inside the child process, exercising remote transport selection. It requires Node 24 and prepared repository dependencies; it uses isolated HOME/config/state and no real credentials. It is not evidence of production networking, Linux, or Slack delivery.

Run from the repository root with a new, disposable output directory and an explicitly selected native binary:

```sh
OPENCLAW_CODEX_RECOVERY_BINARY=/absolute/path/to/codex \
  node --import ./scripts/tsx.mjs test/e2e/codex-recovery/repro.mjs \
  /absolute/path/to/new-output gateway-remote-active-lost-result-effect
```

`OPENCLAW_CODEX_RECOVERY_MODEL` optionally selects an installed catalog model (default `gpt-5.4`); model responses are entirely synthetic. No model API is contacted.

Scenarios:

- `gateway-remote-sibling-drift`: overload with changing persona text while a sibling stays active.
- `gateway-remote-active`: drop a tool request before delivery.
- `gateway-remote-active-lost-result-effect`: execute a file append, then drop its successful result.
- `gateway-remote-joint-drift-sibling-effect`: overload, prompt drift, then lose a completed tool result while a sibling runs.
- `gateway-remote-joint-model-fallback-drift-sibling-effect`: keep the primary model overloaded so a different model must recover, then exercise the same disconnect and side-effect checks.
- `gateway-remote-auth-fallback`: all three models fail without authentication; the fixture owner restores a synthetic native credential before the same-session and independent follow-up requests. OpenClaw does not manufacture credentials.
- `gateway-remote-auth-fallback-drift`: additionally change persona text after the failed request to exercise configuration handoff on the next request. The synthetic provider asserts that both follow-up requests receive the changed persona in their latest applicable developer message, preserving older instructions as history.
- `gateway-remote-active-lost-result-effect-restart`: kill and restart native after the side effect; require bounded failure plus successful new work.
- `gateway-remote-active-lost-result-effect-outage`: reject reconnections until the original request ends; then restore access and require new work.

Every repaired scenario asserts subsequent requests in both the same and an independent conversation complete. Effect scenarios assert the file contains exactly one marker. Successful original requests must emit one logical terminal event, with no final error. Restart/outage scenarios expect a terminal original failure, not speculative task replay. The pre-fix active/result-loss baseline can be checked with `--expect-broken`: original failure, blocked same-conversation follow-up, and a successful independent request.

The fixture records the source commit and working-change hash, native version, wire events, agent lifecycle events, Gateway results, and side-effect marker in the supplied directory. It rejects source changes during execution and terminates owned processes and releases port claims in `finally`. Retain output only for an active comparison; remove it when that comparison is finished. Heartbeat and Slack notification behavior have separate dispatch tests; this fixture does not send chat messages. A synthetic configuration change demonstrates that recovery boundary, not the cause of a production configuration change.

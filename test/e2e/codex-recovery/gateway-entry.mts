import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { callGateway } from "../../../src/gateway/call.ts";
import { startGatewayServer } from "../../../src/gateway/server.ts";
import { onAgentEvent } from "../../../src/infra/agent-events.ts";
import { acquireTestPortBlock } from "../../../src/test-utils/port-claims.ts";
const root = process.env.OC_REPRO_ROOT;
if (!root) {
  throw new Error("Missing isolated output directory");
}
const off = onAgentEvent((e) => {
  if (["lifecycle", "tool", "error"].includes(e.stream)) {
    fs.appendFileSync(root + "/agent-events.jsonl", JSON.stringify(e) + "\n");
  }
});
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let sibling: ReturnType<typeof callGateway> | undefined;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
let ready: () => void = () => {};
let backendRestored: () => void = () => {};
const backendReady = new Promise<void>((resolve) => {
  backendRestored = resolve;
});
const siblingReady = new Promise<void>((resolve) => {
  ready = resolve;
});
process.on("message", (message) => {
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "backend-restored"
  ) {
    backendRestored();
  }
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "sibling-ready"
  ) {
    ready();
  }
});
try {
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  claim = portClaim;
  const port = portClaim.port;
  server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: "synthetic-gateway-token" },
    controlUiEnabled: false,
  });
  if (process.env.OC_REPRO_MODE?.includes("sibling")) {
    sibling = callGateway({
      url: `ws://127.0.0.1:${port}`,
      token: "synthetic-gateway-token",
      method: "agent",
      params: {
        message: "SIBLING_HOLD",
        sessionKey: "agent:main:sibling",
        idempotencyKey: randomUUID(),
        deliver: false,
      },
      expectFinal: true,
      timeoutMs: 120000,
    }).catch((e: unknown) => ({ error: String(e) }));
    await siblingReady;
  }
  const results = [];
  for (const [label, sessionKey] of [
    ["original", "agent:main:main"],
    ["subsequent", "agent:main:main"],
    ["independent", "agent:main:independent"],
  ] as const) {
    const runId = randomUUID();
    try {
      if (label === "subsequent") {
        process.send?.({ kind: "restore-backend" });
        await backendReady;
      }
      const result = await callGateway({
        url: `ws://127.0.0.1:${port}`,
        token: "synthetic-gateway-token",
        method: "agent",
        params: {
          message:
            label === "original"
              ? "Reply with RECOVERY_OK. This is an isolated overload recovery probe."
              : "New independent request: reply with FOLLOWUP_OK.",
          sessionKey,
          idempotencyKey: runId,
          deliver: false,
        },
        expectFinal: true,
        timeoutMs: 120000,
      });
      results.push({ label, runId, result });
      console.log("REPRO_GATEWAY_RESULT " + JSON.stringify({ label, result }));
    } catch (error) {
      results.push({ label, runId, error: String(error) });
      console.log("REPRO_GATEWAY_RESULT " + JSON.stringify({ label, error: String(error) }));
    }
  }
  fs.writeFileSync(root + "/gateway-results.json", JSON.stringify(results, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (sibling) {
    process.send?.({ kind: "release-sibling" });
    const result = await sibling;
    fs.writeFileSync(root + "/sibling-result.json", JSON.stringify(result));
    console.log("SIBLING_RESULT " + JSON.stringify(result));
  }
  off();
  await server?.close({ reason: "isolated recovery reproduction complete" });
  await claim?.release();
  process.disconnect?.();
  process.exit(process.exitCode ?? 0);
}

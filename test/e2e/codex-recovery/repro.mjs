import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireTestPortBlock } from "../../../src/test-utils/port-claims.ts";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(fixture, "../../..");
const require = createRequire(repo + "/package.json");
const { WebSocket, WebSocketServer } = require("ws");
/** @param {unknown} data */
function websocketText(data) {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString("utf8");
  }
  throw new TypeError("Expected WebSocket RawData");
}
const binary = process.env.OPENCLAW_CODEX_RECOVERY_BINARY;
if (!binary) {
  throw new Error(
    "Set OPENCLAW_CODEX_RECOVERY_BINARY to the installed Codex app-server executable.",
  );
}
const expectBroken = process.argv.includes("--expect-broken");
const root = path.resolve(process.argv[2]);
const sourceSnapshot = () => {
  const git = (...args) => execFileSync("git", args, { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  const diff = git("diff", "HEAD", "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    .toString()
    .split("\0")
    .filter(Boolean)
    .toSorted();
  const hash = createHash("sha256").update(diff);
  for (const file of untracked) {
    hash
      .update(file)
      .update("\0")
      .update(fs.readFileSync(path.join(repo, file)));
  }
  return {
    commit: git("rev-parse", "HEAD").toString().trim(),
    dirty: diff.length > 0 || untracked.length > 0,
    changesHash: hash.digest("hex"),
  };
};
const source = sourceSnapshot();
const mode = process.argv[3] || "gateway-remote-active-lost-result-effect";
if (fs.existsSync(root)) {
  throw new Error("Choose a new run directory");
}
for (const d of ["home", "native-home", "workspace", "tmp"]) {
  fs.mkdirSync(path.join(root, d), { recursive: true });
}
const log = (event, data) =>
  fs.appendFileSync(
    root + "/wire.jsonl",
    JSON.stringify({ time: new Date().toISOString(), event, data }) + "\n",
  );
const nodeDir = path.dirname(process.execPath);
const model = process.env.OPENCLAW_CODEX_RECOVERY_MODEL || "gpt-5.4";
const claims = [];
const env = {
  PATH: nodeDir + ":/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: root + "/home",
  TMPDIR: root + "/tmp",
  OPENCLAW_STATE_DIR: root + "/home/.openclaw",
  OPENCLAW_CONFIG_PATH: root + "/config.json",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CRON: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost,::1,managed-devbox.repro.invalid",
  OPENAI_API_KEY: "synthetic-local-only",
};
env.OC_REPRO_MODE = mode;
env.OC_REPRO_ROOT = root;
const children = [],
  sockets = new Set();
let provider, proxy;
let requestCount = 0;
const providerRequests = [];
let failProvider = !mode.includes("active");
let forcePrimaryOverload = mode.includes("model-fallback");
let faulted = false;
let pendingToolId;
let probeToolSent = false;
let reconnectBlocked = false;
let cli;
let restartPromise;
const authFailure = mode.includes("auth-fallback");
const authAttempts = [];
const authorizationScheme = (headers) =>
  headers.authorization?.startsWith("Bearer ") ? "bearer" : "none";
const unauthorizedBody = JSON.stringify({
  error: {
    message: "Missing bearer or basic authentication in header",
    type: "invalid_request_error",
  },
});
const held = [];
if (mode.includes("drift")) {
  fs.writeFileSync(root + "/workspace/SOUL.md", "Synthetic persona version A.\n");
}

async function listen(s) {
  await new Promise((r, j) => {
    s.once("error", j);
    s.listen(0, "127.0.0.1", r);
  });
  return s.address().port;
}
function sse(res, text) {
  const item = {
    type: "message",
    id: "msg_" + requestCount,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + requestCount,
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
      },
    },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") + "data: [DONE]\n\n");
}
try {
  const respond = (raw, res) => {
    const body = JSON.parse(raw);
    if (body.generate === false) {
      // Native can prewarm before the user's turn; inject faults only into real inference.
      log("provider-warmup", { model: body.model });
      sse(res, "");
      return;
    }
    requestCount++;
    if (forcePrimaryOverload) {
      failProvider = body.model === model;
    }
    log("provider", { number: requestCount, url: "/v1/responses", body });
    providerRequests.push(body);
    if (
      !probeToolSent &&
      (((mode.includes("tools55") || mode.includes("active")) && requestCount === 1) ||
        (mode.includes("joint") && !failProvider))
    ) {
      probeToolSent = true;
      const items = Array.from(
        { length: mode.includes("active") || mode.includes("joint") ? 1 : 55 },
        (_, i) => ({
          type: "function_call",
          name: mode.includes("effect") ? "gateway_exec" : "ls",
          arguments: JSON.stringify(
            mode.includes("effect")
              ? {
                  command: "printf 'effect\\n' >> effect-count.txt",
                  workdir: root + "/workspace",
                }
              : { path: root + "/workspace", limit: 1 },
          ),
          call_id: "call_probe_" + i,
          id: "fc_probe_" + i,
          status: "completed",
        }),
      );
      const events = items.flatMap((item, i) => [
        {
          type: "response.output_item.added",
          output_index: i,
          item: { ...item, status: "in_progress" },
        },
        { type: "response.output_item.done", output_index: i, item },
      ]);
      events.push({
        type: "response.completed",
        response: {
          id: "resp_tools",
          status: "completed",
          output: items,
          usage: { input_tokens: 20, output_tokens: 55, total_tokens: 75 },
        },
      });
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""));
      return;
    }
    if (mode.includes("sibling") && raw.includes("SIBLING_HOLD")) {
      held.push(res);
      cli.send({ kind: "sibling-ready" });
      log("sibling-held", { number: requestCount });
      return;
    }
    if (failProvider) {
      if (mode.includes("drift")) {
        fs.writeFileSync(root + "/workspace/SOUL.md", "Synthetic persona version B.\n");
        log("fault-injected", { kind: "workspace-persona-change", file: "SOUL.md" });
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(
        "data: " +
          JSON.stringify({
            type: "response.failed",
            response: {
              id: "resp_overload",
              status: "failed",
              error: {
                message: "Selected model is at capacity. Please try a different model.",
                code: "server_is_overloaded",
              },
            },
          }) +
          "\n\n",
      );
    } else {
      sse(res, "RECOVERY_OK");
    }
  };
  provider = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const scheme = authorizationScheme(req.headers);
      if (authFailure) {
        authAttempts.push({ transport: "http", scheme, model: JSON.parse(raw).model });
        if (scheme !== "bearer") {
          requestCount++;
          res.writeHead(401, { "content-type": "application/json" }).end(unauthorizedBody);
          return;
        }
      }
      respond(raw, res);
    });
  });
  const responseSockets = new WebSocketServer({ noServer: true });
  provider.on("upgrade", (req, socket, head) => {
    const scheme = authorizationScheme(req.headers);
    if (authFailure) {
      authAttempts.push({ transport: "websocket", scheme });
      if (scheme !== "bearer") {
        socket.end(
          "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: " +
            Buffer.byteLength(unauthorizedBody) +
            "\r\nConnection: close\r\n\r\n" +
            unauthorizedBody,
        );
        return;
      }
    }
    responseSockets.handleUpgrade(req, socket, head, (ws) =>
      responseSockets.emit("connection", ws, req),
    );
  });
  responseSockets.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("message", (bytes) =>
      respond(websocketText(bytes), {
        writeHead() {
          return this;
        },
        end(body) {
          for (const line of body.split("\n")) {
            if (
              line.startsWith("data: ") &&
              line !== "data: [DONE]" &&
              socket.readyState === WebSocket.OPEN
            ) {
              socket.send(line.slice(6));
            }
          }
        },
      }),
    );
  });
  const providerPort = await listen(provider);
  fs.writeFileSync(
    root + "/native-home/config.toml",
    `model = "${model}"\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:${providerPort}/v1"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[analytics]\nenabled = false\n`,
  );
  const nativeClaim = await acquireTestPortBlock({ offsets: [0] });
  claims.push(nativeClaim);
  const nativePort = nativeClaim.port;
  async function startNative() {
    const child = spawn(binary, ["app-server", "--listen", `ws://127.0.0.1:${nativePort}`], {
      cwd: root + "/workspace",
      env: {
        ...env,
        HOME: root + "/native-home",
        CODEX_HOME: root + "/native-home",
        RUST_LOG: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await new Promise((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error("native startup deadline")), 20000);
      const output = (bytes) => {
        fs.appendFileSync(root + "/native.log", bytes);
        seen = (seen + bytes.toString()).slice(-4000);
        if (seen.includes("listening on:")) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("native exited before ready"));
      });
    });
    return child;
  }
  let native = await startNative();
  const cutConnection = (front, back) => {
    front.terminate();
    back.terminate();
    if (mode.includes("outage")) {
      reconnectBlocked = true;
    }
    if (mode.includes("restart")) {
      restartPromise = (async () => {
        try {
          const exited = new Promise((resolve) => {
            native.once("exit", resolve);
          });
          native.kill("SIGKILL");
          await exited;
          native = await startNative();
        } catch (error) {
          log("restart-failed", { message: String(error) });
          throw error;
        }
      })();
    }
  };
  proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => {
    proxy.once("listening", r);
  });
  let connection = 0;
  proxy.on("connection", (front) => {
    if (reconnectBlocked) {
      front.terminate();
      return;
    }
    const cid = ++connection;
    const back = new WebSocket(`ws://127.0.0.1:${nativePort}`);
    sockets.add(front);
    sockets.add(back);
    const queue = [];
    log("connect", { cid });
    front.on("message", (data) => {
      const v = JSON.parse(websocketText(data));
      log("to-native", { cid, ...v });
      if (
        (mode.includes("lost-result") || mode.includes("joint")) &&
        v.id === pendingToolId &&
        !v.method &&
        !faulted
      ) {
        faulted = true;
        log("fault-injected", { kind: "lost-tool-result", cid, id: v.id });
        cutConnection(front, back);
        return;
      }
      if (back.readyState === WebSocket.OPEN) {
        back.send(data, { binary: false });
      } else {
        queue.push(data);
      }
    });
    back.on("open", () => {
      for (const d of queue) {
        back.send(d, { binary: false });
      }
    });
    back.on("message", (data) => {
      const frame = JSON.parse(websocketText(data));
      if (
        !authFailure &&
        !mode.includes("model-fallback") &&
        frame.method === "turn/completed" &&
        frame.params?.turn?.status === "failed"
      ) {
        failProvider = false;
      }
      log("from-native", { cid, ...frame });
      if (frame.method === "item/tool/call") {
        pendingToolId = frame.id;
        if (mode.includes("active") && !mode.includes("lost-result") && !faulted) {
          faulted = true;
          log("fault-injected", { kind: "undelivered-tool-request", cid, id: frame.id });
          cutConnection(front, back);
          return;
        }
      }
      if (front.readyState === WebSocket.OPEN) {
        front.send(data, { binary: false });
      }
    });
    front.on("close", () => {
      log("disconnect", { cid });
      back.close();
      sockets.delete(front);
    });
    back.on("close", () => {
      front.close();
      sockets.delete(back);
    });
    front.on("error", () => {});
    back.on("error", () => {});
  });
  const config = {
    agents: {
      defaults: {
        skipBootstrap: true,
        model: { primary: "openai/" + model },
        models: { ["openai/" + model]: { agentRuntime: { id: "codex" } } },
      },
      entries: { main: { workspace: root + "/workspace" } },
    },
    models: {
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: "openai-responses",
          auth: "api-key",
          apiKey: "synthetic-local-only",
          models: [
            {
              id: model,
              name: model,
              input: ["text"],
              reasoning: true,
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    plugins: {
      allow: ["openai", "codex"],
      slots: { memory: "none" },
      entries: {
        openai: { enabled: true },
        codex: {
          enabled: true,
          config: {
            appServer: {
              transport: "websocket",
              url: `ws://127.0.0.1:${proxy.address().port}`,
              approvalPolicy: "never",
              sandbox: "read-only",
              requestTimeoutMs: 20000,
              defaultWorkspaceDir: root + "/workspace",
              remoteWorkspaceRoot: root + "/workspace",
            },
            computerUse: { enabled: false },
          },
        },
      },
    },
    logging: { level: "debug", consoleLevel: "debug", file: root + "/runtime.log" },
  };
  delete config.models;
  if (authFailure || mode.includes("model-fallback")) {
    const fallbacks = ["gpt-5.3-codex", "gpt-5.2"];
    config.agents.defaults.model.fallbacks = fallbacks.map((id) => "openai/" + id);
    for (const id of fallbacks) {
      config.agents.defaults.models["openai/" + id] = { agentRuntime: { id: "codex" } };
    }
  }
  if (mode.includes("remote")) {
    config.plugins.entries.codex.config.appServer.url = `ws://managed-devbox.repro.invalid:${proxy.address().port}`;
    config.plugins.entries.codex.config.appServer.authToken = "synthetic-devbox-token";
  }
  if (mode.includes("effect")) {
    config.tools = { exec: { host: "gateway", security: "full", ask: "off" } };
  }
  config.gateway = { mode: "local", auth: { mode: "token", token: "synthetic-gateway-token" } };
  env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  config.agents.defaults.heartbeat = { every: "0m" };
  delete env.OPENAI_API_KEY;
  fs.writeFileSync(root + "/config.json", JSON.stringify(config, null, 2));
  const out = fs.openSync(root + "/openclaw.log", "a");
  cli = spawn(
    nodeDir + "/node",
    [
      "--import",
      fixture + "/repro-dns.mjs",
      "--import",
      repo + "/scripts/tsx.mjs",
      fixture + "/gateway-entry.mts",
    ],
    { cwd: repo, env, stdio: ["ignore", out, out, "ipc"] },
  );
  fs.closeSync(out);
  children.push(cli);
  const handleMessage = async (message) => {
    if (message?.kind === "restore-backend") {
      reconnectBlocked = false;
      forcePrimaryOverload = false;
      failProvider = false;
      await restartPromise;
      if (authFailure) {
        // The fixture owner restores its own synthetic credential; OpenClaw does not log in.
        const owner = new WebSocket(`ws://127.0.0.1:${nativePort}`);
        sockets.add(owner);
        await new Promise((resolve, reject) => {
          owner.once("open", resolve);
          owner.once("error", reject);
        });
        let id = 0;
        const rpc = (method, params) =>
          new Promise((resolve, reject) => {
            const requestId = ++id;
            const timer = setTimeout(() => reject(new Error("fixture owner auth deadline")), 10000);
            const receive = (bytes) => {
              const reply = JSON.parse(websocketText(bytes));
              if (reply.id !== requestId) {
                return;
              }
              clearTimeout(timer);
              owner.off("message", receive);
              if (reply.error) {
                reject(new Error(reply.error.message));
              } else {
                resolve(reply.result);
              }
            };
            owner.on("message", receive);
            owner.send(JSON.stringify({ id: requestId, method, params }));
          });
        try {
          await rpc("initialize", { clientInfo: { name: "recovery_fixture_owner", version: "1" } });
          owner.send(JSON.stringify({ method: "initialized" }));
          await rpc("account/login/start", { type: "apiKey", apiKey: "synthetic-local-only" });
        } finally {
          owner.close();
        }
        failProvider = false;
        log("fixture-owner-auth-restored", {});
        if (mode.includes("drift")) {
          fs.writeFileSync(root + "/workspace/SOUL.md", "Synthetic persona version B.\n");
          log("post-failure-prompt-drift", {});
        }
      }
      cli.send({ kind: "backend-restored" });
    }
    if (message?.kind === "release-sibling") {
      for (const res of held) {
        sse(res, "SIBLING_OK");
      }
    }
  };
  cli.on("message", (message) => {
    void (async () => {
      try {
        await handleMessage(message);
      } catch (error) {
        log("fixture-restore-error", { error: String(error) });
        cli.kill("SIGTERM");
      }
    })();
  });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      cli.kill("SIGTERM");
      resolve({ timeout: true });
    }, 240000);
    cli.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  fs.writeFileSync(
    root + "/result.json",
    JSON.stringify(
      {
        mode,
        source,
        nativeVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
        requestCount,
        authAttempts,
        exit,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, requestCount, exit }));
  assert.deepEqual(sourceSnapshot(), source, "source must remain unchanged during reproduction");
  assert.equal(exit.code, 0, "Gateway fixture must finish and clean up");
  const results = JSON.parse(fs.readFileSync(root + "/gateway-results.json", "utf8"));
  const ok = (r) => !r.error && r.result?.status === "ok";
  assert.equal(ok(results[2]), true, "independent conversation must complete");
  if (mode.includes("sibling")) {
    assert.equal(
      JSON.parse(fs.readFileSync(root + "/sibling-result.json", "utf8")).status,
      "ok",
      "live sibling must complete",
    );
  }
  assert.equal(
    ok(results[0]),
    !expectBroken && !authFailure && !mode.includes("restart") && !mode.includes("outage"),
    "original request recovery outcome",
  );
  assert.equal(ok(results[1]), !expectBroken, "same-conversation new request outcome");
  if (authFailure && mode.includes("drift") && !expectBroken) {
    assert.equal(
      providerRequests.length,
      2,
      "restored same and independent requests reach inference",
    );
    for (const request of providerRequests) {
      const latestPersona = request.input.findLast(
        (item) =>
          item.role === "developer" &&
          JSON.stringify(item.content).includes("Synthetic persona version"),
      );
      assert.ok(
        JSON.stringify(latestPersona?.content ?? []).includes("Synthetic persona version B"),
        "the model must receive the changed developer instructions after credential restoration",
      );
    }
  }
  if (authFailure) {
    assert(
      authAttempts.some((attempt) => attempt.scheme === "none"),
      "reproduce missing native inference auth",
    );
    assert(
      authAttempts.some((attempt) => attempt.scheme === "bearer"),
      "owner-restored auth must reach provider",
    );
  }
  if (mode.includes("effect")) {
    assert.equal(
      fs.readFileSync(root + "/workspace/effect-count.txt", "utf8"),
      "effect\n",
      "tool side effect must execute exactly once",
    );
  }
  const events = fs
    .readFileSync(root + "/agent-events.jsonl", "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  for (const r of results) {
    const runId = r.runId ?? r.result?.runId;
    assert(runId, "each request, including failed requests, must retain its logical run id");
    const terminal = events.filter(
      (e) =>
        e.runId === runId && e.stream === "lifecycle" && ["end", "error"].includes(e.data.phase),
    );
    assert.equal(terminal.length, 1, "one terminal event per logical request");
    if (ok(r)) {
      assert.equal(
        terminal[0].data.phase,
        "end",
        "recovered request must not publish final failure",
      );
    }
  }
  if (mode.includes("active") || mode.includes("joint")) {
    assert.equal(faulted, true, "fault injection must execute");
  }
  console.log(JSON.stringify({ passed: true, expectBroken, root }));
} finally {
  await restartPromise?.catch(() => {});
  for (const s of sockets) {
    s.terminate();
  }
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGTERM");
    }
  }
  proxy?.close();
  provider?.closeAllConnections();
  provider?.close();
  await Promise.all(
    children.map((c) =>
      c.exitCode === null && c.signalCode === null
        ? new Promise((r) => {
            const t = setTimeout(() => {
              c.kill("SIGKILL");
              r();
            }, 5000);
            c.once("exit", () => {
              clearTimeout(t);
              r();
            });
          })
        : Promise.resolve(),
    ),
  );
  for (const claim of claims) {
    await claim.release();
  }
}

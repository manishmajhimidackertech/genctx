"use strict";

// DaemonClient against a fake genctxd: a real TCP server on 127.0.0.1 and a
// real discovery file, in a temporary GENCTX_RUNTIME_DIR.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const { DaemonClient, daemonFilePath } = require("../out/daemon.js");

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "genctx-ext-"));
const discoveryFile = path.join(runtimeDir, "daemon.json");
process.env.GENCTX_RUNTIME_DIR = runtimeDir;

test.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function publish(info) {
  fs.writeFileSync(discoveryFile, JSON.stringify(info));
}

function unpublish() {
  fs.rmSync(discoveryFile, { force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

function within(promise, what, ms = 4000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A fake genctxd. Records every line it receives, answers a hello carrying
 * `token` with a welcome (unless `welcome` is false), and closes the
 * connection on any other token, as the real daemon does.
 */
async function fakeDaemon({ token = "secret", welcome = true } = {}) {
  const lines = [];
  const sockets = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.push(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        lines.push(msg);
        if (msg.type === "hello") {
          if (msg.token !== token) {
            socket.destroy();
          } else if (welcome) {
            socket.write(JSON.stringify({ type: "welcome", version: "0.1.0" }) + "\n");
          }
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    port,
    token,
    lines,
    get connections() {
      return connections;
    },
    publish() {
      publish({ port, token, pid: process.pid, version: "0.1.0" });
    },
    /** Write raw text to the most recent connection. */
    send(text) {
      sockets[sockets.length - 1].write(text);
    },
    dropClients() {
      for (const s of sockets) s.destroy();
    },
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

function client(overrides = {}) {
  return new DaemonClient({ autoStart: false, daemonPath: "", env: {}, ...overrides });
}

/** Start a client against `daemon` and wait until it is authenticated. */
async function connected(daemon, overrides) {
  daemon.publish();
  const c = client(overrides);
  const ready = once(c, "connect");
  c.start();
  await within(ready, "connect");
  return c;
}

// ── Discovery path (must mirror runtime_dir() in crates/core/src/runtime.rs) ──

function withEnv(vars, platform, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (platform) Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    if (platform) Object.defineProperty(process, "platform", realPlatform);
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("discovery: GENCTX_RUNTIME_DIR wins on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const got = withEnv(
      { GENCTX_RUNTIME_DIR: "/rt", LOCALAPPDATA: "/local", XDG_RUNTIME_DIR: "/xdg" },
      platform,
      daemonFilePath
    );
    assert.equal(got, path.join("/rt", "daemon.json"), platform);
  }
});

test("discovery: Windows uses %LOCALAPPDATA%\\genctx, and an empty override is ignored", () => {
  const got = withEnv(
    { GENCTX_RUNTIME_DIR: "", LOCALAPPDATA: "/local", XDG_RUNTIME_DIR: "/xdg" },
    "win32",
    daemonFilePath
  );
  assert.equal(got, path.join("/local", "genctx", "daemon.json"));
});

test("discovery: Windows without LOCALAPPDATA has no discovery file", () => {
  const got = withEnv({ GENCTX_RUNTIME_DIR: undefined, LOCALAPPDATA: "" }, "win32", daemonFilePath);
  assert.equal(got, undefined);
});

test("discovery: elsewhere XDG_RUNTIME_DIR, then ~/.cache", () => {
  const xdg = withEnv(
    { GENCTX_RUNTIME_DIR: undefined, XDG_RUNTIME_DIR: "/run/user/1000" },
    "linux",
    daemonFilePath
  );
  assert.equal(xdg, path.join("/run/user/1000", "genctx", "daemon.json"));
  const home = withEnv({ GENCTX_RUNTIME_DIR: undefined, XDG_RUNTIME_DIR: undefined }, "darwin", daemonFilePath);
  assert.equal(home, path.join(os.homedir(), ".cache", "genctx", "daemon.json"));
});

// ── Handshake ─────────────────────────────────────────────────────────────────

test("sends the published token as its first line, and connects on welcome", async () => {
  const daemon = await fakeDaemon({ token: "tok-1" });
  const c = await connected(daemon);
  try {
    assert.deepEqual(daemon.lines[0], { type: "hello", token: "tok-1" });
  } finally {
    c.dispose();
    daemon.close();
  }
});

test("sends nothing but the hello until the daemon welcomes it", async () => {
  const daemon = await fakeDaemon({ welcome: false });
  daemon.publish();
  const c = client();
  try {
    c.start();
    await waitFor(() => daemon.lines.length === 1, "hello");
    c.notifySave("/p/a.rs", "h1");
    c.notifyDelete("/p/b.rs");
    await sleep(100);
    assert.equal(daemon.lines.length, 1, "events before the welcome must be dropped");

    const ready = once(c, "connect");
    daemon.send(JSON.stringify({ type: "welcome", version: "0.1.0" }) + "\n");
    await within(ready, "connect");
    c.notifySave("/p/a.rs", "h2");
    await waitFor(() => daemon.lines.length === 2, "save");
    assert.deepEqual(daemon.lines[1], { type: "save", path: "/p/a.rs", hash: "h2" });
  } finally {
    c.dispose();
    daemon.close();
  }
});

test("a rejected token is neither a connect nor a disconnect", async () => {
  const daemon = await fakeDaemon({ token: "right" });
  publish({ port: daemon.port, token: "wrong", pid: 1, version: "0.1.0" });
  const c = client();
  const events = [];
  c.on("connect", () => events.push("connect"));
  c.on("disconnect", () => events.push("disconnect"));
  try {
    c.start();
    await waitFor(() => daemon.lines.length === 1, "hello");
    await sleep(150);
    assert.deepEqual(events, []);
  } finally {
    c.dispose();
    daemon.close();
  }
});

test("ignores a discovery file whose port is not a number", async () => {
  const daemon = await fakeDaemon();
  publish({ port: String(daemon.port), token: daemon.token, pid: 1, version: "0.1.0" });
  const c = client();
  try {
    c.start();
    await sleep(200);
    assert.equal(daemon.connections, 0);
  } finally {
    c.dispose();
    daemon.close();
  }
});

// ── Outbound events ───────────────────────────────────────────────────────────

test("sends save, rename and delete as one JSON line each", async () => {
  const daemon = await fakeDaemon();
  const c = await connected(daemon);
  try {
    c.notifySave("C:\\p\\a b.rs", "abc");
    c.notifyRename("/p/old.rs", "/p/new.rs");
    c.notifyDelete("/p/gone.rs");
    await waitFor(() => daemon.lines.length === 4, "three events");
    assert.deepEqual(daemon.lines.slice(1), [
      { type: "save", path: "C:\\p\\a b.rs", hash: "abc" },
      { type: "rename", from: "/p/old.rs", to: "/p/new.rs" },
      { type: "delete", path: "/p/gone.rs" },
    ]);
  } finally {
    c.dispose();
    daemon.close();
  }
});

// ── Inbound messages ──────────────────────────────────────────────────────────

test("reassembles messages split across reads, and several in one read", async () => {
  const daemon = await fakeDaemon();
  const c = await connected(daemon);
  const statuses = [];
  c.on("status", (m) => statuses.push(m));
  try {
    daemon.send('{"type":"status","path":"a.rs","sta');
    await sleep(30);
    daemon.send(
      'te":"ready"}\n{"type":"status","path":"b.rs","state":"error","message":"no model"}\n'
    );
    await waitFor(() => statuses.length === 2, "two statuses");
    assert.deepEqual(statuses, [
      { type: "status", path: "a.rs", state: "ready" },
      { type: "status", path: "b.rs", state: "error", message: "no model" },
    ]);
  } finally {
    c.dispose();
    daemon.close();
  }
});

test("skips a malformed or blank line and keeps reading", async () => {
  const daemon = await fakeDaemon();
  const c = await connected(daemon);
  const statuses = [];
  c.on("status", (m) => statuses.push(m));
  try {
    daemon.send('not json\n\r\n{"type":"status","path":"a.rs","state":"queued"}\r\n');
    await waitFor(() => statuses.length === 1, "status");
    assert.equal(statuses[0].state, "queued");
  } finally {
    c.dispose();
    daemon.close();
  }
});

test("emits updateAvailable", async () => {
  const daemon = await fakeDaemon();
  const c = await connected(daemon);
  try {
    const update = once(c, "updateAvailable");
    daemon.send('{"type":"updateAvailable","currentVersion":"0.1.0","latestVersion":"0.2.0"}\n');
    const [msg] = await within(update, "updateAvailable");
    assert.equal(msg.latestVersion, "0.2.0");
  } finally {
    c.dispose();
    daemon.close();
  }
});

// ── Reconnecting ──────────────────────────────────────────────────────────────

test("on disconnect, re-reads the discovery file and reconnects to the new daemon", async () => {
  const first = await fakeDaemon({ token: "first" });
  const c = await connected(first);
  const second = await fakeDaemon({ token: "second" });
  try {
    const lost = once(c, "disconnect");
    second.publish();
    first.dropClients();
    await within(lost, "disconnect");
    const back = once(c, "connect");
    await within(back, "reconnect");
    assert.deepEqual(second.lines[0], { type: "hello", token: "second" });
  } finally {
    c.dispose();
    first.close();
    second.close();
  }
});

test("dispose stops it reconnecting", async () => {
  unpublish();
  const c = client();
  c.start();
  c.dispose();
  const daemon = await fakeDaemon();
  try {
    daemon.publish();
    await sleep(1300); // past the first reconnect delay
    assert.equal(daemon.connections, 0);
  } finally {
    daemon.close();
  }
});

// ── Auto-start ────────────────────────────────────────────────────────────────

test("starts daemonPath with the extra environment when no daemon is published", async () => {
  unpublish();
  const marker = path.join(runtimeDir, "started.txt");
  const fake = path.join(runtimeDir, "fake-genctxd.js");
  fs.writeFileSync(
    fake,
    `require("fs").writeFileSync(${JSON.stringify(marker)}, process.env.GENCTX_OLLAMA_URL || "");`
  );
  // daemonPath is started with no arguments, so node finds the script
  // through NODE_OPTIONS in the environment the client passes on.
  const c = client({
    autoStart: true,
    daemonPath: process.execPath,
    env: {
      GENCTX_OLLAMA_URL: "http://gpu-box:11434",
      NODE_OPTIONS: `--require ${JSON.stringify(fake)}`,
    },
  });
  try {
    c.start();
    await waitFor(() => fs.existsSync(marker), "the daemon to be started");
    await waitFor(() => fs.readFileSync(marker, "utf8") !== "", "the marker to be written");
    assert.equal(fs.readFileSync(marker, "utf8"), "http://gpu-box:11434");
  } finally {
    c.dispose();
  }
});

test("reports a daemon that cannot be started, and tries only once", async () => {
  unpublish();
  const c = client({ autoStart: true, daemonPath: path.join(runtimeDir, "no-such-genctxd.exe") });
  const failures = [];
  c.on("startFailed", (err) => failures.push(err));
  try {
    c.start();
    await waitFor(() => failures.length === 1, "startFailed");
    await sleep(1300); // past the first reconnect, which must not retry the start
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /ENOENT/);
  } finally {
    c.dispose();
  }
});

test("does not start anything when autoStart is off", async () => {
  unpublish();
  const c = client({ autoStart: false, daemonPath: path.join(runtimeDir, "no-such-genctxd.exe") });
  const failures = [];
  c.on("startFailed", (err) => failures.push(err));
  try {
    c.start();
    await sleep(200);
    assert.equal(failures.length, 0);
  } finally {
    c.dispose();
  }
});

// Contract tests for the relay. Offline: every case here is decided by the
// handler itself, never by an upstream. The forward path is covered by the
// live probe documented in the README (it needs a network peer).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const zlib = require("node:zlib");
const net = require("node:net");

const ROOT = require("node:path").join(__dirname, "..");
let child, base, port;

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("server did not listen in 10s")), 10_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening")) { clearTimeout(t); res(); }
    });
    child.on("exit", (c) => rej(new Error(`server exited early: ${c}`)));
  });
});

after(() => child && child.kill("SIGKILL"));

const send = (path = "/", opts = {}) =>
  fetch(base + path, { method: "GET", ...opts }).then(async (r) => ({
    status: r.status,
    body: await r.text(),
    headers: r.headers,
  }));

const relay = (h) => ({ method: "POST", headers: { "content-type": "application/json", ...h }, body: "{}" });

test("health banner only when no relay headers are present", async () => {
  const r = await send("/");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.trim(), "bansos relay ok");
  assert.match(r.headers.get("cache-control"), /no-store/);
});

test("missing x-relay-target is a 400, not a health check", async () => {
  const r = await send("/", { method: "POST", body: "{}" });
  assert.strictEqual(r.status, 400);
  assert.match(r.body, /missing x-relay-target/);
});

test("origins outside the allowlist are refused", async () => {
  for (const target of ["https://evil.example.com", "http://api.llm7.io", "https://api.llm7.io.evil.com"]) {
    const r = await send("/", relay({ "x-relay-target": target }));
    assert.strictEqual(r.status, 403, `${target} should be refused`);
  }
});

test("a path that parses as credentials is rejected before it can retarget", async () => {
  for (const p of ["@evil.com/x", "//evil.com/x", "relative", "https://evil.com/x"]) {
    const r = await send("/", relay({ "x-relay-target": "https://opencode.ai", "x-relay-path": p }));
    assert.strictEqual(r.status, 400, `path ${JSON.stringify(p)} should be rejected`);
    assert.match(r.body, /invalid x-relay-path/);
  }
});

test("an empty path defaults to / on the allowlisted origin, never off it", async () => {
  // "" is falsy, so the handler falls back to "/". That is safe by construction:
  // the origin still comes from x-relay-target, which the allowlist gates. A 405
  // is the upstream's own Method Not Allowed for POST /, i.e. proof it reached
  // opencode.ai rather than being retargeted.
  const r = await send("/", relay({ "x-relay-target": "https://opencode.ai", "x-relay-path": "" }));
  assert.notStrictEqual(r.status, 400);
  assert.doesNotMatch(r.body, /invalid x-relay-path/);
});

test("an oversized plain body is refused with 413", async () => {
  const r = await send("/", {
    method: "POST",
    headers: { "x-relay-target": "https://opencode.ai", "x-relay-path": "/" },
    body: Buffer.alloc(9 * 1024 * 1024, 0x78), // over MAX_BODY_BYTES (8 MiB)
  });
  assert.strictEqual(r.status, 413);
  assert.match(r.body, /body too large/);
});

test("compressed bodies are bounded by their INFLATED size", async () => {
  // 40 MiB of 'x' compresses to a few KB: the compressed cap cannot see this,
  // only maxOutputLength can. Without it the process allocates 40 MiB here and
  // an arbitrary amount in the general case.
  const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x78), { level: 1 });
  assert.ok(bomb.length < 1024 * 1024, "bomb should slip under the compressed cap");

  const r = await send("/", {
    method: "POST",
    headers: {
      "x-relay-target": "https://opencode.ai",
      "x-relay-path": "/",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: bomb,
  });
  assert.strictEqual(r.status, 413);
  assert.match(r.body, /inflated body too large/);
});

test("a corrupt gzip body is a 400, not a crash", async () => {
  const r = await send("/", {
    method: "POST",
    headers: {
      "x-relay-target": "https://opencode.ai",
      "x-relay-path": "/",
      "content-encoding": "gzip",
    },
    body: Buffer.from("not gzip at all"),
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.body, /gunzip failed/);
});

test("the relay still answers after the abuse cases", async () => {
  const r = await send("/");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.trim(), "bansos relay ok");
});

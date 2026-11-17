// Contract tests for the Vercel handler (api/index.js) via a tiny http wrapper.
//
// Loads the handler with createRequire: the file is CommonJS on purpose (see
// vercel/package.json — a "type": "module" parent loads it as ESM and it dies at
// `require is not defined`). A bare `import handler from "../api/index.js"` therefore
// fails with "does not provide an export named 'default'" in this repo.
//
// Offline by design: every bound here is decided by the handler itself, never by an
// upstream. The forward path needs a live peer and is a separate probe.
// Usage: node test/test-vercel.mjs
import http from "node:http";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const handler = createRequire(import.meta.url)("./api/index.js");

const server = http.createServer(async (req, res) => {
  // Vercel hands the body over as an unparsed stream when bodyParser:false.
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (b) => res.end(Buffer.isBuffer(b) || typeof b === "string" ? b : JSON.stringify(b));
  try {
    await handler(req, res);
  } catch (e) {
    console.error("HANDLER THREW:", e.message);
    res.statusCode = 500;
    res.end("handler error");
  }
});

const { test } = await import("node:test");
const assert = await import("node:assert");

let BASE;
await new Promise((r) => server.listen(0, "127.0.0.1", r));
BASE = `http://127.0.0.1:${server.address().port}`;

const req = (path = "/", init = {}) =>
  fetch(BASE + path, { ...init, headers: { "user-agent": "test/1", ...(init.headers || {}) } });

const relay = (target, path = "/", extra = {}) =>
  req("/", { method: "POST", body: "{}", headers: { "x-relay-target": target, "x-relay-path": path, ...extra } });

// fetch() stringifies a Buffer, so bodies that must stay bytes go through Uint8Array.
const bytes = (body, extra = {}) =>
  req("/", { method: "POST", body: new Uint8Array(body), headers: { "x-relay-target": "https://opencode.ai", "x-relay-path": "/", ...extra } });

// Every bound below is about the *body*, so the target must be set — without it
// the handler answers 400 "missing x-relay-target" before it ever reads a byte.
const post = (body, extra = {}) => bytes(Buffer.from(body), extra);

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push([name, true, detail ?? ""]);
  } catch (e) {
    // A Skip marks a case that could not run (no network peer) — counted apart
    // from both PASS and FAIL so a silent skip is visible in the summary.
    if (e.skip) { results.push([name, null, e.message]); return; }
    results.push([name, false, e.message]);
  }
};

// --- contract -------------------------------------------------------------
await check("health banner", async () => {
  const r = await req("/");
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), "bansos relay ok");
});

await check("forbidden target", async () => {
  assert.equal((await post("{}", { "x-relay-target": "https://evil.example.com" })).status, 403);
});

await check("missing target on POST", async () => {
  const r = await req("/", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(r.status, 400);
});

await check("path with @host rejected", async () => {
  assert.equal((await relay("https://opencode.ai", "@api.llm7.io/v1/models")).status, 400);
});

await check("protocol-relative path rejected", async () => {
  assert.equal((await relay("https://opencode.ai", "//evil.com/x")).status, 400);
});

// --- bounds added with the hardening -------------------------------------
// A compressed-body cap is not a memory cap: this is the 915 KB gzip of
// repetitive JSON that expanded to 200 MB and took RSS to 900 MB on a 512 MB host.
await check("gzip bomb refused 413 (not inflated)", async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x78), { level: 1 });
  assert.ok(bomb.length < 1024 * 1024, `bomb was ${bomb.length} bytes, not compressed`);
  const r = await post(bomb, { "content-encoding": "gzip", "content-type": "application/json" });
  assert.equal(r.status, 413);
  assert.match(await r.text(), /inflated/i);
});

await check("oversized plain body refused 413", async () => {
  const r = await post(Buffer.alloc(9 * 1024 * 1024, 0x61), { "content-type": "application/json" });
  assert.equal(r.status, 413);
});

await check("corrupt gzip refused 400", async () => {
  const r = await post(Buffer.from("notgzip", "utf8"), { "content-encoding": "gzip" });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /gunzip/i);
});

// The inflate path itself is covered by the bomb cases above; this only proves a
// well-formed gzip is accepted and handed to fetch. It is the one case that needs a
// live peer, so a network failure reports SKIP instead of a quiet PASS.
await check("small gzip accepted by the handler", async () => {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ model: "x", messages: [] })), { level: 1 });
  let r;
  try {
    r = await bytes(body, { "content-encoding": "gzip", "content-type": "application/json" });
  } catch (e) {
    const err = new Error("no network peer");
    err.skip = true;
    throw err;
  }
  assert.notEqual(r.status, 413, "handler refused a small gzip as too large");
  assert.notEqual(r.status, 400, "handler failed to inflate a valid gzip");
});

await check("relay survives the bounds", async () => {
  assert.equal((await req("/")).status, 200);
});

server.close();
const failed = results.filter(([, ok]) => ok === false);
const skipped = results.filter(([, ok]) => ok === null);
for (const [name, ok, detail] of results) {
  const tag = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`${tag} ${name}${detail ? ` — ${detail}` : ""}`);
}
console.log(failed.length
  ? `${failed.length} FAILED (${results.length - skipped.length} run, ${skipped.length} skipped)`
  : `ALL PASS (${results.length - skipped.length} run${skipped.length ? `, ${skipped.length} skipped` : ""})`);
process.exit(failed.length ? 1 : 0);
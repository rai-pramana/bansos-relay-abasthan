// bansos relay — allowlisted forwarder for bansos-router (Vercel serverless)
// Contract: POST <url> with x-relay-target (origin) + x-relay-path (path).
// Health banner ONLY when no relay headers are present (catalog fetch bug otherwise).
//
// NOTE: streams the upstream body through chunk-by-chunk (never buffers) so
// TTFT stays low and the gateway connect-timeout (60s) is satisfied by fast
// response headers.
//
// bansos-opt4 — gzip on the wire. Vercel's Fast Origin Transfer meter counts the
// bytes the function receives, BEFORE decompression. Measured on a probe: the
// same 30.0 MB of JSON cost +36.5 MB FOT as plain text and +0.1 MB gzipped, so
// compressing the outbound chat body cuts FOT ~10x without touching context.
//
// This file is CommonJS ON PURPOSE. With `export default` the platform ignored
// `config.api.bodyParser: false`, tried to JSON-parse the gzip stream, and
// answered 400 with an empty body before this handler ran (measured). The CJS
// form (`module.exports` + `module.exports.config`) is the one where Vercel
// honours bodyParser:false and hands over the still-compressed stream.
const zlib = require("node:zlib");

const ALLOWED_TARGETS = new Set([
  "https://opencode.ai",
  "https://dev.opencode.ai",
  "https://api.kilo.ai",
  "https://api.llm7.io",
]);

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "x-forwarded-for", "x-real-ip", "cdn-loop",
  "x-relay-target", "x-relay-path",
  // The body is re-stringified below, so the inbound length is a lie whenever
  // the client sent pretty-printed JSON or a compressed body — upstream
  // truncates or 502s. Drop both and let fetch compute the real length.
  "content-length", "transfer-encoding", "content-encoding",
]);
// Path must stay a path: a "path" like "@evil.com/x" parses as credentials
// against the target origin and would retarget the fetch. Node rejects
// credentialed URLs, but that is luck, not policy — assert it.
const SAFE_PATH = /^\/(?!\/)/;

// Bounds that the platform does not provide. Vercel rejects very large bodies at
// its own edge (measured ~4.5 MB for FUNCTION_PAYLOAD_TOO_LARGE), but that is the
// compressed request — a 4 MB gzip of repetitive JSON inflated fine and reached
// the upstream. Two distinct costs, two distinct limits:
const MAX_BODY_BYTES = 8 * 1024 * 1024;      // compressed upload
const MAX_INFLATED_BYTES = 32 * 1024 * 1024; // what gunzip is allowed to produce
const UPSTREAM_TIMEOUT_MS = 120_000;         // headers + stream idle guard

// Read the raw request body from the stream ALONE. Never touch req.body: reading
// that property makes the platform parse the body even with bodyParser:false, and
// a gzip body then fails to parse and the request dies 400 before this handler can
// answer (measured — a probe that only mentions req.body reproduces it, one that
// iterates the stream does not).
//
// Returns { raw } or { error: "too-large" } or { error: "read-failed" }.
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) return { error: "too-large" };
      chunks.push(c);
    }
  } catch {
    return { error: "read-failed" };
  }
  return { raw: Buffer.concat(chunks) };
}

module.exports = async function handler(req, res) {
  const target = req.headers["x-relay-target"];
  const path = req.headers["x-relay-path"] || "/";

  // Health banner: only when no relay headers present.
  if (req.method === "GET" && !target) {
    // Diagnostic: ?diag=egress reports this function's outbound (egress) IP
    // as seen by an external IP-echo service. Snapshot only — Vercel NAT
    // pools rotate, so re-query when comparing across time.
    let diag = "";
    try {
      diag = new URL(req.url || "/", "http://localhost").searchParams.get("diag") || "";
    } catch {}
    if (diag === "egress") {
      try {
        const echo = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
          signal: AbortSignal.timeout(10000),
        });
        const trace = await echo.text();
        res.status(200).setHeader("content-type", "text/plain");
        res.setHeader("cache-control", "no-store");
        return res.send(trace);
      } catch (err) {
        return res.status(502).send("egress diag failed\n");
      }
    }
    res.status(200).setHeader("content-type", "text/plain");
    res.setHeader("cache-control", "no-store");
    return res.send("bansos relay ok\n");
  }

  if (!target) return res.status(400).send("missing x-relay-target\n");
  if (!ALLOWED_TARGETS.has(target)) return res.status(403).send("forbidden target\n");
  if (!SAFE_PATH.test(path)) return res.status(400).send("invalid x-relay-path\n");

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) continue;
    headers[lower] = v;
  }

  let upstream;
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const got = await readRaw(req);
    if (got.error === "too-large") return res.status(413).send("relay body too large\n");
    if (got.error === "read-failed") return res.status(400).send("relay body read failed\n");
    const raw = got.raw;

    const enc = String(req.headers["content-encoding"] || "").toLowerCase();
    const isBinary = Buffer.isBuffer(raw) || raw instanceof Uint8Array;
    if (enc.includes("gzip")) {
      // maxOutputLength aborts the inflate instead of allocating first, so a
      // decompression bomb costs one error rather than all the RAM. Without it a
      // 915 KB gzip of repetitive JSON expanded to 200 MB and pushed RSS to
      // 900 MB in testing on the smaller Free-tier host.
      try {
        const inflated = zlib.gunzipSync(
          isBinary ? Buffer.from(raw) : Buffer.from(String(raw), "latin1"),
          { maxOutputLength: MAX_INFLATED_BYTES },
        );
        init.body = inflated.toString("utf8");
      } catch (err) {
        const tooBig = err && (err.code === "ERR_BUFFER_TOO_LARGE" ||
                               String(err.message).includes("maxOutputLength"));
        return tooBig
          ? res.status(413).send("relay inflated body too large\n")
          : res.status(400).send("relay gunzip failed\n");
      }
    } else if (typeof raw === "string") {
      init.body = raw;
    } else if (isBinary) {
      init.body = Buffer.from(raw).toString("utf8");
    } else {
      init.body = JSON.stringify(raw);
    }
  }

  // The abort timer is cleared as soon as response headers arrive. Keeping it
  // armed through the body would kill a healthy multi-minute stream at the
  // deadline, because the signal covers body reading too — a different question
  // ("has this stalled?") needs a different timer than "has this taken too long?".
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  init.signal = ac.signal;

  try {
    upstream = await fetch(target + path, init);
  } catch (err) {
    clearTimeout(timer);
    // A timeout is not an upstream error in the client's terms: 504 says
    // "the relay gave up", 502 says "the relay could not reach it".
    const timedOut = err && (err.name === "AbortError" || err.name === "TimeoutError");
    return res.status(timedOut ? 504 : 502).send(
      timedOut ? "relay upstream timeout\n" : "relay upstream error\n",
    );
  }
  clearTimeout(timer);

  res.status(upstream.status);
  for (const [k, v] of upstream.headers) {
    if (["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }
  // CRITICAL: Vercel edge caches GET by URL only (x-relay-target is not in
  // the cache key) — forwarded upstream cache-control would serve the wrong
  // target's response. Always disable caching for relay responses.
  res.setHeader("cache-control", "no-store");

  try {
    if (!upstream.body) return res.end();

    // Stream chunk-by-chunk with explicit flushHeaders. Earlier note said
    // res.send() 405s on POST and pipe() hangs without flushing — the fix
    // is to write the head ourselves and hand each chunk to res.write().
    res.flushHeaders();
    const reader = upstream.body.getReader();

    // Idle guard on the body only: upstreams legitimately pause between tokens,
    // so measure the gap between chunks, not the total duration. Reset per chunk.
    let idle = null;
    const armIdle = () => setTimeout(() => reader.cancel().catch(() => {}), UPSTREAM_TIMEOUT_MS);
    try {
      for (;;) {
        idle = armIdle();
        const { done, value } = await reader.read();
        clearTimeout(idle);
        idle = null;
        if (done) break;
        res.write(value);
      }
    } finally {
      if (idle) clearTimeout(idle);
    }
    return res.end();
  } catch (err) {
    // Client hung up, or the idle guard fired: end what we have rather than
    // leaving the response open.
    try { res.end(); } catch {}
    return;
  }
};

module.exports.config = {
  api: {
    // MUST be false: with the parser on, a gzip body is parsed as JSON before
    // this handler runs and the request dies 400 with an empty body (measured).
    bodyParser: false,
  },
};
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

// Read the raw request body from the stream ALONE. Never touch req.body: reading
// that property makes the platform parse the body even with bodyParser:false, and
// a gzip body then fails to parse and the request dies 400 before this handler can
// answer (measured — a probe that only mentions req.body reproduces it, one that
// iterates the stream does not).
async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
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
  try {
    const init = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      let raw;
      try {
        raw = await readRaw(req);
      } catch {
        return res.status(400).send("relay body read failed\n");
      }
      const enc = String(req.headers["content-encoding"] || "").toLowerCase();
      const isBinary = Buffer.isBuffer(raw) || raw instanceof Uint8Array;
      if (enc.includes("gzip")) {
        let gunzipped;
        try {
          gunzipped = zlib
            .gunzipSync(isBinary ? Buffer.from(raw) : Buffer.from(String(raw), "latin1"))
            .toString("utf8");
        } catch {
          return res.status(400).send("relay gunzip failed\n");
        }
        init.body = gunzipped;
      } else if (typeof raw === "string") {
        init.body = raw;
      } else if (isBinary) {
        init.body = Buffer.from(raw).toString("utf8");
      } else {
        init.body = JSON.stringify(raw);
      }
    }
    upstream = await fetch(target + path, init);
  } catch (err) {
    return res.status(502).send("relay upstream error\n");
  }

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
    if (upstream.body) {
      // Stream chunk-by-chunk with explicit flushHeaders. Earlier note said
      // res.send() 405s on POST and pipe() hangs without flushing — the fix
      // is to write the head ourselves and hand each chunk to res.write().
      res.flushHeaders();
      for await (const c of upstream.body) {
        res.write(c);
      }
      return res.end();
    }
    return res.end();
  } catch (err) {
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

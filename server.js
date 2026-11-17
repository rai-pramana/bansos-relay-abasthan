// Standalone relay server for hosts that run a Start Command and route a public
// port to it (Abasthan, Render, Railway, Fly, a plain VPS).
// Same contract as the Vercel/Cloudflare variants: x-relay-target + x-relay-path.
const http = require("node:http");
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
  "content-length", "transfer-encoding", "content-encoding",
]);
const SAFE_PATH = /^\/(?!\/)/;

// A Free-tier instance is 512 MB / 0.1 vCPU. Without these two limits a single
// caller can hang the process: an unbounded body fills RAM, and an upstream that
// never answers holds a socket until the platform kills the container (which
// restarts the whole relay, not just that request).
const MAX_BODY_BYTES = 8 * 1024 * 1024;   // 8 MiB — a 1M-token prompt is ~4 MiB
const UPSTREAM_TIMEOUT_MS = 120_000;      // streaming budget, not idle-connect

function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        // Stop reading and answer 413. Destroying the socket alone loses the
        // response, so write it first, then drain.
        res.writeHead(413, { "content-type": "text/plain", "connection": "close" });
        res.end("relay body too large\n");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", () => { if (!aborted) resolve(null); });
  });
}

const server = http.createServer(async (req, res) => {
  const target = req.headers["x-relay-target"];
  const path = req.headers["x-relay-path"] || "/";

  // Health banner: only when no relay headers are present.
  if (req.method === "GET" && !target) {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.searchParams.get("diag") === "egress") {
      try {
        const echo = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
          signal: AbortSignal.timeout(10000),
        });
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        return res.end(await echo.text());
      } catch {
        res.writeHead(502, { "content-type": "text/plain" });
        return res.end("egress diag failed\n");
      }
    }
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    return res.end("bansos relay ok\n");
  }

  if (!target) { res.writeHead(400); return res.end("missing x-relay-target\n"); }
  if (!ALLOWED_TARGETS.has(target)) { res.writeHead(403); return res.end("forbidden target\n"); }
  if (!SAFE_PATH.test(path)) { res.writeHead(400); return res.end("invalid x-relay-path\n"); }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (FORBIDDEN_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers[k.toLowerCase()] = v;
  }

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await readBody(req, res);
    if (raw === null) return;                    // 413 sent, or socket died
    if (String(req.headers["content-encoding"] || "").includes("gzip")) {
      try { body = zlib.gunzipSync(raw).toString("utf8"); }
      catch { res.writeHead(400); return res.end("relay gunzip failed\n"); }
    } else {
      body = raw.toString("utf8");
    }
  }

  // Streaming pairs badly with a whole-request AbortSignal: the timer keeps
  // running while chunks flow, so a healthy 3-minute stream gets killed at 120s.
  // Clear the timer as soon as response headers arrive; the read loop below
  // guards the body with its own idle timeout.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(target + path, {
      method: req.method, headers, body, signal: ac.signal,
    });
  } catch {
    clearTimeout(timer);
    res.writeHead(504, { "content-type": "text/plain" });
    return res.end("relay upstream timeout or unreachable\n");
  }
  clearTimeout(timer);

  const outHeaders = {};
  for (const [k, v] of upstream.headers) {
    if (["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k.toLowerCase())) continue;
    outHeaders[k] = v;
  }
  outHeaders["cache-control"] = "no-store";
  res.writeHead(upstream.status, outHeaders);

  if (!upstream.body) return res.end();

  // Idle timeout on the body: streaming upstreams legitimately pause between
  // tokens, so measure the gap between chunks, not the total duration.
  const reader = upstream.body.getReader();
  let idle;
  const armIdle = () => setTimeout(() => reader.cancel().catch(() => {}), UPSTREAM_TIMEOUT_MS);
  try {
    for (;;) {
      idle = armIdle();
      const { done, value } = await reader.read();
      clearTimeout(idle);
      if (done) break;
      res.write(value);
    }
  } catch {
    /* client went away or the idle guard fired — fall through to end() */
  } finally {
    clearTimeout(idle);
  }
  res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`bansos relay listening on 0.0.0.0:${PORT}`);
});

// 0.1 vCPU is unforgiving: one unhandled rejection on an await inside the
// handler would take down every in-flight relayed stream.
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err && err.message);
});

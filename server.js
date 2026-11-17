// Abasthan runs a Start Command and routes HTTP to the listening port.
// Standalone Node server: no deps, same handler as the Vercel/CF deployments.
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
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (String(req.headers["content-encoding"] || "").includes("gzip")) {
      try { body = zlib.gunzipSync(raw).toString("utf8"); }
      catch { res.writeHead(400); return res.end("relay gunzip failed\n"); }
    } else {
      body = raw.toString("utf8");
    }
  }

  let upstream;
  try {
    upstream = await fetch(target + path, { method: req.method, headers, body });
  } catch {
    res.writeHead(502, { "content-type": "text/plain" });
    return res.end("relay upstream error\n");
  }

  const outHeaders = {};
  for (const [k, v] of upstream.headers) {
    if (["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k.toLowerCase())) continue;
    outHeaders[k] = v;
  }
  outHeaders["cache-control"] = "no-store";
  res.writeHead(upstream.status, outHeaders);

  if (!upstream.body) return res.end();
  for await (const c of upstream.body) res.write(c);
  res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`bansos relay listening on 0.0.0.0:${PORT}`);
});

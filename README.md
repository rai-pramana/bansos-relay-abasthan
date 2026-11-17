# bansos-relay

A dependency-free HTTP forwarder that turns a tiny PaaS/VPS slot into an
**egress relay**: a stable public URL whose outbound traffic leaves from a
*different IP* than yours. Useful when an upstream rate-limits or geofences by
source IP and you want another address in the pool.

The whole thing is one file (~90 lines) and one dependency: Node's own `http`
module. Deploy it on Vercel, a plain VPS, Render, Railway, Fly, or any host that
can run `node server.js` behind a public port.

**What it is not:** a proxy you can point a browser at, an open relay, or an
auth layer. It forwards only to a hard-coded allowlist of origins, and it
forwards whatever `Authorization` header the caller sends — it stores no keys.

---

## The contract

One request in, one request out. The caller names the destination in headers:

| Header | Meaning |
|---|---|
| `x-relay-target` | Origin to reach, e.g. `https://api.example.com`. **Must be in the allowlist.** |
| `x-relay-path` | Path on that origin, e.g. `/v1/chat/completions`. Must start with a single `/`. |
| *(method, body, other headers)* | Passed through unchanged, except the strip-list below. |

The status code, headers, and body of the upstream response come back to the
caller. No transformation, no buffering of the response.

```bash
curl -X POST https://your-relay.example.com/ \
  -H "x-relay-target: https://api.example.com" \
  -H "x-relay-path: /v1/chat/completions" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $USER_KEY" \
  -d '{"model":"...","messages":[...]}'
```

A `GET /` with no relay headers is a health check: it answers `bansos relay ok`.
`GET /?diag=egress` fetches `https://www.cloudflare.com/cdn-cgi/trace` **from the
relay's own network** and returns it, so you can read the egress IP it is
actually using. That endpoint is the reason this project exists — it is how you
verify which address your traffic leaves from.

### Why those two headers and not a path prefix

A path prefix (`/proxy/https://target/...`) forces you to encode a URL into a URL;
it breaks on query strings, and every CDN in the chain has opinions about
double slashes. Custom headers survive any HTTP hop unmodified and never collide
with the target's own routing.

---

## The code

[`server.js`](server.js) — the entire relay. Read it; it is short on purpose.
The four decisions that matter:

**1. Allowlist, not a blocklist.** `ALLOWED_TARGETS` is a `Set` of origins. A
forwarder that accepts any destination is an open proxy: it will be found by
scanners within hours and used to launder traffic from your IP. There is no
config file to override this — edit the source.

**2. The path is validated as a path.** `SAFE_PATH = /^\/(?!\/)/` rejects
anything not starting with exactly one slash. Without it, a
`x-relay-path: @evil.com/x` would parse as *credentials* against the target
origin and silently retarget the fetch. Node happens to reject credentialed
URLs, but that is luck, not policy.

**3. Hop-by-hop and identity headers are stripped.** `host`,
`x-forwarded-for`, `cf-connecting-ip`, `content-length`,
`transfer-encoding`, `content-encoding` — the first group because forwarding
someone else's client IP upstream is a lie the moment there are two hops, the
second because the body is re-read below and the original length becomes wrong.

**4. The response streams.** `for await (const c of upstream.body) res.write(c)`
— chunk by chunk, never buffered. Buffering would turn a 60-second
time-to-first-token stream into a 60-second wait for the first byte, which is
exactly what client-side connect timeouts punish.

### Two bugs worth knowing about (both cost real time)

**Vercel ignores `bodyParser: false` in ESM.** On Vercel, the handler must be
CommonJS (`module.exports`, `module.exports.config`). With `export default`, the
platform parsed the body as JSON before the handler ran, so any gzipped request
died as `400` with an *empty* body — no stack trace, nothing in the logs. A
probe that merely *mentioned* `req.body` in the source was enough to reproduce
it. The Vercel variant of this file is under [`vercel/`](vercel/) with that
lesson baked in.

**Never read `req.body` if you need the raw stream.** Same trap from the other
side: touching that property makes the platform parse the body, which destroys
a compressed payload. Iterate `req` directly.

---

## Deploying

### Plain VPS / any Node host

```bash
git clone <this repo> && cd <repo>
node server.js          # listens on 0.0.0.0:${PORT:-3000}
```

Put it behind TLS. **Do not** expose it as a raw open port without the
allowlist intact.

### Vercel

See [`vercel/`](vercel/): a separate `api/index.js` in CommonJS form plus the
`vercel.json` that pins `maxDuration`. Two things that are not obvious:

- the handler **must** live at `api/index.js` — a `functions` entry pointing at
  any other path fails the build with `unused_function`;
- once `rewrites` send `/` to `/api`, a project-scoped **Deployment Protection**
  (SSO) will intercept the root URL even after you disable it on the API path.
  Disable it on the project, then confirm `GET /` returns `bansos relay ok`
  *without* credentials before you trust the URL.

### Abasthan (or any "web service" PaaS)

Deploy from a public Git URL, runtime Node 22, start command `node server.js`,
instance `Free`. See [`abasthan/`](abasthan/) for the measured numbers.

---

## Verifying a deployment

Never trust "the build is green". Hit the five contract points:

```bash
R=https://your-relay.example.com

curl -s $R/                                    # -> bansos relay ok
curl -s "$R/?diag=egress" | grep -E '^(ip|loc|colo)='   # -> the egress IP
curl -s -o /dev/null -w '%{http_code}\n' -X POST $R/ \
  -H 'x-relay-target: https://evil.example.com' -d '{}'   # -> 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST $R/ \
  -H 'x-relay-target: https://api.example.com' \
  -H 'x-relay-path: @evil.com/x' -d '{}'                  # -> 400
curl -s -D - -o /dev/null $R/ -H 'x-relay-target: https://api.example.com' \
  -H 'x-relay-path: /'                                    # -> upstream's own headers
```

The fifth check is the one people skip: send a request to an allowlisted origin
and confirm the response carries **the upstream's** headers (a `cf-ray`, a
`server: nginx`, a JSON error body in the upstream's own shape). A `403
forbidden target` means the allowlist rejected you; a `200` with an empty body
means you are talking to your own edge, not the origin.

Two failures that look like relay bugs but are not:

- **A `40x` you did not expect** — read the body. If it is the upstream's JSON
  error, the relay worked. Compare against a direct call to that origin.
- **A `502`/`5xx` Cloudflare HTML page** — that is the CDN in front of *your*
  relay, usually a cold start or the upstream stalling. Retry once; if it is
  reproducible for one path and not another, it is the upstream.

---

## Results from real deployments

| Host | Egress IP observed | Notes |
|---|---|---|
| Vercel (sin1) | `44.200.172.182` · colo `IAD` | Region pins the function, not the egress. Free tier, always on. |
| Abasthan (Free) | `103.42.158.158` · colo `BOM` | India. 6 min idle did **not** sleep it. Cold start ~48 s; warm TTFB 1.2–2.4 s vs 0.6–1.5 s on Vercel. |

The lesson in that table: **you do not choose the egress IP, the host's network
does.** On providers that pin egress per region, deploying in `sin1` still
produced a US address. Always measure `?diag=egress`; never infer it from the
region you selected.

---

## When a relay is the wrong answer

Measure before you build. A relay multiplies **egress IPs**; it does not
multiply a bucket keyed on an API key, an account, or a daily quota. If the
upstream's error says the limit is per account, N relays all share one budget.

And if you are one person with one use case, a single always-on relay plus a
health check is worth more than a fleet you have to babysit.

## License

MIT — see [LICENSE](LICENSE).

# Deploying this relay on Abasthan

Measured 2026-11-17 on the Free tier. Abasthan is a PaaS (Firecracker MicroVMs,
bare metal, built in Bengal, India) — **not** a VPS, even though it exposes SSH.

## Settings that worked

| Field | Value |
|---|---|
| Git Provider | **Public Git Repository** (no GitHub account needed) |
| URL | `https://github.com/<you>/<this-repo>` |
| App Language | Node.js |
| Runtime Version | 22 (default) |
| Branch | your repo's default branch (`master` here — the form pre-fills `main`, so check) |
| Name | anything, e.g. `bansos-relay` |
| Root Directory | *(empty)* |
| Build Command | *(empty)* — there are no dependencies to install |
| Start Command | `node server.js` |
| Instance Type | **Free** (512 MB / 0.1 vCPU) |

The form warns `Could not auto-detect project type` — ignore it, fill the start
command manually.

## What the deploy log should look like

```
Cloning repository...
Repository cloned successfully.
Environment: node 22
⚙️ Start Command: node server.js
Image built.
⚡ Executing start command: docker-entrypoint.sh node server.js
Waiting up to 120s for the app to open a port...
Port discovery: app is listening on 3000,9400 (after 5 s)
🚀 Your app is live ...
bansos relay listening on 0.0.0.0:3000
```

Build from `QUEUE` to `LIVE` took ~3 minutes. The public URL is assigned
automatically (`https://<random-words>.abasthan.app`) and shown on the service
page before the build finishes.

## Measured behaviour

| Metric | Result |
|---|---|
| Egress IP | `103.42.158.158`, colo `BOM` (Mumbai) — **stable across 5 samples / 80 s**, no PTR |
| Cold start (first request after deploy) | ~48 s |
| Warm TTFB | 1.2–2.4 s (same upstream via a Vercel relay: 0.6–1.5 s) |
| Idle 6 minutes and 15 minutes | **did not sleep** — answered in 0.75–1.1 s |
| 8 concurrent requests (74 KB responses) | 8/8 clean in 2.15 s (Vercel: 2.31 s) |
| 74 KB JSON body forwarded | 3/3 clean |
| gzip request body | forwarded correctly (upstream answered in its own shape) |
| **POST body ceiling** | **~1 MiB, enforced by the platform edge before the handler** — 1024 KB reaches the app, 1050 KB returns `nginx 413` |
| 9 MB POST | `413` from the edge, not from the app |

### Rate limits are per egress IP, and shared

`api.llm7.io` rate-limited this relay hard while the same request succeeded from
a home connection and through a Vercel relay:

```
home      -> 200
vercel    -> 200
abasthan  -> 429  retry_after: 2446   (later 2302, 1231 — a long decay)
```

Eight parallel requests produced 1/8 success here versus 4/4 through Vercel. The
`/v1/models` endpoint (no rate limit) served 8/8 at full size, which rules out the
relay's own concurrency as the cause. Treat one Abasthan instance as **one shared
IP with an unknown number of neighbours** — useful as a distinct egress, not as a
high-volume slot.

## Caveats

- **No region choice.** The word "region" does not appear anywhere in the deploy
  form; you get whatever the provider's network gives you. The domain resolves
  through Cloudflare, so the `colo` you see is the CDN edge, not necessarily the
  VM's location.
- **The edge caps POST bodies near 1 MiB.** That is far below the 8 MiB the
  handler itself enforces, and it arrives as an nginx HTML page — so a large
  prompt fails before any relay code runs. Plan the request budget around ~1 MiB,
  or compress (the edge limit applies to the *compressed* size, which is why the
  handler still needs its own inflate cap — see the gzip-bomb note in the
  top-level README).
- **Free tier "sleeps after inactivity"** per the pricing page. Six and fifteen
  minutes were not enough to trigger it; plan for a cold-start penalty whenever
  it does.
- **Cloudflare fronting rejects the default Python `urllib` User-Agent** with
  `error code: 1010`. Any probe must send a normal UA or it will look like the
  relay is broken.
- **SSH access exists but needs a per-service identity.** Docs say
  `ssh -p 22021 <app-id>@connect.abasthan.com`. The app-id is *not* the project
  id — get it from the service's Settings/Shell tab. Even with an SSH key
  registered on the account, the project-level id was rejected
  (`Permission denied (publickey)`), so read the real value from the UI.
- **`abasthan.app` (bare domain) answered 503** throughout testing. Wildcard DNS
  resolves, origin does not. The per-service subdomain worked fine.

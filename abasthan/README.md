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
| Egress IP | `103.42.158.158`, colo `BOM` (Mumbai) |
| Cold start (first request after deploy) | ~48 s |
| Warm TTFB | 1.2–2.4 s (same upstream via a Vercel relay: 0.6–1.5 s) |
| Idle 6 minutes | **did not sleep** — answered in 1.1 s |
| 74 KB JSON body forwarded | 3/3 clean |
| gzip request body | forwarded correctly (upstream answered in its own shape) |
| Concurrency | 0.1 vCPU — assume one request at a time |

## Caveats

- **No region choice.** The word "region" does not appear anywhere in the deploy
  form; you get whatever the provider's network gives you. The domain resolves
  through Cloudflare, so the `colo` you see is the CDN edge, not necessarily the
  VM's location.
- **Free tier "sleeps after inactivity"** per the pricing page. Six minutes was
  not enough to trigger it; plan for a cold-start penalty whenever it does.
- **SSH access exists but needs a per-service identity.** Docs say
  `ssh -p 22021 <app-id>@connect.abasthan.com`. The app-id is *not* the project
  id — get it from the service's Settings/Shell tab. Even with an SSH key
  registered on the account, the project-level id was rejected
  (`Permission denied (publickey)`), so read the real value from the UI.
- **`abasthan.app` (bare domain) answered 503** throughout testing. Wildcard DNS
  resolves, origin does not. The per-service subdomain worked fine.

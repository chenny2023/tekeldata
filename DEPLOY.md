# Deploying WCOIN.CASINO to Railway

One platform, one process: the Fastify server runs the API, all on-chain
indexers/collectors, and serves the built React SPA. No Vercel needed (Vercel
is serverless + ephemeral-FS and cannot run the long-lived indexers or persist
the SQLite database).

The repo already contains everything Railway needs: `Dockerfile`, `railway.json`
(Dockerfile builder + `/api/health` healthcheck), and `.dockerignore` (keeps the
5.4 GB local DB and your `.env` secrets out of the image).

## One-time setup (≈5 minutes)

### 1. Push the repo to GitHub
The project is a local git repo with no remote yet. Create an **empty private**
repo on GitHub, then:
```bash
git remote add origin https://github.com/<you>/wcoin-casino.git
git push -u origin master
```

### 2. Create the Railway project
- Railway → **New Project → Deploy from GitHub repo**.
- When it asks for GitHub access, choose **"Only select repositories" → just
  `wcoin-casino`**. This keeps your other projects completely invisible to
  Railway. ⚠️ Do not grant "All repositories".
- Railway auto-detects `railway.json` → builds with the Dockerfile.

### 3. Add a persistent volume (REQUIRED)
Without this, the SQLite DB is wiped on every redeploy.
- Service → **Variables/Settings → Volumes → New Volume**
- Mount path: **`/app/server/data`**
- Size: start at **10 GB** (the DB is ~5.4 GB locally and grows).

### 4. Set environment variables
Service → **Variables**. Do NOT commit these; set them here.

| Variable | Value | Notes |
|---|---|---|
| `DB_PATH` | `/app/server/data/wcoin.db` | already set in Dockerfile, override only if you change the mount |
| `EVM_RPC` | your Alchemy/Infura ETH RPC URL | from your local `.env` |
| `TRON_JSONRPC` | your GetBlock TRON JSON-RPC URL | from your local `.env` |
| `EMAIL_USER` | your Gmail address, e.g. `you@gmail.com` | **required for public sign-up** — SMTP sender (see below) |
| `EMAIL_PASSWORD` | a Gmail **App Password** (16 chars) | NOT your account password; generate one with 2-Step Verification on |
| `EMAIL_FROM` | optional, e.g. `WCOIN.CASINO <you@gmail.com>` | defaults to `EMAIL_USER` |
| `EMAIL_HOST` / `EMAIL_PORT` | optional | default `smtp.gmail.com` / `465` |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | optional | enables Twitch streamers |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | optional | enables Reddit mentions |

### Email verification codes (free passwordless sign-in)

The product is 100% free: visitors sign up with just an email + a 6-digit code —
no password, no payment. Two transports are supported (first configured wins);
this deployment uses **Gmail SMTP**:

1. On the Google account you'll send from, enable **2-Step Verification**, then
   create an **App Password** (Google Account → Security → App passwords).
2. Set `EMAIL_USER` (the Gmail address) and `EMAIL_PASSWORD` (the 16-char App
   Password). Optionally set `EMAIL_FROM`.

Alternatively, set `RESEND_API_KEY` (+ `RESEND_FROM`, a verified sender) to use
the [Resend](https://resend.com) HTTP API instead. If **both** are set, SMTP wins.

Without any transport configured the server still runs but **only logs the code
to the console** (and never returns it in production) — so nobody can complete
sign-up on the live site until email is configured. Locally (`NODE_ENV !=
production`) the code is also returned in the API response so the flow is
testable without email.

**Do NOT set `HTTP_PROXY`/`HTTPS_PROXY`** — there is no GFW on Railway, so the
collectors must fetch the open web directly (the code already handles a missing
proxy).

`PORT` is injected by Railway automatically — leave it unset.

### 5. Deploy & expose
- Railway builds and starts the service. Healthcheck hits `/api/health`.
- Service → **Settings → Networking → Generate Domain** for a public URL.

## After first deploy

- **Fresh database.** The cloud instance starts with an empty DB and re-indexes
  from scratch — the deep backfill walks ~30 days × 12 chains over several hours
  and consumes RPC quota. To skip that, upload your local
  `server/data/wcoin.db` (+ `-wal`, `-shm`) into the volume once.
- **Memory.** Aggregations scan millions of rows; if the service OOMs, bump the
  instance RAM (Railway → service resources). 1–2 GB is comfortable.
- **Cost.** This app is always-on and RPC-heavy; expect to exceed Railway's free
  $5 credit. Budget ~$5–20/mo depending on resources + the volume.

## Optional: split frontend to Vercel
Not necessary — the server already serves the SPA. If you ever want a CDN-backed
frontend, build with `npm run build`, deploy `dist/` to Vercel, and point its
API calls at the Railway domain. The backend still must live on Railway/a VPS.

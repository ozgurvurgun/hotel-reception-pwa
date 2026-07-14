# Golden Gate Reception

A **hotel front-desk PWA** built entirely on the Cloudflare edge stack: Workers, D1, Durable Objects, Static Assets, Secrets, and Cron Triggers.

## Built for Nazlıcan ♡

This app was made for **Nazlıcan Yılmaz** - my girlfriend, and a receptionist at Golden Gate İstanbul.

I built it so her day at the desk would be lighter: shifts, cash and payments, guest entries, expenses, search, and monthly follow-ups in one place she can open on her phone. Less paper chasing, clearer tracking, fewer “where did that stay?” moments.

And yes - there is a tiny **hidden music player** tucked into the app, just for her. Tap the version label enough times (with the right permission) and it appears. A small gift inside the tool she uses for work. ♡

The codebase is open so others can learn from a real Cloudflare-native ops app - but the reason it exists is simpler: making Nazlıcan’s workday easier.

---

It runs as a full reception tool: shared desk shifts, cash/card/transfer tracking, guest entries, expenses, monthly Excel reports, Web Push digests, and live multi-device sync - all without a traditional backend server.

---

## Why Cloudflare?

This project is a practical answer to: *“Can I ship a serious internal/ops app on Workers alone?”*

The short version of what worked well:

| Need | Cloudflare service | Why it fit |
|------|--------------------|------------|
| API + auth | **Workers** + Hono | One deployable unit, global low latency |
| Relational data | **D1** (SQLite) | Perfect for transactional desk records |
| Static PWA UI | **Workers Static Assets** | No separate CDN/S3 app hosting |
| Live updates | **Durable Objects** + WebSockets | Shared “desk room” fan-out |
| Secrets | **Workers Secrets** | JWT / VAPID / root password never in git |
| Cleanup jobs | **Cron Triggers** | Trim old audit logs without a scheduler server |
| Installable app | Service Worker PWA | Offline shell + push |

You do **not** need ECS, a VPS, Redis, or Nginx for this class of app.

---

## Features

- Shared **desk shift** (open/close, opening/closing cash, notes)
- **Income**, **agency / walk-in guest entry**, **expenses**
- Permission-based staff accounts (root creates users)
- Record edit history (timeline / change log)
- Guest & room **search**
- **Monthly reports** with year filter + Excel export
- Shift detail Excel export
- **Web Push** on shift open/close summaries
- **Realtime** home/records/shifts refresh over WebSocket
- Installable mobile-first PWA (iOS / Android)
- Hidden easter-egg music player (for Nazlıcan ♡)

---

## Architecture

```text
┌──────────────────────────┐
│  Browser PWA (public/)   │
│  HTML/CSS/JS + SW        │
└────────────┬─────────────┘
             │ HTTPS + WSS
┌────────────▼─────────────┐
│ Cloudflare Worker        │
│  Hono API  (/api/*)      │
│  Assets binding          │
│  Cron: audit retention   │
└───┬───────────┬──────────┘
    │           │
┌───▼───┐   ┌───▼────────────┐
│  D1   │   │ Durable Object │
│ SQL   │   │ LiveDesk (WS)  │
└───────┘   └────────────────┘
```

### Request flow

1. Static files (`/`, `/js/*`, icons, audio) come from the **Assets** binding.
2. Authenticated JSON APIs live under `/api/*` (JWT Bearer).
3. Live sync connects to `/api/live?token=…` and is proxied into a single **LiveDesk** Durable Object (`idFromName('main')`).
4. Mutations (open/close shift, create/edit/delete records) write to **D1**, then `waitUntil` a DO broadcast so other devices refresh.

### Key files

```text
src/
  index.ts          Worker entry (routes + cron + LiveDesk export)
  live-desk.ts      Hibernatable WebSocket hub
  live.ts           Broadcast helper (waitUntil-friendly)
  push.ts           Web Push via @pushforge/builder
  permissions.ts    Capability model
  routes/           shifts, transactions, expenses, search, reports, auth, audit
public/             PWA frontend
schema.sql          Full D1 schema
migrations/         Incremental SQL migrations
wrangler.toml       Bindings, DO migration, public vars
```

---

## Cloudflare services used (deep dive)

### 1. Workers

- Runtime: `nodejs_compat` for libraries that expect Node APIs.
- Framework: [Hono](https://hono.dev) - tiny, Works great on Workers.
- Auth: JWT (`jose`) in `Authorization: Bearer …`.
- `ctx.waitUntil(...)` for push + live broadcast **after** the HTTP response returns (keeps the desk UI snappy).

**Lesson:** treat the Worker as your entire backend. Keep handlers short; push heavy fan-out into `waitUntil` or a Durable Object.

### 2. D1

Relational SQLite at the edge for:

- users / permissions
- shifts
- transactions & expenses
- audit logs
- push subscriptions
- record change logs

**Lesson:** model for concurrency at the desk (one open shift, many writers). Prefer clear ownership rules (who can close a shift, who can edit a record) in application code, not only SQL.

Local vs remote:

```bash
# local Miniflare D1
npx wrangler d1 execute YOUR_DB_NAME --local --file=./schema.sql

# production
npx wrangler d1 execute YOUR_DB_NAME --remote --file=./schema.sql
```

### 3. Workers Static Assets

`wrangler.toml`:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
```

The Worker serves unknown paths from Assets (`env.ASSETS.fetch`). This replaces a separate static host.

**Lesson:** ship the API and the PWA in **one** Worker. Fewer moving parts, one deploy.

### 4. Durable Objects + WebSockets

`LiveDesk` is a hibernatable WebSocket server:

- one logical “hotel desk” room
- `acceptWebSocket` + optional auto ping/pong
- `POST /broadcast` internal fan-out used by API routes

**Lesson:** on Cloudflare, multi-client realtime is **Durable Objects**, not a random global Worker isolate. Workers are ephemeral; DOs give you a sticky coordination point.

When to use a DO in your own app:

- chat / presence rooms
- live dashboards
- collaborative cursors
- “everyone looking at the same desk state” (this app)

### 5. Secrets & vars

| Kind | Examples | Where |
|------|----------|--------|
| Public vars | `ROOT_USERNAME`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | `[vars]` in `wrangler.toml` |
| Secrets | `ROOT_PASSWORD`, `JWT_SECRET`, `VAPID_PRIVATE_KEY` | `wrangler secret put` / `.dev.vars` locally |

**Lesson:** never commit secrets. `.dev.vars` is gitignored; production uses encrypted Worker secrets.

### 6. Cron Triggers

The default export includes `scheduled()` to delete old audit rows. Wire it in the Cloudflare dashboard (**Workers → Triggers → Cron**) or via wrangler triggers config, e.g. daily:

```toml
[triggers]
crons = ["0 3 * * *"]
```

### 7. Web Push (not a CF product, but Worker-friendly)

Push is implemented with [`@pushforge/builder`](https://www.npmjs.com/package/@pushforge/builder) using standard **VAPID** keys. Subscriptions are stored in D1; delivery runs in `waitUntil`.

**Lesson:** Cloudflare doesn’t need a special “push product” here - a Worker can send Web Push directly if you keep crypto Worker-compatible.

### 8. Service Worker gotcha (audio / media)

Caching full `.m4a` files in the Cache API **breaks seeking on Android Chrome** (no proper `Range` responses). This app bypasses SW caching for audio. If you serve media from a Worker PWA, remember Range requests.

---

## Quick start (local)

### Prerequisites

- Node.js 20+
- Cloudflare account
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npm i` installs it)

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USER/hatun-otel-app.git
cd hatun-otel-app
npm install
```

### 2. Configure Wrangler

Edit `wrangler.toml`:

1. Set your own `name`
2. Remove or replace `account_id` (Wrangler can infer it when logged in)
3. Create a D1 database and paste its id:

```bash
npx wrangler login
npx wrangler d1 create golden-gate-db
```

```toml
[[d1_databases]]
binding = "DB"
database_name = "golden-gate-db"
database_id = "<paste-id-here>"
```

4. Replace public `[vars]` (especially `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT`) with your own.

Generate VAPID keys:

```bash
npm run setup
# or generate manually and put public key in wrangler.toml
```

### 3. Local secrets

Create `.dev.vars` (see `.dev.vars.example`):

```bash
cp .dev.vars.example .dev.vars
```

```ini
ROOT_PASSWORD=change-me-now
JWT_SECRET=long-random-string
VAPID_PRIVATE_KEY=your-vapid-private-key
```

### 4. Initialize local D1

```bash
npm run db:init
# apply any extra migrations if needed
npx wrangler d1 execute golden-gate-db --local --file=./migrations/002_walk_in.sql
npx wrangler d1 execute golden-gate-db --local --file=./migrations/003_permissions.sql
npx wrangler d1 execute golden-gate-db --local --file=./migrations/004_record_change_logs.sql
```

> Prefer running `schema.sql` on a fresh DB (it already includes the latest tables). Use `migrations/` when upgrading an existing database.

### 5. Run

```bash
npm run dev
```

Open the printed `localhost` URL. Log in with `ROOT_USERNAME` / `ROOT_PASSWORD`.

---

## Deploy to Cloudflare (production)

### 1. Remote database

```bash
npx wrangler d1 execute golden-gate-db --remote --file=./schema.sql
```

If you are upgrading an existing remote DB, run only the missing migration files with `--remote`.

### 2. Production secrets

```bash
npx wrangler secret put ROOT_PASSWORD
npx wrangler secret put JWT_SECRET
npx wrangler secret put VAPID_PRIVATE_KEY
```

### 3. Deploy

```bash
npm run deploy
# → npx wrangler deploy
```

First deploy applies the Durable Object migration tagged in `wrangler.toml` (`v1-live-desk`).

### 4. Optional: custom domain

In the Cloudflare dashboard:

**Workers & Pages → your worker → Settings → Domains & Routes → Add**

Point a hostname (e.g. `reception.example.com`) at the Worker. HTTPS is automatic.

### 5. Optional: cron

Add a cron trigger so `scheduled()` runs (audit log retention).

### 6. Verify

```bash
curl https://YOUR_WORKER.workers.dev/api/health
```

Install the PWA on a phone, open a shift on one device, confirm the banner updates on another (WebSocket live desk).

---

## Permission model

Root (`role = root`) has every permission. Staff get an explicit JSON permission list.

| Key | Meaning |
|-----|---------|
| `shift.open` | Start shared desk shift |
| `shift.close` | Close shift (opener or root) |
| `shift.view.all` | All shifts + monthly reports |
| `income.create` | Add income |
| `expense.create` | Add expense |
| `guest_entry.create` | Agency / walk-in entry |
| `record.edit` | Edit own records (root: all) |
| `record.delete` | Delete own records (root: all) |
| `search.use` | Search |
| `audit.view` | System audit log UI |
| `push.subscribe` | Enable browser push |
| `push.receive` | Receive shift summary pushes |
| `easter_egg.access` | Hidden music player |

User admin is **root-only** (not a assignable staff permission).

---

## Building similar apps on Cloudflare

Use this repo as a template for other ops tools:

### Pattern A - “Single Worker monolith”

Good for reception desks, inventory checklists, small CRM, cafe POS:

1. Hono API on a Worker  
2. D1 for data  
3. `public/` as Assets for the UI  
4. Secrets for credentials  

Ship early. Split only when you must.

### Pattern B - Realtime coordination

Whenever multiple clients must see the same live state:

1. Put a Durable Object per room / store / desk  
2. Clients open WebSockets through the Worker → DO  
3. API writes to D1, then tells the DO to broadcast  

Avoid trying to broadcast from a plain Worker - isolates are not a shared memory space.

### Pattern C - Background work

- Short async: `waitUntil` (push, audit, metrics)  
- Periodic: Cron Triggers  
- Longer workflows: Queues / Workflows (not required by this app)

### Pattern D - Auth

- JWT in localStorage/session is fine for trusted staff PWAs  
- For public apps, prefer HttpOnly cookies + CSRF strategy, or Cloudflare Access in front of the Worker  

### Pattern E - Multi-tenant SaaS

This hotel app is single-tenant. For SaaS:

- one DO per tenant desk, **or**
- tenant_id column everywhere in D1 + careful indexes  
- separate D1 databases per large customer if isolation matters  

### What to skip (usually)

- Running Postgres on a VPS “just because”  
- Redis only for pub/sub when a DO room is enough  
- Separate static S3 + CloudFront for a small PWA  
- Socket.IO servers when hibernatable DO WebSockets cover the fan-out  

---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local Worker + Assets + D1 |
| `npm run deploy` | Production deploy |
| `npm run db:init` | Apply `schema.sql` locally |
| `npm run db:init:remote` | Apply `schema.sql` remotely |
| `npm run setup` | Generate VAPID keypair hints |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run generate:icons` | Rebuild PWA icons |

---

## Security notes

- Rotate `JWT_SECRET` and `ROOT_PASSWORD` before any public deploy.
- Replace sample VAPID keys; they are not yours to keep.
- Strip or replace hotel-specific branding and any copyrighted media under `public/easter-egg/` before redistributing a branded fork.
- `account_id` / `database_id` in `wrangler.toml` are environment-specific - forks must create their own D1.

---

## Tech stack

- **Runtime:** Cloudflare Workers  
- **API:** Hono + TypeScript  
- **DB:** Cloudflare D1  
- **Realtime:** Durable Objects (WebSocket hibernation)  
- **Auth:** JWT (`jose`)  
- **Push:** `@pushforge/builder` (VAPID)  
- **Frontend:** Vanilla JS PWA (no React needed for this UI)  

---

## License

MIT - use it, fork it, run it on your own Cloudflare account.

If you ship a derived hotel/reception product, a star or a mention is appreciated but not required.

---

## Acknowledgements

For **Nazlıcan Yılmaz** - thank you for trusting this into your shift, and for inspiring the whole thing. The hidden playlist is yours.

Built against real front-desk workflow constraints: shared open shifts, hostile mobile browsers, staff permissions, and “it has to update on the other phone right now.” Cloudflare’s Workers + D1 + Durable Objects combination is what made that realistic without operating servers.

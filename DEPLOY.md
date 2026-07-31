# Deployment — all six stages

Work through these in order. Each stage is independently verifiable, so when
something breaks you know which piece did it. DNS comes late because it is the
slowest to debug and the least reversible.

Fill these in as you go — later stages need them:

```
GitHub username     ________________________
Workers URL         https://oqotd-api.__________________.workers.dev
D1 database_id      ________________________
Admin token         ________________________  (openssl rand -hex 24)
```

| Stage | Result |
|---|---|
| 1 | Repo + Pages — site live on `github.io`, local fallback questions |
| 2 | Cloudflare account + D1 — database exists, 114 questions seeded |
| 3 | Deploy Worker — real API answering |
| 4 | Connect frontend — end-to-end voting on `github.io` |
| 5 | DNS + certificate — live on your domain over HTTPS |
| 6 | Generation + admin — weekly drafts, your review queue |

---

## Stage 1 — repo and Pages

```bash
cd officequestionoftheday
git init -b main
git add .
git commit -m "Office Question of the Day"
git remote add origin https://github.com/YOUR-USERNAME/officequestionoftheday.git
git push -u origin main
```

In the repo: **Settings → Pages**.

- Source: **Deploy from a branch**
- Branch: **main**, folder: **`/site`**
- Leave the custom domain field **empty** — that is stage 5

Pages serves only `/site`, which is why `admin/` and `worker/` sit outside it:
the admin page is never publicly reachable and `wrangler.toml` is not served as
a static file. `site/CNAME` already holds your domain — harmless now, needed in
stage 5.

**Checkpoint.** Wait for the green tick on the Actions tab, then open
`https://YOUR-USERNAME.github.io/officequestionoftheday/`.

You should see the whiteboard with a real question and, beneath it in small
caps, *"Offline — your vote won't be counted right now."* That is correct: there
is no API yet, so the page is running its seven-question local fallback. Buttons
work, the tally draws, nothing is recorded.

---

## Stage 2 — Cloudflare account and database

Sign up at cloudflare.com (free), then:

```bash
npm install -g wrangler
wrangler login

cd worker
wrangler d1 create oqotd
```

That prints a `database_id`. Paste it into `wrangler.toml`, replacing
`PASTE_FROM_wrangler_d1_create`. Then:

```bash
wrangler d1 execute oqotd --remote --file=./schema.sql
wrangler d1 execute oqotd --remote --file=./seed.sql
```

`--remote` matters. Without it you write to a local dev database and everything
looks fine until nothing works in production.

**Checkpoint.**

```bash
wrangler d1 execute oqotd --remote --command \
  "SELECT genre, COUNT(*) FROM questions GROUP BY genre"
```

Expect `universal 55`, `workplace 59`.

---

## Stage 3 — deploy the Worker

**Gotcha.** `wrangler.toml` has a `routes` block pointing at
`api.officequestionoftheday.com`. Your domain is not on Cloudflare yet, so
deploy fails with a zone-not-found error. Comment it out for now:

```toml
# routes = [
#   { pattern = "api.officequestionoftheday.com", custom_domain = true }
# ]
```

```bash
openssl rand -hex 24          # copy this
wrangler secret put ADMIN_TOKEN
wrangler deploy
```

Skip `ANTHROPIC_API_KEY` — that is stage 6, and generation is not needed while
you have 114 seeded questions.

Wrangler prints `https://oqotd-api.YOUR-SUBDOMAIN.workers.dev`. Write it down.

**Checkpoint.**

```bash
curl https://oqotd-api.YOUR-SUBDOMAIN.workers.dev/api/today
```

JSON with today's question, `"tally":[0,0]`, and a `qid`. If you get
`{"error":"no_question"}`, the seed did not land — recheck stage 2.

---

## Stage 4 — connect the frontend

**Gotcha.** The Worker only accepts requests from origins in its allowlist, and
`github.io` is not one of them. Votes fail with a CORS error until you add it.

In `worker/src/index.js`, near the top:

```js
const ALLOWED_ORIGINS = [
  'https://officequestionoftheday.com',
  'https://www.officequestionoftheday.com',
  'https://YOUR-USERNAME.github.io',      // add this
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
```

In `site/index.html`:

```js
const API_BASE = 'https://oqotd-api.YOUR-SUBDOMAIN.workers.dev';
```

```bash
cd worker && wrangler deploy
cd .. && git add -A && git commit -m "Connect frontend to API" && git push
```

**Checkpoint.** Open your `github.io` URL. The "Offline" line is gone, replaced
by "One new question every day." Vote — you should see `1`, a single tally mark,
and "You are the first vote today."

Reload. Your choice persists and the count stays at **1, not 2**.

```bash
wrangler d1 execute oqotd --remote --command \
  "SELECT choice, country, publish_date FROM votes"
```

Your own country code coming back is the moment the whole thing is working.

---

## Stage 5 — DNS and certificate

In Cloudflare: **Add a site** → `officequestionoftheday.com` → Free plan. It
gives you two nameservers.

In GoDaddy: **My Products → DNS → Nameservers → Change → I'll use my own
nameservers**. Enter Cloudflare's two. Usually active within the hour.

Once active, in Cloudflare **DNS → Records**:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | @ | 185.199.108.153 | **DNS only** |
| A | @ | 185.199.109.153 | **DNS only** |
| A | @ | 185.199.110.153 | **DNS only** |
| A | @ | 185.199.111.153 | **DNS only** |
| AAAA | @ | 2606:50c0:8000::153 | **DNS only** |
| AAAA | @ | 2606:50c0:8001::153 | **DNS only** |
| AAAA | @ | 2606:50c0:8002::153 | **DNS only** |
| AAAA | @ | 2606:50c0:8003::153 | **DNS only** |
| CNAME | www | `YOUR-USERNAME.github.io` | **DNS only** |

Grey cloud, not orange, on all nine. GitHub must answer the certificate
challenge itself, and a proxied record intercepts it.

```bash
dig officequestionoftheday.com +noall +answer -t A
dig www.officequestionoftheday.com +noall +answer -t CNAME
```

**Only once both resolve**, set the custom domain in GitHub **Settings → Pages**
to `officequestionoftheday.com`.

Order matters: GitHub issues one certificate covering apex and `www` together.
Set the domain before DNS resolves and you get a certificate covering only one
of them — the other throws a TLS error. Fix: clear the custom domain field,
save, re-add it, save. That forces reissue.

Wait for "DNS check successful", then tick **Enforce HTTPS**.

Now give the API its own subdomain: uncomment the `routes` block in
`wrangler.toml` and `wrangler deploy`. Cloudflare creates the `api` record
itself. Update `API_BASE` in `site/index.html` to
`https://api.officequestionoftheday.com`, commit, push.

**Checkpoint.** Both `officequestionoftheday.com` and
`www.officequestionoftheday.com` load over HTTPS with no warning, and voting
works on both.

---

## Stage 6 — generation and review queue

Get an API key from console.anthropic.com. Separate from your Claude
subscription and billed separately — 20 questions a week is a few cents a month.

```bash
cd worker
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

Cron triggers activate on deploy: daily 00:05 UTC for scheduling, Mondays 09:00
UTC for generation. Cron is included on the free plan.

Test now rather than waiting for Monday. Set `API_BASE` in `admin/index.html`,
then:

```bash
cd admin && python3 -m http.server 8000
```

At `localhost:8000`, paste your admin token → **Load queue** (runway ≈ 55 days)
→ **Generate more**.

**Checkpoint.** After roughly ten seconds: "Added 14 drafts. 6 candidates failed
the quality gate." Read the drafts — the ones you would reject tell you whether
the prompt needs tuning. Approve a few, reject the rest, confirm runway rose.

---

## Before you promote it

**Clear your test votes.** Otherwise a dozen of your own clicks sit inside your
first real numbers:

```bash
wrangler d1 execute oqotd --remote --command \
  "DELETE FROM votes; DELETE FROM tallies; DELETE FROM country_tallies;"
```

Questions and schedule are untouched — only the counters reset.

**Enable Workers Paid ($5/month).** On the free tier, hitting the D1 write limit
makes the site silently stop counting votes. That happens on your best day.

**Add a rate limit.** Cloudflare **Security → WAF → Rate limiting rules**, path
`/api/vote`, 10 requests per minute per IP. The `UNIQUE(question_id, client_id)`
constraint already makes a repeat vote from one browser a no-op, but that is
clearable from the browser console, so the rate limit is what actually holds.

**Make `site/og.png`** at 1200×630. For something whose whole purpose is being
shared, the link preview does real work.

---

## Watch these two numbers in the first fortnight

**Are the splits actually close?** If most questions land above 75/25, the
predicted-split guesses in the seed bank were optimistic and the generation gate
needs tightening past 25–75. A question without a real minority has no payoff.

**Do people come back the next day?** That is the only number that tells you
whether this is a site or just a link.

---

## When something breaks

| Symptom | Cause |
|---|---|
| `no_question` from `/api/today` | seed did not load, or `--remote` omitted |
| Vote fails, console shows CORS | origin missing from `ALLOWED_ORIGINS` |
| Apex TLS error, `www` fine | certificate issued before apex DNS resolved — re-add domain |
| Deploy: zone not found | `routes` block uncommented before the domain is on Cloudflare |
| Counts frozen, site shows "Offline" | D1 daily write limit — check the `events` table |
| Vote count doubles on reload | `localStorage` blocked, or `client_id` not persisting |

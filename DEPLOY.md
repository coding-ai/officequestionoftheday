# Deployment — empty folder to production

Follow top to bottom. Every stage ends in a check you can run; don't move on
until it passes. Stages 1–6 get you a live, working site. Stages 7–9 are
optional additions you can do any time after.

## Record these as you go

```
GitHub username     ________________________
Workers URL         https://oqotd-api.__________________.workers.dev
OG Worker URL       https://oqotd-og.___________________.workers.dev
D1 database_id      ________________________
Admin token         ________________________  (write-only once stored)
VAPID public key    ________________________
VAPID private JWK   ________________________  (never commit)
```

## The one rule

**Exactly one `wrangler.*` file per Worker folder, and none above them.**

Wrangler prefers `wrangler.jsonc` over `wrangler.toml` and searches parent
directories, without telling you which it chose. A stray config is what caused
every failure in the previous attempt: deploys landing on a Worker named `d1`,
secrets vanishing, `server_error` on every request, "cannot tail a Worker which
only has assets". `bash check.sh` now tests for this first.

```bash
find . -name "wrangler*" -not -path "./.git/*" -not -path "*/node_modules/*"
```

Correct output is exactly two lines: `./worker/wrangler.jsonc` and
`./og-worker/wrangler.jsonc`. Run this whenever anything behaves oddly.

---

## Stage 0 — accounts and tools

| Need | Where |
|---|---|
| GitHub account | github.com |
| Cloudflare account | cloudflare.com (free) |
| Domain | already yours at GoDaddy |
| Node 18+ | `node -v` |
| Wrangler | `npm install -g wrangler && wrangler login` |

```bash
node -v && wrangler --version && wrangler whoami
```

### If you are re-running after a failed attempt

Delete every Worker for this project in the dashboard under **Compute
(Workers)** — `oqotd-api`, `oqotd-og`, and any stray such as `d1`. Then:

```bash
wrangler d1 list
wrangler d1 delete NAME        # each project database
rm -rf .wrangler worker/.wrangler
```

D1 deletion is permanent and `--local` does **not** protect you — it always
acts on remote. That is fine here; there is nothing but test votes.

---

## Stage 1 — repo and GitHub Pages

```bash
cd ~/Repos
unzip ~/Downloads/oqotd-v3.zip
cd officequestionoftheday
ls -a
```

Expect: `.gitignore  DEPLOY.md  README.md  admin/  docs/  og-worker/  worker/`

```bash
git init -b main
git add .
git commit -m "Office Question of the Day"
git remote add origin https://github.com/YOUR-USERNAME/officequestionoftheday.git
git push -u origin main
```

In the repo: **Settings → Pages**

- Source: **Deploy from a branch**
- Branch: **main**, folder: **`/docs`**
- Leave the custom domain field empty — stage 6

GitHub offers only root or `/docs`, which is why the site lives in `docs/`
despite not being documentation. That folder is also what keeps `worker/`,
`og-worker/` and `admin/` unpublished — your admin page is never reachable and
no config is served as a static file.

**Check:** `https://YOUR-USERNAME.github.io/officequestionoftheday/` shows the
question with *"Offline — your vote won't be counted"* beneath it. That line is
correct: no API exists yet, so the page is on its local fallback. Tapping an
answer still animates the reveal.

---

## Stage 2 — database

```bash
cd worker
wrangler d1 create oqotd
```

Paste the UUID into `wrangler.jsonc` over `PASTE_DATABASE_ID_HERE`. Then:

```bash
wrangler d1 execute oqotd --remote --file=./schema.sql
wrangler d1 execute oqotd --remote --file=./seed.sql
```

`--remote` matters. Without it you write to a local dev database and everything
looks fine until nothing works in production.

**Read both outputs.** If a statement fails, wrangler prints the error and
stops — this scrolled past unnoticed last time and left a half-applied schema.

**Check:**

```bash
wrangler d1 execute oqotd --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
```

Nine tables: `country_tallies`, `events`, `push_subs`, `questions`,
`room_tallies`, `rooms`, `schedule`, `tallies`, `votes`.

```bash
wrangler d1 execute oqotd --remote --command \
  "SELECT genre, COUNT(*) FROM questions GROUP BY genre"
```

`universal 55`, `workplace 59`.

---

## Stage 3 — admin token, then deploy

Generate the token yourself; nobody issues it. It is the password to your own
`/admin/*` endpoints.

```bash
openssl rand -hex 24
```

**Save that string now** — once in Cloudflare it is write-only. You can replace
it, never read it back.

```bash
wrangler secret put ADMIN_TOKEN     # paste at the prompt
bash check.sh
```

Everything must be green except the optional amber items (Anthropic key, VAPID,
OG_BASE, API_BASE). Then:

```bash
wrangler deploy
```

**Read the output and confirm three things:**

- name is `oqotd-api` — not `d1`, not anything else
- `DB` is bound to the UUID from stage 2
- the URL printed is `https://oqotd-api.SOMETHING.workers.dev`

Write that URL down. If any is wrong, stop and run the `find` command above.

**Check:**

```bash
curl https://oqotd-api.YOUR-SUBDOMAIN.workers.dev/api/today
```

JSON with today's question and `"tally":[0,0]`.

```bash
curl -i -H "Authorization: Bearer YOUR_TOKEN" \
  https://oqotd-api.YOUR-SUBDOMAIN.workers.dev/admin/queue
```

JSON with `drafts` and `runway_days: 55`. A 401 means the token does not match
what is stored — set it again with no trailing space, and redeploy.

---

## Stage 4 — connect the frontend

Two edits. First the allowlist, in `worker/src/index.js` near the top:

```js
const ALLOWED_ORIGINS = [
  'https://officequestionoftheday.com',
  'https://www.officequestionoftheday.com',
  'https://YOUR-USERNAME.github.io',      // add this
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
```

Then `API_BASE`, which appears in **three files**. Missing one gives you a
half-working site that is annoying to diagnose:

| File | Breaks if missed |
|---|---|
| `docs/index.html` | the whole site |
| `docs/sw.js` | notifications show generic text |
| `admin/index.html` | question review |

```bash
cd ..
grep -rn "API_BASE = " docs/index.html docs/sw.js admin/index.html
```

Set all three to `https://oqotd-api.YOUR-SUBDOMAIN.workers.dev`, then:

```bash
cd worker && wrangler deploy && cd ..
bash worker/check.sh          # the API_BASE section should now be green
git add -A && git commit -m "Connect frontend to API" && git push
```

**Check:** open your `github.io` URL. The offline line is gone. Vote — you get
`1 vote`, the bar fills, "You're the first vote today." Reload: your choice
persists and the count stays at **1, not 2**.

```bash
wrangler d1 execute oqotd --remote --command \
  "SELECT choice, country, room_code FROM votes"
```

Your own country code coming back means the chain works end to end.

---

## Stage 5 — test rooms

Still on the `github.io` URL: click **Create a room**. You get a four-character
code and the page reloads. Vote. The office panel shows your office against the
world — with one vote it will say so rather than showing a split.

```bash
wrangler d1 execute oqotd --remote --command \
  "SELECT r.code, rt.count_a, rt.count_b FROM rooms r
     LEFT JOIN room_tallies rt ON rt.room_code = r.code"
```

Open the site in a private window, join with the same code, vote the other way,
and the office numbers should diverge from the world.

---

## Stage 6 — domain and certificate

In Cloudflare: **Add a site** → `officequestionoftheday.com` → Free plan. Copy
the two nameservers it gives you.

In GoDaddy: **My Products → DNS → Nameservers → Change → I'll use my own**.
Enter Cloudflare's two. Usually active within the hour.

Then **DNS → Records**. Delete any imported GoDaddy parking records on `@`, and
set these — all nine **DNS only / grey cloud**:

| Type | Name | Content |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | `YOUR-USERNAME.github.io` |

**Grey cloud is not optional.** Proxied records make Cloudflare answer for you,
which intercepts the challenge GitHub uses to prove domain control — the
certificate then never issues.

```bash
dig @1.1.1.1 officequestionoftheday.com +noall +answer -t A
dig @1.1.1.1 www.officequestionoftheday.com +noall +answer -t CNAME
```

Apex must return the four `185.199.10x` addresses. Seeing `104.21.x` or
`172.67.x` means something is still proxied.

**Only once both resolve:** GitHub **Settings → Pages** → custom domain →
`officequestionoftheday.com` → wait for "DNS check successful" → tick **Enforce
HTTPS**.

GitHub issues one certificate covering apex and `www` together. If only one
works, clear the custom domain field, save, re-add, save — that forces reissue.

### API subdomain

Now the zone is on Cloudflare, add to `worker/wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "api.officequestionoftheday.com", "custom_domain": true }
],
```

```bash
cd worker && wrangler deploy
```

Doing this before the zone was active is what produced "Could not find zone".
Cloudflare creates the `api` record itself — it will be **Proxied**, which is
correct for a Worker. The grey-cloud rule applies only to the Pages records.

Update `API_BASE` in all three files to `https://api.officequestionoftheday.com`,
commit, push.

**Check:** apex and `www` both load over HTTPS, and voting works on both.

**You are live.** Everything below is optional.

---

## Stage 7 — link preview images

Without this, every shared link shows the same static image. With it, the
preview shows the actual question and its live split.

```bash
cd og-worker
npm install
```

Paste the same `database_id` from stage 2 into `og-worker/wrangler.jsonc`, then:

```bash
wrangler deploy
```

Note the URL it prints. Put it in `worker/wrangler.jsonc` as `OG_BASE`, then:

```bash
cd ../worker && wrangler deploy
```

**Check:**

```bash
curl -sI https://oqotd-og.YOUR-SUBDOMAIN.workers.dev/og/today.png | head -3
curl -s https://api.officequestionoftheday.com/s/$(date -u +%F) | grep 'og:image'
```

First should be `200` with `content-type: image/png`. Second should show the og
URL pointing at the image Worker.

Then paste `https://api.officequestionoftheday.com/s/YYYY-MM-DD` into Slack or
WhatsApp and confirm the preview renders.

This is a second Worker with its own config. Keep the folders separate and
never let a stray config into either.

---

## Stage 8 — notifications

```bash
cd worker
node keys.mjs
```

**Generate this once and keep it.** Replacing the key pair silently
invalidates every existing subscription — people stop receiving notifications
and never find out.

Paste the public key into `wrangler.jsonc` as `VAPID_PUBLIC_KEY`, then:

```bash
wrangler secret put VAPID_PRIVATE_JWK      # the single JSON line
wrangler deploy
wrangler secret list                        # three secrets now
```

**Check:**

```bash
curl https://api.officequestionoftheday.com/api/push/key
```

Should return your public key.

To test the prompt without waiting two days, open devtools console on the site:

```js
localStorage.setItem('oqotd_hist', JSON.stringify({entries:[
  {qid:1, day:Math.floor(Date.now()/86400000)-1, resolved:true, minority:true},
  {qid:2, day:Math.floor(Date.now()/86400000),   resolved:true, minority:false}
]}));
```

Reload and vote — the prompt appears after the reveal.

The prompt never fires on a first visit by design. A browser "block" is close
to permanent and cannot be asked again, so it waits for two separate days of
answering and appears only after a reveal. iPhone users are asked to install to
the home screen first, since Safari allows push only from an installed PWA.

---

## Stage 9 — automatic question generation

Optional — the 55 universal questions give you about two months without it.

Get a key from console.anthropic.com. This is a **separate account** from a
Claude subscription and billed separately. Add **$5** and **leave auto-reload
off**, so your spend is capped at what you loaded. Usage is one call a week,
well under a cent.

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

Test now rather than waiting for Monday:

```bash
cd ../admin && python3 -m http.server 8000
```

At `localhost:8000`: paste your admin token → **Load queue** → **Generate more**.

**Check:** "Added 14 drafts. 6 candidates failed the quality gate." Read the
drafts; the ones you would reject tell you whether the prompt needs tuning.

---

## Before you tell anyone

```bash
wrangler d1 execute oqotd --remote --command \
  "DELETE FROM votes; DELETE FROM tallies; DELETE FROM country_tallies; DELETE FROM room_tallies;"
```

Otherwise your own test clicks sit inside your first real numbers. Questions
and schedule are untouched.

- [ ] **Workers Paid, $5/month.** On the free tier, hitting the D1 write limit
      makes the site silently stop counting votes — on your best day.
- [ ] **Rate limit.** Cloudflare **Security → WAF → Rate limiting rules**, path
      `/api/vote`, 10 per minute per IP.
- [ ] **`docs/og.png`** at 1200×630, the fallback when the renderer is down.
- [ ] **Privacy note.** `push_subs` holds a per-device endpoint — the only
      personal data in the system. One short page saying you store a push
      endpoint and anonymous aggregate votes, nothing else.
- [ ] Install to your own phone and check the notification arrives at 9am.

---

## Troubleshooting

Run `bash check.sh` first.

| Symptom | Cause |
|---|---|
| `server_error` on every request | `database_id` points at a database that doesn't exist |
| `secret list` empty after setting one | secret went to another Worker — use `--name oqotd-api` |
| "Cannot tail a Worker which only has assets" | wrangler resolved a different config with an assets block |
| "Variables cannot be added…" in dashboard | same cause — you're looking at an assets-only Worker |
| Deploy targets the wrong name | a stray config is winning — run the `find` command |
| 401 from `/admin/queue` | token mismatch, or set on a different Worker |
| "Failed to fetch" in admin | check `/api/today` first; if that fails this is downstream |
| "Could not find zone" | `routes` added before the domain was active on Cloudflare |
| CORS error on vote | origin missing from `ALLOWED_ORIGINS`, or not redeployed |
| Apex TLS error, `www` fine | certificate issued before apex DNS resolved — re-add domain |
| Link preview shows the old image | `OG_BASE` unset, or the scraper cached it (they cache hard) |
| Notification shows generic text | `API_BASE` not set in `docs/sw.js` |
| No notification prompt ever | fewer than two days answered, or permission already denied |

**The meta-lesson:** when several unrelated-looking things break at once, it's
usually one thing pointed at the wrong target. Before debugging symptoms, run
`wrangler deploy --dry-run` and confirm what wrangler thinks it's deploying.

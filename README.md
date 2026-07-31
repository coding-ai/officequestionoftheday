# Office Question of the Day

Static site on GitHub Pages, API and database on Cloudflare Workers + D1.
One binary question per UTC day, identical for every visitor worldwide, with
one vote per browser and vote-level data retained for analysis.

```
site/           → GitHub Pages (public)
worker/         → Cloudflare Worker + D1 (deployed separately)
admin/          → question review page — run locally, never publish
```

---

## 1. Repository and Pages

```bash
git init
git add . && git commit -m "Initial build"
gh repo create officequestionoftheday --public --source=. --push
```

In **Settings → Pages**, set the source to `main` branch, folder `/site`.
Leave the custom domain field blank for now — step 2 sets it.

> `site/.nojekyll` stops Jekyll processing. `site/CNAME` is already set to
> `officequestionoftheday.com`; don't delete it, Pages needs it.

The `admin/` folder is inside the repo but outside the Pages publishing
directory, so it is never served. Open it with `python3 -m http.server` locally.

---

## 2. DNS

**Recommended: move DNS to Cloudflare, keep GoDaddy as registrar.** Free, and it
gets you an `api.` subdomain on the Worker, rate limiting on the vote endpoint,
and cache rules. Add the site at Cloudflare, copy the two nameservers it gives
you, then in GoDaddy: *My Products → DNS → Nameservers → Change → I'll use my own*.

Then create these records (set the proxy to **DNS only / grey cloud** — GitHub
needs to answer the certificate challenge itself):

| Type  | Name | Value |
|-------|------|-------|
| A     | @    | 185.199.108.153 |
| A     | @    | 185.199.109.153 |
| A     | @    | 185.199.110.153 |
| A     | @    | 185.199.111.153 |
| AAAA  | @    | 2606:50c0:8000::153 |
| AAAA  | @    | 2606:50c0:8001::153 |
| AAAA  | @    | 2606:50c0:8002::153 |
| AAAA  | @    | 2606:50c0:8003::153 |
| CNAME | www  | `YOUR-GH-USERNAME.github.io` |

*Staying on GoDaddy DNS instead is fine — same records, in **DNS → Manage Zones**.
You then can't use `api.officequestionoftheday.com`, so delete the `routes` block
in `wrangler.toml` and set `API_BASE` in `site/index.html` to the
`oqotd-api.<subdomain>.workers.dev` URL that `wrangler deploy` prints.*

### Order of operations — this one bites people

1. Verify the domain first: **GitHub → Settings → Pages → Add a domain**, at the
   *profile* level, not the repository level. Without this, someone else can
   claim a subdomain of yours.
2. Add the A/AAAA records **and** the `www` CNAME, then wait for both to resolve.
3. Only then set the custom domain in the repository's Pages settings.

GitHub issues one certificate covering both the apex and `www`. If you add the
apex after the certificate already exists, `www` works and the bare domain
throws a TLS error. Fix: remove the custom domain, save, re-add it, save — that
forces reissue. Then tick **Enforce HTTPS**.

```bash
dig officequestionoftheday.com +noall +answer -t A
dig www.officequestionoftheday.com +noall +answer -t CNAME
```

Propagation can take a few hours; the certificate usually appears within 15
minutes of DNS resolving.

---

## 3. Database and Worker

```bash
cd worker
npm install -g wrangler && wrangler login

wrangler d1 create oqotd            # paste database_id into wrangler.toml
wrangler d1 execute oqotd --remote --file=./schema.sql
wrangler d1 execute oqotd --remote --file=./seed.sql

wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ADMIN_TOKEN      # openssl rand -hex 24

wrangler deploy
```

Check it:

```bash
curl https://api.officequestionoftheday.com/api/today
```

The seed bank holds 60 approved questions, so day one works before generation
has ever run. Cron pre-assigns today and tomorrow at 00:05 UTC.

**A note on the day boundary.** The question rolls over at midnight UTC. Every
office sees the same question on the same date, which is what makes the data
comparable — but it means a US west-coast office gets the new question at 5pm
their previous afternoon. If that bothers you, change `utcDate()` to subtract
6 hours; keep it consistent, because `publish_date` is the join key for
everything downstream.

---

## 4. Question generation

- **Monday 09:00 UTC** — the Worker asks Claude for 20 candidates, then rejects
  anything that fails the gate in `validate()`: over 14 words, options over 24
  characters, predicted split outside 25–75, or more than 50% token overlap with
  any of the last 250 questions. Survivors land as `draft`.
- **You review** at `admin/index.html`. Edit wording in place, approve or reject.
  Realistically two or three minutes a week.
- **Daily 00:05 UTC** — the oldest approved-and-unpublished question is assigned
  to today. If the approved pool is under 21, generation runs early.

The lopsided check is the one doing the real work. A question everyone answers
the same way isn't a question, and that's the failure mode an LLM defaults to.

`AUTO_APPROVE = "true"` skips your review entirely. I'd leave it off: question
quality *is* the product, one bad question reaches every visitor at once, and
there's no undo once it's published and screenshotted.

If the approved pool ever empties, the Worker replays the least recently used
question rather than showing an error. The frontend also carries seven questions
locally, so the board renders even if the API is completely down — it just says
so and doesn't record the vote.

---

## 5. Analytics

Vote-level rows are kept indefinitely. Pull them out whenever:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.officequestionoftheday.com/admin/export?from=2026-08-01&to=2026-08-31" \
  -o august.csv
```

Or query D1 directly:

```sql
-- Most divisive questions ever asked
SELECT q.text, t.count_a + t.count_b AS votes,
       ROUND(100.0 * t.count_a / (t.count_a + t.count_b), 1) AS pct_a
  FROM tallies t JOIN questions q ON q.id = t.question_id
 WHERE t.count_a + t.count_b > 200
 ORDER BY ABS(50 - pct_a) ASC
 LIMIT 20;

-- Where a country departs most from the global answer
WITH g AS (SELECT question_id, 100.0*count_a/(count_a+count_b) AS global_a
             FROM tallies WHERE count_a+count_b > 500)
SELECT q.text, c.country, c.count_a + c.count_b AS n,
       ROUND(100.0*c.count_a/(c.count_a+c.count_b) - g.global_a, 1) AS delta
  FROM country_tallies c
  JOIN g ON g.question_id = c.question_id
  JOIN questions q ON q.id = c.question_id
 WHERE c.count_a + c.count_b > 100
 ORDER BY ABS(delta) DESC
 LIMIT 30;

-- Which categories split people down the middle
SELECT q.category, COUNT(*) AS questions,
       ROUND(AVG(ABS(50.0 - 100.0*t.count_a/(t.count_a+t.count_b))), 1) AS avg_distance_from_even
  FROM tallies t JOIN questions q ON q.id = t.question_id
 WHERE t.count_a + t.count_b > 200
 GROUP BY q.category ORDER BY avg_distance_from_even ASC;

-- Weekday effect: are people harsher on Mondays?
SELECT weekday, COUNT(*) AS votes,
       ROUND(100.0 * SUM(choice = 0) / COUNT(*), 1) AS pct_a
  FROM votes WHERE question_id = ? GROUP BY weekday ORDER BY weekday;
```

### What is and isn't collected

Stored: question, choice, UTC date, weekday, hour, country and continent (from
Cloudflare's edge headers), a mobile flag, and a random browser-generated id used
only to stop one browser voting twice.

Not stored: IP addresses, user-agent strings, referrers, names, emails, or
anything that identifies a person or an employer. There are no third-party
scripts and no analytics cookies, which is why the site needs no consent banner.

That changes the moment you add a "company size" or "seniority" dropdown. Do add
one eventually — it's what makes the data properly interesting — but put it
*after* the vote so it never adds friction, keep it optional, and write a real
privacy notice at that point.

---

## 6. Cost and scale

| | Free tier | Where it breaks |
|---|---|---|
| Workers | 100k requests/day | ~40k daily visitors (2 calls each) |
| D1 writes | 100k rows/day | ~33k votes/day (3 counter rows per vote) |
| D1 reads | 5M rows/day | not the binding limit here |
| D1 storage | 5 GB | millions of votes |

**Turn on Workers Paid ($5/month) before you promote it.** When you hit a free
D1 limit, queries start returning errors — the site degrades to its offline
fallback and stops counting votes, on precisely the day you don't want that.
Beyond the $5, D1 charges $1 per million rows written; a genuinely viral day
costs a few cents.

Two things that keep it stable under a spike:

- `/api/today` sends `Cache-Control: max-age=15`, so a burst of traffic mostly
  hits cache instead of the database.
- Counters live in `tallies`, maintained by a database trigger. A page load never
  runs `COUNT(*)` over the votes table — that would read a million rows for a
  popular question and exhaust the read quota in minutes.

Add a Cloudflare rate limiting rule on `api.officequestionoftheday.com/api/vote`
— 10 requests per minute per IP is generous for a human and stops casual
tampering. The `UNIQUE(question_id, client_id)` constraint already makes repeat
votes from one browser a silent no-op, but that's clearable, so the rate limit
matters. This data is only ever indicative, not a scientific sample; worth
remembering before publishing a chart from it.

---

## Deployment checklist

- [ ] `wrangler.toml` — `database_id` filled in
- [ ] `ANTHROPIC_API_KEY` and `ADMIN_TOKEN` set as secrets, not vars
- [ ] `site/index.html` — `API_BASE` points at your deployed Worker
- [ ] `admin/index.html` — `API_BASE` matches; file is **not** in `site/`
- [ ] Domain verified at GitHub profile level
- [ ] A, AAAA, and `www` CNAME records resolving
- [ ] Enforce HTTPS ticked, apex *and* `www` both load over TLS
- [ ] `curl /api/today` returns a question
- [ ] Vote once, reload — your choice persists and the tally doesn't double
- [ ] `og.png` added at `site/og.png` (1200×630) for link previews
- [ ] Workers Paid enabled before any real promotion

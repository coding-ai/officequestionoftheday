/**
 * Office Question of the Day — API Worker
 *
 * Endpoints
 *   GET  /api/today                  today's question + live tally + country split
 *   POST /api/vote                   { qid, choice, client_id }
 *   GET  /api/archive?days=7         previous questions with final splits
 *   GET  /admin/queue                drafts awaiting review           [bearer]
 *   POST /admin/review               { id, action, text?, option_a?, option_b? } [bearer]
 *   POST /admin/generate             manually trigger generation      [bearer]
 *   GET  /admin/export?from=&to=     vote-level CSV for analysis      [bearer]
 *
 * Cron
 *   5 0 * * *    schedule today + tomorrow, top up the queue if it's low
 *   0 9 * * 1    generate next week's candidates
 */

const ALLOWED_ORIGINS = [
  'https://officequestionoftheday.com',
  'https://www.officequestionoftheday.com',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const MIN_QUEUE = 21;          // top up generation when fewer than 3 weeks approved
const GENERATE_BATCH = 14;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/* ------------------------------------------------------------------ utils */

const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);
const shiftDate = (isoDate, days) =>
  utcDate(new Date(Date.parse(isoDate + 'T00:00:00Z') + days * 86400000));

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function json(data, { status = 200, origin = '', cache = 0 } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Short edge cache absorbs traffic spikes without showing stale results.
      'Cache-Control': cache ? `public, max-age=${cache}` : 'no-store',
      ...cors(origin),
    },
  });
}

const authed = (req, env) =>
  !!env.ADMIN_TOKEN && req.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;

async function log(env, kind, detail) {
  try {
    await env.DB.prepare('INSERT INTO events (kind, detail) VALUES (?, ?)')
      .bind(kind, typeof detail === 'string' ? detail : JSON.stringify(detail)).run();
  } catch { /* logging must never break a request */ }
}

/* ------------------------------------------------------- scheduling logic */

/**
 * Returns the question for a UTC date, assigning one if none is set yet.
 * Never returns null while any approved question remains — the board is
 * never empty, which is the whole point of keeping the curated bank around.
 */
async function questionForDate(env, date) {
  const sql = `SELECT q.id, q.text, q.option_a, q.option_b, q.category, q.genre
                 FROM schedule s JOIN questions q ON q.id = s.question_id
                WHERE s.publish_date = ?`;

  let row = await env.DB.prepare(sql).bind(date).first();
  if (row) return row;

  // One workplace question a week (default Wednesday), universal the rest of
  // the time. The silly questions carry the traffic; the workplace ones build
  // the dataset. Falls through to the other genre if that pool is dry.
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  const wanted = weekday === Number(env.WORKPLACE_WEEKDAY ?? 3) ? 'workplace' : 'universal';

  const pick = genre => env.DB.prepare(
    `SELECT id FROM questions
      WHERE status = 'approved' AND genre = ?
        AND id NOT IN (SELECT question_id FROM schedule)
      ORDER BY created_at ASC, id ASC LIMIT 1`
  ).bind(genre).first();

  const next = (await pick(wanted))
            || (await pick(wanted === 'workplace' ? 'universal' : 'workplace'));

  if (!next) {
    await log(env, 'queue_empty', { date });
    // Last resort: replay the least recently used question rather than 404.
    row = await env.DB.prepare(
      `SELECT q.id, q.text, q.option_a, q.option_b, q.category
         FROM questions q JOIN schedule s ON s.question_id = q.id
        WHERE q.status = 'approved' ORDER BY s.publish_date ASC LIMIT 1`
    ).first();
    return row || null;
  }

  // INSERT OR IGNORE + re-read makes this safe under concurrent first hits.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO schedule (publish_date, question_id) VALUES (?, ?)'
  ).bind(date, next.id).run();

  return await env.DB.prepare(sql).bind(date).first();
}

/* ── rooms ──────────────────────────────────────────────────────
   A four-character code a person shares with their team. Alphabet excludes
   I, L, O, 0 and 1 so a code read aloud or off a whiteboard is unambiguous. */
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const validRoom = c => typeof c === 'string' && /^[A-HJ-NP-Z2-9]{4}$/.test(c.toUpperCase());

function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

async function createRoom(env, name) {
  // 31^4 ≈ 923k codes. Retry on the rare collision rather than hoping.
  for (let i = 0; i < 6; i++) {
    const code = newRoomCode();
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO rooms (code, name) VALUES (?, ?)'
    ).bind(code, (name || '').slice(0, 40) || null).run();
    if (res.meta?.changes === 1) return code;
  }
  return null;
}

async function roomSplit(env, code, qid) {
  const r = await env.DB.prepare(
    'SELECT count_a, count_b FROM room_tallies WHERE room_code = ? AND question_id = ?'
  ).bind(code, qid).first();
  const a = r?.count_a || 0, b = r?.count_b || 0;
  return { tally: [a, b], total: a + b };
}

async function tallyFor(env, qid) {
  const t = await env.DB.prepare(
    'SELECT count_a, count_b FROM tallies WHERE question_id = ?'
  ).bind(qid).first();
  return [t?.count_a || 0, t?.count_b || 0];
}

async function countrySplit(env, qid, limit = 8) {
  const { results } = await env.DB.prepare(
    `SELECT country, count_a, count_b FROM country_tallies
      WHERE question_id = ? AND country != 'ZZ'
      ORDER BY (count_a + count_b) DESC LIMIT ?`
  ).bind(qid, limit).all();
  return (results || [])
    .filter(r => r.count_a + r.count_b >= 15)   // don't publish a split off 3 votes
    .map(r => ({
      country: r.country,
      total: r.count_a + r.count_b,
      pct_a: Math.round(r.count_a / (r.count_a + r.count_b) * 100),
    }));
}

/* --------------------------------------------------------------- handlers */

async function handleToday(env, origin, roomCode) {
  const date = utcDate();
  const q = await questionForDate(env, date);
  if (!q) return json({ error: 'no_question' }, { status: 503, origin });

  const [a, b] = await tallyFor(env, q.id);
  const body = {
    date,
    qid: q.id,
    text: q.text,
    option_a: q.option_a,
    option_b: q.option_b,
    category: q.category,
    tally: [a, b],
    total: a + b,
    by_country: a + b >= 100 ? await countrySplit(env, q.id) : [],
  };

  if (roomCode && validRoom(roomCode)) {
    const code = roomCode.toUpperCase();
    const room = await env.DB.prepare('SELECT code, name FROM rooms WHERE code = ?').bind(code).first();
    if (room) body.room = { code, name: room.name, ...(await roomSplit(env, code, q.id)) };
  }

  // A room-specific response must not be served from another room's cache.
  return json(body, { origin, cache: roomCode ? 0 : 15 });
}

async function handleVote(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, { status: 400, origin }); }

  const choice = Number(body.choice);
  const qid = Number(body.qid);
  const clientId = String(body.client_id || '');
  const roomCode = validRoom(body.room_code) ? String(body.room_code).toUpperCase() : null;

  if (![0, 1].includes(choice) || !Number.isInteger(qid) || qid <= 0) {
    return json({ error: 'bad_request' }, { status: 400, origin });
  }
  if (!/^[0-9a-f-]{16,40}$/i.test(clientId)) {
    return json({ error: 'bad_client_id' }, { status: 400, origin });
  }

  // Votes are only accepted for the question actually live right now.
  const date = utcDate();
  const live = await env.DB.prepare(
    'SELECT question_id FROM schedule WHERE publish_date = ?'
  ).bind(date).first();

  if (!live || live.question_id !== qid) {
    return json({ error: 'stale_question', reload: true }, { status: 409, origin });
  }

  const cf = req.cf || {};
  const now = new Date();

  // UNIQUE(question_id, client_id) makes a repeat vote a silent no-op, and the
  // AFTER INSERT trigger keeps every counter in step with the vote rows.
  // Only attribute the vote to a room that actually exists.
  let room = null;
  if (roomCode) {
    const found = await env.DB.prepare('SELECT code FROM rooms WHERE code = ?').bind(roomCode).first();
    if (found) room = roomCode;
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO votes
       (question_id, publish_date, choice, country, continent, is_mobile, weekday, hour_utc, room_code, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    qid, date, choice,
    cf.country || null,
    cf.continent || null,
    /Mobile|Android|iPhone/i.test(req.headers.get('User-Agent') || '') ? 1 : 0,
    now.getUTCDay(), now.getUTCHours(),
    room,
    clientId
  ).run();

  if (room) {
    await env.DB.prepare("UPDATE rooms SET last_vote = datetime('now') WHERE code = ?").bind(room).run();
  }

  const [a, b] = await tallyFor(env, qid);
  const out = {
    qid, tally: [a, b], total: a + b,
    by_country: a + b >= 100 ? await countrySplit(env, qid) : [],
  };
  if (room) out.room = { code: room, ...(await roomSplit(env, room, qid)) };
  return json(out, { origin });
}

async function handleArchive(env, origin, days) {
  const n = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
  const from = shiftDate(utcDate(), -n);
  const to = shiftDate(utcDate(), -1);

  const { results } = await env.DB.prepare(
    `SELECT s.publish_date, q.id, q.text, q.option_a, q.option_b,
            COALESCE(t.count_a, 0) AS a, COALESCE(t.count_b, 0) AS b
       FROM schedule s
       JOIN questions q ON q.id = s.question_id
       LEFT JOIN tallies t ON t.question_id = q.id
      WHERE s.publish_date BETWEEN ? AND ?
      ORDER BY s.publish_date DESC`
  ).bind(from, to).all();

  return json({
    questions: (results || []).map(r => ({
      date: r.publish_date, qid: r.id, text: r.text,
      option_a: r.option_a, option_b: r.option_b,
      tally: [r.a, r.b], total: r.a + r.b,
    })),
  }, { origin, cache: 300 });
}

/* ---------------------------------------------------- question generation */

const GENERATION_PROMPT = `You write the daily question for "Office Question of the Day" — one binary question that gets written on a whiteboard at work, argued about, and then checked online to see how the rest of the world answered.

The entire payoff is a person discovering they are in the minority on something they assumed was universal. If you can guess how almost everyone answers, you have not written a question.

TWO GENRES. Write roughly three "universal" for every one "workplace".

genre "universal" — a small private habit nobody ever discusses, so nobody knows there are two camps. The model here is "What goes on first: socks or trousers?" People are genuinely astonished that anyone does it the other way. Draw on: getting dressed, washing, the bathroom, sleep, food and how it is eaten, phones, queues, stairs, lifts, travel, tiny superstitions and routines. Not about work at all — it just gets asked at work.

genre "workplace" — an opinion about working life: meetings, email and chat etiquette, the kitchen, calendars, managers, desks, hours, and the unwritten social contracts between colleagues.

RULES
1. Exactly two options. Each option 1-4 words, and they must be true opposites, not two shades of the same answer.
2. Under 14 words. It gets handwritten on a whiteboard.
3. Predicted split between 25/75 and 50/50. This is the rule that matters most and the one you will be tempted to break. "Milk before cereal?" is 85/15 and therefore useless. Before you write a question, guess the split honestly; if it is lopsided, discard it and write another.
4. The answer must be instant. If someone has to deliberate, they will not answer.
5. Globally legible. Nothing that only lands in one country (no "PTO", "401k", "bank holiday", "Thanksgiving", no national brands or TV shows).
6. Safe to ask out loud at work, and safe for the person to answer honestly in front of colleagues. Never touch: politics, religion, nationality, ethnicity, gender, sexuality, disability, health, bodies or appearance, anyone's actual salary, or anything gross. Nothing that invites criticism of a named employer.
7. Plain words, second person. No puns, no cleverness for its own sake. Use "would you rather" only when the two options are genuinely comparable.
8. Do not repeat or paraphrase anything in the EXISTING list, including asking the same habit from a different angle.

CATEGORIES
universal: dressing, bathroom, sleep, home, food, habits, travel
workplace: meetings, comms, kitchen, managers, hours, social, career, tools, space

Return ONLY a JSON array, no prose and no markdown fences. Each element:
{"text": "...", "option_a": "...", "option_b": "...", "genre": "universal", "category": "...", "predicted_a": 45, "why_it_splits": "one short sentence"}`;

function normalise(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !['your', 'have', 'does', 'that', 'with', 'this', 'they', 'would', 'rather', 'office', 'work'].includes(w));
}

function tooSimilar(candidate, existingTokenSets) {
  const tokens = new Set(normalise(candidate));
  if (!tokens.size) return true;
  for (const prev of existingTokenSets) {
    let shared = 0;
    for (const t of tokens) if (prev.has(t)) shared++;
    const jaccard = shared / (tokens.size + prev.size - shared);
    if (jaccard > 0.5) return true;
  }
  return false;
}

/** Programmatic gate. The model is a drafting tool; these rules are the editor. */
function validate(candidates, existingTokenSets) {
  const kept = [], rejected = [];
  const seen = [...existingTokenSets];

  for (const c of candidates) {
    const reason = (() => {
      if (!c || typeof c.text !== 'string') return 'malformed';
      if (!c.option_a || !c.option_b) return 'missing_option';
      if (c.text.length > 90) return 'too_long';
      if (c.text.trim().split(/\s+/).length > 14) return 'too_many_words';
      if (String(c.option_a).length > 24 || String(c.option_b).length > 24) return 'option_too_long';
      if (String(c.option_a).toLowerCase() === String(c.option_b).toLowerCase()) return 'identical_options';
      const p = Number(c.predicted_a);
      if (!Number.isFinite(p) || p < 25 || p > 75) return 'lopsided';
      if (tooSimilar(c.text, seen)) return 'duplicate';
      return null;
    })();

    if (reason) { rejected.push({ text: c?.text ?? '(malformed)', reason }); continue; }
    seen.push(new Set(normalise(c.text)));
    kept.push(c);
  }
  return { kept, rejected };
}

async function generateQuestions(env, count = GENERATE_BATCH) {
  if (!env.ANTHROPIC_API_KEY) return { error: 'no_api_key' };

  const { results } = await env.DB.prepare(
    'SELECT text FROM questions ORDER BY id DESC LIMIT 250'
  ).all();
  const existingTexts = (results || []).map(r => r.text);
  const existingTokenSets = existingTexts.map(t => new Set(normalise(t)));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: 3000,
      system: GENERATION_PROMPT,
      messages: [{
        role: 'user',
        content: `Write ${count + 6} new questions: about ${Math.round((count + 6) * 0.7)} universal and the rest workplace. Vary the categories; no more than three from any one category.\n\nEXISTING (do not repeat or paraphrase):\n${existingTexts.slice(0, 150).map(t => '- ' + t).join('\n')}`,
      }],
    }),
  });

  if (!res.ok) {
    await log(env, 'generation_failed', { status: res.status, body: (await res.text()).slice(0, 400) });
    return { error: 'api_error', status: res.status };
  }

  const data = await res.json();
  const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

  let candidates;
  try {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    candidates = JSON.parse(raw.slice(start, end + 1));
  } catch {
    await log(env, 'generation_unparseable', raw.slice(0, 400));
    return { error: 'unparseable' };
  }

  const { kept, rejected } = validate(Array.isArray(candidates) ? candidates : [], existingTokenSets);
  const toInsert = kept.slice(0, count);

  // AUTO_APPROVE=true publishes without review. Off by default: question quality
  // is the product, and one bad question reaches everyone at once.
  const status = String(env.AUTO_APPROVE).toLowerCase() === 'true' ? 'approved' : 'draft';

  for (const c of toInsert) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO questions
         (text, option_a, option_b, genre, category, status, source, predicted_a)
       VALUES (?, ?, ?, ?, ?, ?, 'generated', ?)`
    ).bind(c.text.trim(), String(c.option_a).trim(), String(c.option_b).trim(),
           c.genre === 'workplace' ? 'workplace' : 'universal',
           c.category || 'general', status, Math.round(Number(c.predicted_a))).run();
  }

  await log(env, 'generation_run', { inserted: toInsert.length, rejected: rejected.length, status });
  return { inserted: toInsert.length, status, rejected };
}

/* ------------------------------------------------------------ admin views */

async function handleQueue(env, origin) {
  const [drafts, approved] = await Promise.all([
    env.DB.prepare(
      `SELECT id, text, option_a, option_b, genre, category, predicted_a, created_at
         FROM questions WHERE status = 'draft' ORDER BY id ASC LIMIT 60`).all(),
    env.DB.prepare(
      `SELECT genre, COUNT(*) AS n FROM questions
        WHERE status = 'approved' AND id NOT IN (SELECT question_id FROM schedule)
        GROUP BY genre`).all(),
  ]);
  const pool = Object.fromEntries((approved.results || []).map(r => [r.genre, r.n]));
  return json({
    drafts: drafts.results || [],
    // Universal questions run 6 days a week, workplace 1 — so runway is set by
    // the universal pool, not the total.
    runway_days: pool.universal || 0,
    pool,
  }, { origin });
}

async function handleReview(req, env, origin) {
  const { id, action, text, option_a, option_b } = await req.json();
  if (!['approve', 'reject'].includes(action) || !Number.isInteger(Number(id))) {
    return json({ error: 'bad_request' }, { status: 400, origin });
  }
  if (action === 'approve' && text) {
    await env.DB.prepare(
      `UPDATE questions SET text = ?, option_a = COALESCE(?, option_a),
                            option_b = COALESCE(?, option_b), status = 'approved'
        WHERE id = ? AND status = 'draft'`
    ).bind(text.trim(), option_a || null, option_b || null, id).run();
  } else {
    await env.DB.prepare(
      `UPDATE questions SET status = ? WHERE id = ? AND status = 'draft'`
    ).bind(action === 'approve' ? 'approved' : 'rejected', id).run();
  }
  return json({ ok: true }, { origin });
}

async function handleExport(env, url, origin) {
  const to = url.searchParams.get('to') || utcDate();
  const from = url.searchParams.get('from') || shiftDate(to, -30);

  const { results } = await env.DB.prepare(
    `SELECT v.publish_date, v.question_id, q.text, q.category,
            CASE v.choice WHEN 0 THEN q.option_a ELSE q.option_b END AS answer,
            v.choice, v.country, v.continent, v.is_mobile, v.weekday, v.hour_utc, v.created_at
       FROM votes v JOIN questions q ON q.id = v.question_id
      WHERE v.publish_date BETWEEN ? AND ?
      ORDER BY v.id ASC LIMIT 200000`
  ).bind(from, to).all();

  const cols = ['publish_date','question_id','text','category','answer','choice',
                'country','continent','is_mobile','weekday','hour_utc','created_at'];
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...(results || []).map(r => cols.map(c => esc(r[c])).join(','))].join('\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="oqotd-${from}-to-${to}.csv"`,
      ...cors(origin),
    },
  });
}

async function handleRoomCreate(req, env, origin) {
  let body = {};
  try { body = await req.json(); } catch {}
  const code = await createRoom(env, body.name);
  if (!code) return json({ error: 'could_not_allocate' }, { status: 503, origin });
  return json({ code, name: (body.name || '').slice(0, 40) || null }, { origin });
}

async function handleRoomGet(env, origin, code) {
  if (!validRoom(code)) return json({ error: 'bad_code' }, { status: 400, origin });
  const up = code.toUpperCase();
  const room = await env.DB.prepare('SELECT code, name FROM rooms WHERE code = ?').bind(up).first();
  if (!room) return json({ error: 'not_found' }, { status: 404, origin });

  const q = await questionForDate(env, utcDate());
  const split = q ? await roomSplit(env, up, q.id) : { tally: [0, 0], total: 0 };
  const members = await env.DB.prepare(
    'SELECT COUNT(DISTINCT client_id) AS n FROM votes WHERE room_code = ?'
  ).bind(up).first();

  return json({ code: up, name: room.name, members: members?.n || 0, ...split }, { origin });
}

/* Share shim.
   GitHub Pages serves one static HTML file, and social scrapers do not run
   JavaScript — so a link preview can never show today's question if it points
   at the site directly. This route returns a tiny page carrying the right
   Open Graph tags for scrapers, and bounces real browsers to the site. */
async function handleShare(env, url, date) {
  const today = utcDate();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;

  const row = await env.DB.prepare(
    `SELECT q.id, q.text, q.option_a, q.option_b,
            COALESCE(t.count_a,0) AS a, COALESCE(t.count_b,0) AS b
       FROM schedule s JOIN questions q ON q.id = s.question_id
       LEFT JOIN tallies t ON t.question_id = q.id
      WHERE s.publish_date = ?`
  ).bind(d).first();

  const site = 'https://officequestionoftheday.com/';
  if (!row) return Response.redirect(site, 302);

  const total = row.a + row.b;
  const desc = total >= 10
    ? `${Math.round(row.a / total * 100)}% say ${row.option_a}. ${total.toLocaleString('en-GB')} votes so far — where do you land?`
    : `${row.option_a} or ${row.option_b}? Cast your vote.`;

  // The renderer is a separate Worker on another hostname, so its address has
  // to come from config — url.origin here is the API. Before that Worker is
  // deployed, fall back to the static image so previews still work.
  const ogBase = (env.OG_BASE || '').replace(/\/+$/, '');
  const og = ogBase ? `${ogBase}/og/${d}.png` : 'https://officequestionoftheday.com/og.png';
  const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(row.text)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(row.text)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:type" content="website">
<meta property="og:url" content="${url.href}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${og}">
<link rel="canonical" href="${site}">
<meta http-equiv="refresh" content="0; url=${site}">
</head><body><p>Redirecting to <a href="${site}">officequestionoftheday.com</a></p></body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

/* ── web push ───────────────────────────────────────────────────
   Payload-less: the push carries no data, so there is no aes128gcm
   encryption layer to get wrong, and the service worker fetches the current
   question when it wakes. A late notification still shows today's question. */

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vapidHeaders(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:hello@officequestionoftheday.com',
  })));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload)
  );
  return {
    'Authorization': `vapid t=${header}.${payload}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`,
    'TTL': '10800',                 // drop it rather than deliver hours late
    'Urgency': 'normal',
    'Content-Length': '0',
  };
}

async function sendPush(env, endpoint) {
  const res = await fetch(endpoint, { method: 'POST', headers: await vapidHeaders(env, endpoint) });
  // 404/410 mean the subscription is permanently gone — stop storing it.
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'fail';
}

async function handlePushSubscribe(req, env, origin) {
  if (!env.VAPID_PRIVATE_JWK) return json({ error: 'push_not_configured' }, { status: 503, origin });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, { status: 400, origin }); }

  const endpoint = String(body.endpoint || '');
  if (!/^https:\/\/[^\s]{10,600}$/.test(endpoint)) {
    return json({ error: 'bad_endpoint' }, { status: 400, origin });
  }
  // Offset as given by the browser (minutes WEST of UTC), converted to the UTC
  // hour at which it is 9am for this person.
  const offsetMin = -Number(body.utc_offset_minutes || 0);
  if (!Number.isFinite(offsetMin) || Math.abs(offsetMin) > 900) {
    return json({ error: 'bad_offset' }, { status: 400, origin });
  }
  const hour = Math.floor((((9 * 60 - offsetMin) % 1440) + 1440) % 1440 / 60);

  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, send_hour_utc) VALUES (?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET send_hour_utc = excluded.send_hour_utc, fails = 0`
  ).bind(endpoint, hour).run();

  return json({ ok: true, send_hour_utc: hour }, { origin });
}

async function handlePushUnsubscribe(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, { status: 400, origin }); }
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(body.endpoint || '')).run();
  return json({ ok: true }, { origin });
}

/** Hourly fan-out: notify everyone for whom it is now roughly 9am. */
async function runPushHour(env, hourUtc) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const { results } = await env.DB.prepare(
    'SELECT endpoint FROM push_subs WHERE send_hour_utc = ? AND fails < 3 LIMIT 900'
  ).bind(hourUtc).all();
  if (!results?.length) return;

  let sent = 0, gone = 0, failed = 0;
  // Small concurrent batches: kind to subrequest limits, still quick.
  for (let i = 0; i < results.length; i += 25) {
    const slice = results.slice(i, i + 25);
    const outcomes = await Promise.all(slice.map(async r => {
      try { return [r.endpoint, await sendPush(env, r.endpoint)]; }
      catch { return [r.endpoint, 'fail']; }
    }));
    for (const [endpoint, outcome] of outcomes) {
      if (outcome === 'gone') {
        gone++;
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
      } else if (outcome === 'fail') {
        failed++;
        await env.DB.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').bind(endpoint).run();
      } else {
        sent++;
        await env.DB.prepare(
          "UPDATE push_subs SET last_sent = datetime('now'), fails = 0 WHERE endpoint = ?"
        ).bind(endpoint).run();
      }
    }
  }
  await log(env, 'push_hour', { hourUtc, sent, gone, failed });
}

/* ---------------------------------------------------------------- routing */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    try {
      if (path === '/api/today' && req.method === 'GET')
        return await handleToday(env, origin, url.searchParams.get('room'));
      if (path === '/api/vote' && req.method === 'POST') return await handleVote(req, env, origin);
      if (path === '/api/archive' && req.method === 'GET')
        return await handleArchive(env, origin, url.searchParams.get('days'));

      if (path === '/api/room' && req.method === 'POST') return await handleRoomCreate(req, env, origin);
      if (path.startsWith('/api/room/') && req.method === 'GET')
        return await handleRoomGet(env, origin, path.slice('/api/room/'.length));

      if (path.startsWith('/s/')) return await handleShare(env, url, path.slice(3));

      if (path === '/api/push/subscribe' && req.method === 'POST')
        return await handlePushSubscribe(req, env, origin);
      if (path === '/api/push/unsubscribe' && req.method === 'POST')
        return await handlePushUnsubscribe(req, env, origin);
      if (path === '/api/push/key' && req.method === 'GET')
        return json({ key: env.VAPID_PUBLIC_KEY || null }, { origin, cache: 3600 });

      if (path.startsWith('/admin')) {
        if (!authed(req, env)) return json({ error: 'unauthorised' }, { status: 401, origin });
        if (path === '/admin/queue') return await handleQueue(env, origin);
        if (path === '/admin/review' && req.method === 'POST') return await handleReview(req, env, origin);
        if (path === '/admin/generate' && req.method === 'POST')
          return json(await generateQuestions(env), { origin });
        if (path === '/admin/export') return await handleExport(env, url, origin);
      }

      return json({ error: 'not_found' }, { status: 404, origin });
    } catch (err) {
      await log(env, 'request_error', { path, message: String(err).slice(0, 300) });
      return json({ error: 'server_error' }, { status: 500, origin });
    }
  },

  async scheduled(event, env) {
    // Hourly: notify everyone for whom it has just turned 9am.
    if (event.cron === '0 * * * *') {
      await runPushHour(env, new Date(event.scheduledTime).getUTCHours());
      return;
    }

    // Pre-assign today and tomorrow so no visitor ever pays the scheduling cost,
    // and so you can see what is going out before it goes out.
    const today = utcDate();
    await questionForDate(env, today);
    await questionForDate(env, shiftDate(today, 1));

    const runway = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM questions
        WHERE status = 'approved' AND genre = 'universal'
          AND id NOT IN (SELECT question_id FROM schedule)`
    ).first();

    const weekly = event.cron === '0 9 * * 1';
    if (weekly || (runway?.n || 0) < MIN_QUEUE) {
      await generateQuestions(env);
    }
  },
};

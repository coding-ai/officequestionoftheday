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

async function handleToday(env, origin) {
  const date = utcDate();
  const q = await questionForDate(env, date);
  if (!q) return json({ error: 'no_question' }, { status: 503, origin });

  const [a, b] = await tallyFor(env, q.id);
  return json({
    date,
    qid: q.id,
    text: q.text,
    option_a: q.option_a,
    option_b: q.option_b,
    category: q.category,
    tally: [a, b],
    total: a + b,
    by_country: a + b >= 100 ? await countrySplit(env, q.id) : [],
  }, { origin, cache: 15 });
}

async function handleVote(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, { status: 400, origin }); }

  const choice = Number(body.choice);
  const qid = Number(body.qid);
  const clientId = String(body.client_id || '');

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
  await env.DB.prepare(
    `INSERT OR IGNORE INTO votes
       (question_id, publish_date, choice, country, continent, is_mobile, weekday, hour_utc, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    qid, date, choice,
    cf.country || null,
    cf.continent || null,
    /Mobile|Android|iPhone/i.test(req.headers.get('User-Agent') || '') ? 1 : 0,
    now.getUTCDay(), now.getUTCHours(),
    clientId
  ).run();

  const [a, b] = await tallyFor(env, qid);
  return json({
    qid, tally: [a, b], total: a + b,
    by_country: a + b >= 100 ? await countrySplit(env, qid) : [],
  }, { origin });
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

/* ---------------------------------------------------------------- routing */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    try {
      if (path === '/api/today' && req.method === 'GET') return await handleToday(env, origin);
      if (path === '/api/vote' && req.method === 'POST') return await handleVote(req, env, origin);
      if (path === '/api/archive' && req.method === 'GET')
        return await handleArchive(env, origin, url.searchParams.get('days'));

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

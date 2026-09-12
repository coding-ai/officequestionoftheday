/**
 * Office Question of the Day — link preview images.
 *
 *   GET /og/YYYY-MM-DD.png    the question and its live split, as a 1200x630 PNG
 *   GET /og/today.png         shorthand for the current UTC day
 *
 * Deployed separately from the API on purpose: this bundles a wasm rasteriser,
 * and neither its size nor its failure modes should touch the vote path.
 *
 * Every response is cached at the edge, so a link shared a thousand times
 * renders once.
 */

import { ImageResponse } from 'workers-og';

const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* Long questions need to shrink or they overflow the card. */
function titleSize(text) {
  const n = text.length;
  if (n <= 34) return 82;
  if (n <= 52) return 68;
  if (n <= 72) return 57;
  return 48;
}

function card({ text, optionA, optionB, a, b }) {
  const total = a + b;
  const resolved = total >= 10;
  const pa = total ? Math.round(a / total * 100) : 50;
  const widthA = Math.max(18, Math.min(82, total ? (a / total) * 100 : 50));

  const stat = resolved
    ? `${total.toLocaleString('en-GB')} VOTES`
    : 'BE THE FIRST TO ANSWER';

  const pill = (label, pct, colour, soft, width) => `
    <div style="display:flex;position:relative;width:100%;height:96px;border-radius:14px;
                background:rgba(238,240,247,0.04);border:1px solid rgba(238,240,247,0.10);
                overflow:hidden;">
      <div style="display:flex;position:absolute;left:0;top:0;bottom:0;width:${width}%;
                  background:${soft};"></div>
      <div style="display:flex;position:absolute;left:0;top:0;bottom:0;width:6px;background:${colour};"></div>
      <div style="display:flex;width:100%;align-items:center;justify-content:space-between;
                  padding:0 32px 0 38px;">
        <div style="display:flex;font-size:38px;color:#EEF0F7;font-weight:500;">${esc(label)}</div>
        <div style="display:flex;font-size:38px;color:${colour};font-weight:600;">${resolved ? pct + '%' : ''}</div>
      </div>
    </div>`;

  return `
  <div style="display:flex;flex-direction:column;width:1200px;height:630px;
              background:#0B0D18;padding:64px 70px;justify-content:space-between;
              font-family:'Space Grotesk',sans-serif;">

    <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
      <div style="display:flex;align-items:center;">
        <div style="display:flex;width:12px;height:12px;border-radius:6px;background:#FF6B4A;margin-right:16px;"></div>
        <div style="display:flex;font-size:21px;letter-spacing:4px;color:#7C8398;">
          OFFICE QUESTION OF THE DAY
        </div>
      </div>
      <div style="display:flex;font-size:19px;letter-spacing:3px;color:#474D63;">${stat}</div>
    </div>

    <div style="display:flex;font-size:${titleSize(text)}px;line-height:1.08;color:#EEF0F7;
                font-weight:600;max-width:1040px;letter-spacing:-2px;">
      ${esc(text)}
    </div>

    <div style="display:flex;flex-direction:column;width:100%;gap:16px;">
      ${pill(optionA, pa, '#FF6B4A', 'rgba(255,107,74,0.17)', widthA)}
      ${pill(optionB, 100 - pa, '#3DD9C4', 'rgba(61,217,196,0.17)', 100 - widthA)}
    </div>
  </div>`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/og\/([0-9-]{4,10}|today)\.png$/);
    if (!m) return new Response('Not found', { status: 404 });

    // Serve from edge cache when we can: one render, many shares.
    const cache = caches.default;
    const hit = await cache.match(req);
    if (hit) return hit;

    const date = m[1] === 'today' ? utcDate() : m[1];

    let row;
    try {
      row = await env.DB.prepare(
        `SELECT q.text, q.option_a, q.option_b,
                COALESCE(t.count_a,0) AS a, COALESCE(t.count_b,0) AS b
           FROM schedule s JOIN questions q ON q.id = s.question_id
           LEFT JOIN tallies t ON t.question_id = q.id
          WHERE s.publish_date = ?`
      ).bind(date).first();
    } catch {
      row = null;
    }

    // Never 500 into a link preview — fall back to the static image.
    if (!row) return Response.redirect('https://officequestionoftheday.com/og.png', 302);

    try {
      const res = new ImageResponse(
        card({ text: row.text, optionA: row.option_a, optionB: row.option_b, a: row.a, b: row.b }),
        { width: 1200, height: 630 }
      );
      const out = new Response(res.body, res);
      // Short TTL: the split moves through the day, so a preview shared this
      // afternoon should not show this morning's numbers.
      out.headers.set('Cache-Control', 'public, max-age=600');
      ctx.waitUntil(cache.put(req, out.clone()));
      return out;
    } catch {
      return Response.redirect('https://officequestionoftheday.com/og.png', 302);
    }
  },
};

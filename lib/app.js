const express = require('express');
const crypto = require('crypto');
const { q, tx, ready } = require('./db');
const { secret, BASE_URL, EVENT, DB_URL } = require('./config');
const mpesa = require('./mpesa');
const T = require('./tickets');
const mailer = require('./mailer');

// Postgres returns COUNT/SUM/BIGINT as strings by default, which breaks arithmetic ('5' + 2 = '52').
// Parse them as numbers when the driver is "pg"; the num() coercions below protect the math either way.
try {
  const { types } = require('pg');
  types.setTypeParser(20, Number);   // bigint: COUNT(), SUM(int), BIGINT columns (our ms timestamps)
  types.setTypeParser(1700, Number); // numeric: SUM(bigint)
} catch (_) { /* a different driver is in use; coercions below still apply */ }
const num = (v) => Number(v) || 0;

const IS_PROD = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
const HOLD_MS = 4 * 60 * 1000; // a pending STK push holds its slots for 4 minutes
const MIN_PIN_LENGTH = 6;

// ---------- staff PINs (no insecure defaults in production) ----------
// Trim spaces and stray quotes, which are easy to paste into Vercel's settings by accident
const pinFromEnv = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
const ADMIN_ENV = process.env.ADMIN_PIN || process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || process.env.PASSWORD;
const SCANNER_ENV = process.env.SCANNER_PIN || process.env.SCANNER_PASSWORD || process.env.SCANNER_PASS;

function resolvePin(raw, devFallback, label) {
  if (!raw) {
    return IS_PROD
      ? { pin: null, problem: `${label} is not set, so that login is disabled` }
      : { pin: devFallback, problem: null }; // convenient defaults for local development only
  }
  const pin = pinFromEnv(raw);
  if (IS_PROD && pin.length < MIN_PIN_LENGTH) {
    return { pin: null, problem: `${label} must be at least ${MIN_PIN_LENGTH} characters, so that login is disabled` };
  }
  return { pin, problem: null };
}
const ADMIN = resolvePin(ADMIN_ENV, '9999', 'ADMIN_PIN');
const SCANNER = resolvePin(SCANNER_ENV, '1234', 'SCANNER_PIN');

// ---------- callback URL ----------
const CALLBACK_SECRET_FROM_ENV = !!process.env.MPESA_CALLBACK_SECRET;
const CALLBACK_SECRET =
  process.env.MPESA_CALLBACK_SECRET || crypto.createHmac('sha256', secret).update('pay-callback').digest('hex').slice(0, 24);
// Note: no "mpesa"/"safaricom" in the path, Daraja rejects callback URLs containing those words.
const CALLBACK_URL = `${BASE_URL}/api/pay-callback/${encodeURIComponent(CALLBACK_SECRET)}`;

function callbackProblem() {
  if (/mpesa|safaricom/i.test(CALLBACK_URL)) {
    return 'The callback URL contains "mpesa" or "safaricom" (probably in your domain). Daraja rejects such URLs. Use a different domain.';
  }
  if (IS_PROD && !/^https:\/\//i.test(CALLBACK_URL)) return 'BASE_URL must be a public https:// address.';
  return null;
}
const CALLBACK_PROBLEM = callbackProblem();

const CRON_SECRET = process.env.CRON_SECRET || '';
const CRON_BUDGET_MS = Number(process.env.CRON_BUDGET_MS) || 8000;

const CONFIG_PROBLEMS = [
  ADMIN.problem,
  SCANNER.problem,
  CALLBACK_PROBLEM,
  IS_PROD && !CALLBACK_SECRET_FROM_ENV ? 'MPESA_CALLBACK_SECRET is not set; the callback secret is derived from the app secret and breaks if that changes' : null,
  IS_PROD && !CRON_SECRET ? 'CRON_SECRET is not set; the payment reconciliation job is disabled' : null,
].filter(Boolean);
CONFIG_PROBLEMS.forEach((p) => console.error('[config]', p));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Open /api/health on the live site to see whether the server and database are connected.
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await ready();
    res.json({
      ok: true, database: 'connected', mpesa: mpesa.MOCK ? 'test mode' : 'live', email: mailer.smtpConfigured ? 'configured' : 'not configured',
      adminPin: ADMIN.pin ? (ADMIN_ENV ? 'custom PIN from settings' : 'dev default in use') : 'DISABLED',
      scannerPin: SCANNER.pin ? (SCANNER_ENV ? 'custom PIN from settings' : 'dev default in use') : 'DISABLED',
      callbackSecret: CALLBACK_SECRET_FROM_ENV ? 'fixed from settings' : 'derived from app secret',
      reconciliation: CRON_SECRET ? 'enabled' : 'disabled (CRON_SECRET not set)',
      problems: CONFIG_PROBLEMS,
      codeVersion: (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7),
    });
  } catch (e) {
    res.status(500).json({ ok: false, database: 'FAILED', databaseUrlSet: !!DB_URL, reason: e.code || e.name || 'unknown' });
  }
});
app.use(h(async (req, res, next) => { await ready(); next(); }));

// ---------- helpers ----------
async function allow(key, max, windowMs) {
  const now = Date.now();
  const { rows } = await q('SELECT COUNT(*) AS n FROM rate_hits WHERE key=$1 AND ts>$2', [key, now - windowMs]);
  if (num(rows[0].n) >= max) return false;
  await q('INSERT INTO rate_hits (key, ts) VALUES ($1,$2)', [key, now]);
  if (Math.random() < 0.02) q('DELETE FROM rate_hits WHERE ts<$1', [now - 86400000]).catch(() => {});
  return true;
}
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const randId = (n) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(n), (b) => A[b % 32]).join('');
};
function normPhone(p) {
  p = String(p || '').replace(/[\s\-+()]/g, '');
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;
const httpErr = (code, message) => Object.assign(new Error(message), { http: code });
// holders is JSON text in some schemas and jsonb (already parsed) in others
const parseHolders = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// staff tokens: role.expiry.signature
function makeToken(role) {
  const body = `${role}.${Date.now() + 12 * 3600 * 1000}`;
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('hex').slice(0, 32)}`;
}
function readToken(tok) {
  const [role, exp, sig] = String(tok || '').split('.');
  if (!role || !exp || !sig) return null;
  const good = crypto.createHmac('sha256', secret).update(`${role}.${exp}`).digest('hex').slice(0, 32);
  return safeEq(sig, good) && Number(exp) > Date.now() ? role : null;
}
const requireRole = (...roles) => (req, res, next) => {
  const role = readToken(req.get('x-staff-token'));
  if (!role || !roles.includes(role)) return res.status(401).json({ error: 'Not authorised' });
  req.role = role;
  next();
};

// ---------- availability ----------
async function availability() {
  const { rows } = await q(
    `SELECT e.code, e.name, e.tagline, e.kind, e.capacity, e.price, e.tickets_per_slot,
            COALESCE(SUM(CASE WHEN o.status='paid' THEN o.slots END),0) AS sold,
            COALESCE(SUM(CASE WHEN o.status='pending' AND o.expires_at > $1 THEN o.slots END),0) AS held
     FROM events e LEFT JOIN orders o ON o.event_id = e.id
     WHERE e.active = 1 GROUP BY e.id ORDER BY e.sort`,
    [Date.now()]
  );
  return rows.map((r) => {
    const capacity = r.capacity == null ? null : Number(r.capacity);
    const sold = num(r.sold), held = num(r.held);
    return {
      ...r, capacity, sold, held, price: Number(r.price),
      unlimited: capacity == null,
      remaining: capacity == null ? null : Math.max(0, capacity - sold - held),
    };
  });
}

// The page polls this every few seconds; the CDN may serve a copy up to 2s old.
app.get('/api/availability', h(async (req, res) => {
  res.set('Cache-Control', 'public, s-maxage=2, stale-while-revalidate=5');
  res.json(await availability());
}));

app.get('/api/config', h(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ event: EVENT, support: process.env.SUPPORT_CONTACT || '', mock: mpesa.MOCK, events: await availability() });
}));

// ---------- creating an order ----------
app.post('/api/orders', h(async (req, res) => {
  if (!(await allow(`order:${req.ip}`, 12, 10 * 60 * 1000))) throw httpErr(429, 'Too many attempts. Try again in a few minutes.');
  const b = req.body || {};
  const ev = (await q('SELECT * FROM events WHERE code=$1 AND active=1', [clean(b.event, 20)])).rows[0];
  if (!ev) throw httpErr(400, 'Unknown category.');

  const name = clean(b.name, 60);
  const email = clean(b.email, 120).toLowerCase();
  const phone = normPhone(b.phone);
  if (name.length < 2) throw httpErr(400, 'Enter your full name.');
  if (!validEmail(email)) throw httpErr(400, 'Enter a valid email address.');
  if (!phone) throw httpErr(400, 'Enter a valid Safaricom number, e.g. 0712345678.');

  let slots = 1, holders = [name], team_name = null;
  if (ev.kind === 'team') {
    team_name = clean(b.team_name, 40);
    if (team_name.length < 2) throw httpErr(400, 'Enter your team name.');
    const others = (Array.isArray(b.players) ? b.players : []).map((p) => clean(p, 60));
    if (others.length !== ev.tickets_per_slot - 1 || others.some((p) => p.length < 2))
      throw httpErr(400, `Enter the names of all ${ev.tickets_per_slot} players.`);
    holders = [name, ...others];
  } else if (ev.kind === 'spectator') {
    slots = Math.floor(Number(b.quantity) || 1);
    if (slots < 1 || slots > 10) throw httpErr(400, 'You can buy 1 to 10 tickets at a time.');
    holders = Array.from({ length: slots }, (_, i) => (i === 0 ? name : `${name} (guest ${i + 1})`));
  }
  // The price always comes from the database, never from the request.
  const amount = Number(ev.price) * slots;
  const game_id = clean(b.game_id, 40) || null;

  // Row lock on the category: two buyers can never take the last spot at the same time.
  const order = await tx(async (c) => {
    const now = Date.now();
    const lock = (await c.query('SELECT capacity FROM events WHERE id=$1 FOR UPDATE', [ev.id])).rows[0];
    const capacity = lock.capacity == null ? null : Number(lock.capacity);
    if (ev.kind !== 'spectator') {
      const dup = await c.query(
        `SELECT 1 FROM orders WHERE event_id=$1 AND (phone=$2 OR lower(email)=$3) AND (status='paid' OR (status='pending' AND expires_at>$4)) LIMIT 1`,
        [ev.id, phone, email, now]);
      if (dup.rowCount) throw httpErr(409, 'This phone number or email is already registered for this category.');
      if (ev.kind === 'team') {
        const t = await c.query(
          `SELECT 1 FROM orders WHERE event_id=$1 AND lower(team_name)=$2 AND (status='paid' OR (status='pending' AND expires_at>$3)) LIMIT 1`,
          [ev.id, team_name.toLowerCase(), now]);
        if (t.rowCount) throw httpErr(409, 'That team name is already taken.');
      }
    }
    if (capacity != null) {
      const used = num((await c.query(
        `SELECT COALESCE(SUM(slots),0) AS n FROM orders WHERE event_id=$1 AND (status='paid' OR (status='pending' AND expires_at>$2))`,
        [ev.id, now])).rows[0].n);
      if (used + slots > capacity) {
        const left = Math.max(0, capacity - used);
        throw httpErr(409, left === 0 ? 'Sorry, this category is sold out.' : `Only ${left} left in this category.`);
      }
    }
    const publicId = randId(8), token = crypto.randomBytes(16).toString('hex');
    const ins = await c.query(
      `INSERT INTO orders (public_id, token, event_id, name, email, phone, team_name, game_id, slots, ticket_count, amount, holders, status, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14) RETURNING id`,
      [publicId, token, ev.id, name, email, phone, team_name, game_id, slots, holders.length, amount, JSON.stringify(holders), now, now + HOLD_MS]);
    return { id: ins.rows[0].id, publicId, token };
  });

  try {
    await sendStk({ id: order.id, public_id: order.publicId, phone, amount }, ev);
  } catch (err) {
    await q("UPDATE orders SET status='failed', result_desc=$1 WHERE id=$2", [String(err.message).slice(0, 200), order.id]);
    console.error('[stk]', err.message);
    throw httpErr(502, 'Could not send the M-Pesa prompt. Check the number and try again.');
  }
  res.json({ orderId: order.publicId, token: order.token, amount, status: 'pending' });
}));

// ---------- M-Pesa: STK push ----------
// Sends the prompt for an order and records the request. Every request id is kept, so approving an
// earlier prompt after a resend still matches the right order.
async function sendStk(order, ev) {
  if (CALLBACK_PROBLEM && !mpesa.MOCK) throw new Error(CALLBACK_PROBLEM);
  const r = await mpesa.stkPush({ phone: order.phone, amount: order.amount, reference: `${ev.prefix}${order.public_id}`, description: 'Tickets', callbackUrl: CALLBACK_URL });
  await q('UPDATE orders SET merchant_request_id=$1, checkout_request_id=$2 WHERE id=$3', [r.MerchantRequestID, r.CheckoutRequestID, order.id]);
  await q('INSERT INTO stk_requests (checkout_request_id, order_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.CheckoutRequestID, order.id, Date.now()]);
  return r;
}

// POST /api/mpesa/stk  { orderId, token }  ->  sends the M-Pesa prompt again for an unpaid order.
// It only works for an existing pending order (the token proves ownership) and never takes a phone
// number or amount from the request, so it cannot be used to prompt other people's phones.
app.post('/api/mpesa/stk', h(async (req, res) => {
  const o = await loadOrder(req, String(req.body?.orderId || ''), String(req.body?.token || ''));
  if (o.status !== 'pending' || Number(o.expires_at) < Date.now()) throw httpErr(409, 'This order is no longer waiting for payment. Please register again.');
  if (!(await allow(`stk:${o.id}`, 3, 10 * 60 * 1000))) throw httpErr(429, 'Too many prompts. Wait a few minutes and check your M-Pesa messages.');
  const ev = (await q('SELECT * FROM events WHERE id=$1', [o.event_id])).rows[0];
  try { await sendStk(o, ev); }
  catch (err) { console.error('[stk resend]', err.message); throw httpErr(502, 'Could not send the M-Pesa prompt. Try again in a moment.'); }
  res.json({ ok: true });
}));

// ---------- payment results ----------
// Marks an order paid and issues its tickets, exactly once.
// If the hold had already lapsed (or the order had failed) and the category filled up in the
// meantime, the order goes to 'review' instead so staff can refund. `force` lets an admin override that.
async function finalize(orderId, receipt, { force = false } = {}) {
  return tx(async (c) => {
    const pre = (await c.query('SELECT event_id FROM orders WHERE id=$1', [orderId])).rows[0];
    if (!pre) return { created: false };
    // Lock order: category first, then the order (same order as order creation, so no deadlocks).
    const ev = (await c.query('SELECT capacity FROM events WHERE id=$1 FOR UPDATE', [pre.event_id])).rows[0];
    const o = (await c.query('SELECT o.*, e.prefix FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1 FOR UPDATE OF o', [orderId])).rows[0];
    if (!o) return { created: false };
    if (o.status === 'paid') {
      if (receipt && !o.mpesa_receipt) await c.query('UPDATE orders SET mpesa_receipt=$1 WHERE id=$2', [receipt, orderId]);
      return { created: false };
    }

    const now = Date.now();
    const holdValid = o.status === 'pending' && Number(o.expires_at) >= now;
    const capacity = ev.capacity == null ? null : Number(ev.capacity);
    if (!force && !holdValid && capacity != null) {
      const used = num((await c.query(
        `SELECT COALESCE(SUM(slots),0) AS n FROM orders WHERE event_id=$1 AND id<>$2 AND (status='paid' OR (status='pending' AND expires_at>$3))`,
        [o.event_id, o.id, now])).rows[0].n);
      if (used + Number(o.slots) > capacity) {
        await c.query(
          "UPDATE orders SET status='review', mpesa_receipt=COALESCE($1, mpesa_receipt), result_desc=$2 WHERE id=$3",
          [receipt || null, 'Paid after the hold expired and the category is now full. Refund needed.', o.id]);
        return { created: false, review: true };
      }
    }

    await c.query("UPDATE orders SET status='paid', paid_at=$1, mpesa_receipt=COALESCE($2, mpesa_receipt), result_desc='Paid' WHERE id=$3", [now, receipt || null, orderId]);
    for (const holder of parseHolders(o.holders)) {
      let ok = false;
      for (let attempt = 0; attempt < 10 && !ok; attempt++) {
        // UNIQUE(serial) + ON CONFLICT: a colliding serial is simply rolled again, so duplicates cannot exist
        const r = await c.query('INSERT INTO tickets (serial, order_id, event_id, holder_name, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (serial) DO NOTHING RETURNING id',
          [T.newSerial(o.prefix), o.id, o.event_id, holder, Date.now()]);
        ok = r.rowCount === 1;
      }
      if (!ok) throw new Error('Could not allocate a unique serial');
    }
    return { created: true };
  });
}

async function deliverEmail(orderId) {
  const order = (await q('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  const ev = (await q('SELECT * FROM events WHERE id=$1', [order.event_id])).rows[0];
  const tickets = (await q('SELECT * FROM tickets WHERE order_id=$1 ORDER BY id', [orderId])).rows;
  try {
    if (!mailer.smtpConfigured) throw new Error('Email is not configured (SMTP_HOST missing)');
    const pdf = await T.buildPdf(tickets, ev);
    await mailer.sendTickets({ order, eventRow: ev, tickets, pdf });
    await q('UPDATE orders SET emailed_at=$1, email_error=NULL WHERE id=$2', [Date.now(), orderId]);
    return true;
  } catch (err) {
    console.error('[mail]', err.message);
    await q('UPDATE orders SET email_error=$1 WHERE id=$2', [String(err.message).slice(0, 200), orderId]);
    return false;
  }
}

// Serverless functions freeze once they respond, so email is sent *before* responding, and is retried
// whenever the customer's page or the admin looks at the order. The claim keeps it to one send per minute.
async function maybeEmail(orderId) {
  const now = Date.now();
  const c = await q(
    'UPDATE orders SET email_attempt_at=$1 WHERE id=$2 AND emailed_at IS NULL AND (email_attempt_at IS NULL OR email_attempt_at<$3) RETURNING id',
    [now, orderId, now - 60000]);
  return c.rowCount ? deliverEmail(orderId) : false;
}

async function handleStkResult(checkoutId, code, desc, meta = {}) {
  const o = (await q('SELECT * FROM orders WHERE checkout_request_id=$1 OR id=(SELECT order_id FROM stk_requests WHERE checkout_request_id=$1)', [checkoutId])).rows[0];
  if (!o) return;
  if (code === 0) {
    if (meta.Amount != null && Number(meta.Amount) < Number(o.amount)) {
      // never downgrade an order that is already paid
      await q("UPDATE orders SET status='review', result_desc=$1 WHERE id=$2 AND status<>'paid'", [`Underpaid: got ${meta.Amount}, expected ${o.amount}`, o.id]);
      return;
    }
    const r = await finalize(o.id, meta.MpesaReceiptNumber);
    if (r.created) await maybeEmail(o.id);
  } else if (o.status === 'pending' && checkoutId === o.checkout_request_id) {
    // only the latest prompt can fail the order; cancelling an older, replaced prompt must not
    await q('UPDATE orders SET status=$1, result_desc=$2 WHERE id=$3', [code === 1032 ? 'cancelled' : 'failed', String(desc || '').slice(0, 200), o.id]);
  }
}

// POST /api/pay-callback/<secret>  (alias: /api/mpesa/callback/<secret>)
// Safaricom posts the payment result here. The secret in the URL stops strangers from faking payments.
app.post(['/api/pay-callback/:secret', '/api/mpesa/callback/:secret'], h(async (req, res) => {
  if (!safeEq(req.params.secret, CALLBACK_SECRET)) {
    console.warn('[callback] rejected: wrong secret in URL (ip %s). If real payments stay pending, check MPESA_CALLBACK_SECRET.', req.ip);
  } else {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) {
      console.warn('[callback] accepted request had no stkCallback body');
    } else {
      // Keep the raw payload first, so a payment can be recovered by hand even if processing fails below.
      try {
        await q('INSERT INTO mpesa_callbacks (checkout_request_id, payload, received_at) VALUES ($1,$2,$3)', [cb.CheckoutRequestID, JSON.stringify(req.body), Date.now()]);
      } catch (e) { console.error('[callback] could not store payload', e.message); }
      try {
        const meta = {};
        for (const it of cb.CallbackMetadata?.Item || []) meta[it.Name] = it.Value;
        await handleStkResult(cb.CheckoutRequestID, Number(cb.ResultCode), cb.ResultDesc, meta);
      } catch (e) {
        console.error('[callback] processing failed for', cb.CheckoutRequestID, e);
      }
    }
  }
  // Always acknowledge quickly so Safaricom is satisfied.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

// ---------- reconciliation job (covers lost callbacks and customers who closed the page) ----------
// Called on a schedule (see vercel.json). Asks Safaricom about recent pending orders and settles them.
// Auth: "Authorization: Bearer <CRON_SECRET>" (Vercel adds this automatically) or an x-cron-secret header.
app.get('/api/cron/reconcile', h(async (req, res) => {
  const auth = req.get('authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.get('x-cron-secret') || '');
  if (!CRON_SECRET || !safeEq(given, CRON_SECRET)) return res.status(401).json({ error: 'Not authorised' });
  if (mpesa.MOCK) return res.json({ ok: true, skipped: 'mock mode' });

  const started = Date.now();
  const pending = (await q(
    `SELECT id FROM orders
     WHERE status='pending' AND checkout_request_id IS NOT NULL
       AND created_at>$1 AND created_at<$2 AND (last_query_at IS NULL OR last_query_at<$3)
     ORDER BY created_at LIMIT 15`,
    [started - 30 * 60 * 1000, started - 30 * 1000, started - 45 * 1000])).rows;

  const stats = { checked: 0, paid: 0 };
  for (const p of pending) {
    if (Date.now() - started > CRON_BUDGET_MS) break;
    await q('UPDATE orders SET last_query_at=$1 WHERE id=$2', [Date.now(), p.id]);
    stats.checked++;
    // Check every prompt sent for this order (newest first): an older one may be the one that was approved.
    const ids = (await q('SELECT checkout_request_id FROM stk_requests WHERE order_id=$1 ORDER BY created_at DESC', [p.id])).rows;
    for (const { checkout_request_id: cid } of ids) {
      if (Date.now() - started > CRON_BUDGET_MS) break;
      try {
        const r = await mpesa.stkQuery(cid);
        if (!r.done) continue;
        await handleStkResult(cid, r.resultCode, r.resultDesc, {});
        const st = (await q('SELECT status FROM orders WHERE id=$1', [p.id])).rows[0]?.status;
        if (st === 'paid') { stats.paid++; break; }
      } catch (e) { console.error('[reconcile]', cid, e.message); }
    }
  }
  res.json({ ok: true, ...stats });
}));

// ---------- customer order view ----------
async function loadOrder(req, pid = req.params?.pid, token = req.query?.token) {
  const o = (await q('SELECT o.*, e.name AS event_name FROM orders o JOIN events e ON e.id=o.event_id WHERE o.public_id=$1', [pid])).rows[0];
  if (!o || !safeEq(o.token, token || '')) throw httpErr(404, 'Order not found');
  return o;
}

app.get('/api/orders/:pid', h(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let o = await loadOrder(req);
  if (o.status === 'pending' && o.checkout_request_id) {
    const age = Date.now() - Number(o.created_at);
    if (mpesa.MOCK) {
      // Test mode: the "customer" approves after 5s (a phone ending in 0 simulates cancelling).
      if (age > 5000) {
        const cancel = o.phone.endsWith('0');
        await handleStkResult(o.checkout_request_id, cancel ? 1032 : 0, cancel ? 'Request cancelled by user' : 'Mock payment OK', { Amount: o.amount, MpesaReceiptNumber: 'MOCK' + randId(7) });
        o = await loadOrder(req);
      }
    } else if (age > 20000 && Date.now() - Number(o.last_query_at || 0) > 10000) {
      // No callback yet: ask Safaricom directly.
      await q('UPDATE orders SET last_query_at=$1 WHERE id=$2', [Date.now(), o.id]);
      try {
        const r = await mpesa.stkQuery(o.checkout_request_id);
        if (r.done) { await handleStkResult(o.checkout_request_id, r.resultCode, r.resultDesc, {}); o = await loadOrder(req); }
      } catch (e) { /* still processing */ }
    }
  }
  if (o.status === 'paid' && !o.emailed_at) { await maybeEmail(o.id); o = await loadOrder(req); }

  const out = { orderId: o.public_id, status: o.status, event: o.event_name, amount: o.amount, email: o.email, message: o.result_desc, emailed: !!o.emailed_at, emailFailed: !!o.email_error };
  if (o.status === 'pending' && Number(o.expires_at) < Date.now()) out.status = 'expired';
  if (o.status === 'paid') {
    const rows = (await q('SELECT serial, holder_name FROM tickets WHERE order_id=$1 ORDER BY id', [o.id])).rows;
    out.receipt = o.mpesa_receipt;
    out.tickets = await Promise.all(rows.map(async (t) => ({ ...t, qr: await T.qrDataUrl(t.serial) })));
  }
  res.json(out);
}));

app.get('/api/orders/:pid/tickets.pdf', h(async (req, res) => {
  const o = await loadOrder(req);
  if (o.status !== 'paid') throw httpErr(409, 'Payment not confirmed yet.');
  const ev = (await q('SELECT * FROM events WHERE id=$1', [o.event_id])).rows[0];
  const tickets = (await q('SELECT * FROM tickets WHERE order_id=$1 ORDER BY id', [o.id])).rows;
  const pdf = await T.buildPdf(tickets, ev);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="tickets-${o.public_id}.pdf"` }).send(pdf);
}));

app.post('/api/orders/:pid/resend', h(async (req, res) => {
  const o = await loadOrder(req);
  if (o.status !== 'paid') throw httpErr(409, 'Payment not confirmed yet.');
  if (!(await allow(`resend:${o.id}`, 3, 60 * 60 * 1000))) throw httpErr(429, 'Too many resends. Download the PDF instead.');
  res.json({ ok: await deliverEmail(o.id) });
}));

// ---------- staff ----------
app.post('/api/staff/login', h(async (req, res) => {
  if (!(await allow(`login:${req.ip}`, 10, 10 * 60 * 1000))) throw httpErr(429, 'Too many attempts. Wait a few minutes.');
  if (!ADMIN.pin && !SCANNER.pin) {
    throw httpErr(503, `Staff login is disabled. Set ADMIN_PIN and SCANNER_PIN (at least ${MIN_PIN_LENGTH} characters) in the server settings, then redeploy.`);
  }
  const pin = String(req.body?.pin || '').trim();
  const role = ADMIN.pin && safeEq(pin, ADMIN.pin) ? 'admin' : SCANNER.pin && safeEq(pin, SCANNER.pin) ? 'scanner' : null;
  if (!role) throw httpErr(401, 'Wrong PIN. If you just changed the PIN settings, redeploy so they take effect.');
  res.json({ token: makeToken(role), role });
}));

async function scanTicket(serial, who) {
  const log = (result, note) => q('INSERT INTO scans (serial, result, scanned_at, scanned_by, note) VALUES ($1,$2,$3,$4,$5)', [serial, result, Date.now(), who, note || null]);
  const sel = 'SELECT t.*, e.name AS event_name, o.name AS buyer, o.team_name FROM tickets t JOIN events e ON e.id=t.event_id JOIN orders o ON o.id=t.order_id WHERE t.serial=$1';
  const t = (await q(sel, [serial])).rows[0];
  if (!t) { await log('INVALID', 'not found'); return { result: 'INVALID', message: 'Ticket not found' }; }
  const info = { serial: t.serial, holder: t.holder_name, category: t.event_name, team: t.team_name, buyer: t.buyer };
  if (t.status === 'void') { await log('VOID'); return { result: 'VOID', message: 'Ticket was cancelled', ...info }; }
  // Atomic check-in: of any number of simultaneous scans, exactly one flips valid -> used
  const r = await q("UPDATE tickets SET status='used', used_at=$1, used_by=$2 WHERE serial=$3 AND status='valid' RETURNING id", [Date.now(), who, serial]);
  if (r.rowCount === 1) { await log('VALID'); return { result: 'VALID', message: 'Entry allowed', ...info }; }
  const used = (await q('SELECT used_at FROM tickets WHERE serial=$1', [serial])).rows[0];
  await log('ALREADY_USED');
  return { result: 'ALREADY_USED', message: 'Already scanned', usedAt: used?.used_at, ...info };
}

app.post('/api/scan', requireRole('scanner', 'admin'), h(async (req, res) => {
  const p = T.parseCode(req.body?.code);
  if (!p.valid) {
    await q('INSERT INTO scans (serial, result, scanned_at, scanned_by, note) VALUES ($1,$2,$3,$4,$5)', [p.serial.slice(0, 40), 'INVALID', Date.now(), req.role, p.signed ? 'bad signature' : 'bad format']);
    return res.json({ result: 'INVALID', message: p.signed ? 'Forged or damaged code' : 'Not a valid serial' });
  }
  res.json(await scanTicket(p.serial, req.role));
}));

app.get('/api/scan/stats', requireRole('scanner', 'admin'), h(async (req, res) => {
  const rows = (await q(`SELECT e.name, COUNT(t.id) AS issued, COUNT(t.id) FILTER (WHERE t.status='used') AS in_venue FROM events e LEFT JOIN tickets t ON t.event_id=e.id GROUP BY e.id ORDER BY e.sort`))
    .rows.map((r) => ({ ...r, issued: num(r.issued), in_venue: num(r.in_venue) }));
  res.json({ total: { issued: rows.reduce((a, r) => a + r.issued, 0), in_venue: rows.reduce((a, r) => a + r.in_venue, 0) }, rows });
}));

// ---------- admin ----------
app.get('/api/admin/summary', requireRole('admin'), h(async (req, res) => {
  const rows = (await q(
    `SELECT e.code, e.name, e.kind, e.capacity, e.price,
       COALESCE((SELECT SUM(slots) FROM orders WHERE event_id=e.id AND status='paid'),0) AS sold,
       COALESCE((SELECT SUM(slots) FROM orders WHERE event_id=e.id AND status='pending' AND expires_at>$1),0) AS held,
       COALESCE((SELECT SUM(amount) FROM orders WHERE event_id=e.id AND status='paid'),0) AS revenue,
       (SELECT COUNT(*) FROM tickets WHERE event_id=e.id) AS tickets,
       (SELECT COUNT(*) FROM tickets WHERE event_id=e.id AND status='used') AS checked_in
     FROM events e ORDER BY e.sort`, [Date.now()])).rows
    .map((r) => ({ ...r, sold: num(r.sold), held: num(r.held), revenue: num(r.revenue), tickets: num(r.tickets), checked_in: num(r.checked_in) }));
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  res.json({ rows, totals: { revenue: sum('revenue'), tickets: sum('tickets'), checked_in: sum('checked_in') } });
}));

app.get('/api/admin/orders', requireRole('admin'), h(async (req, res) => {
  const ev = clean(req.query.event, 20), st = clean(req.query.status, 20), s = clean(req.query.q, 60);
  const { rows } = await q(
    `SELECT o.id, o.public_id, o.name, o.email, o.phone, o.team_name, o.game_id, o.slots, o.ticket_count, o.amount, o.status, o.mpesa_receipt, o.result_desc,
            o.created_at, o.paid_at, o.emailed_at, o.email_error, e.name AS event_name, e.code AS event_code
     FROM orders o JOIN events e ON e.id=o.event_id
     WHERE ($1='' OR e.code=$1) AND ($2='' OR o.status=$2)
       AND ($3='' OR o.name ILIKE $4 OR o.email ILIKE $4 OR o.phone ILIKE $4 OR o.public_id ILIKE $4 OR o.mpesa_receipt ILIKE $4 OR o.team_name ILIKE $4)
     ORDER BY o.id DESC LIMIT 500`, [ev, st, s, `%${s}%`]);
  res.json(rows);
}));

app.get('/api/admin/tickets', requireRole('admin'), h(async (req, res) => {
  const ev = clean(req.query.event, 20), st = clean(req.query.status, 20), s = clean(req.query.q, 60);
  const { rows } = await q(
    `SELECT t.serial, t.holder_name, t.status, t.used_at, t.used_by, t.created_at, e.name AS event_name, o.public_id AS order_ref, o.team_name, o.phone
     FROM tickets t JOIN events e ON e.id=t.event_id JOIN orders o ON o.id=t.order_id
     WHERE ($1='' OR e.code=$1) AND ($2='' OR t.status=$2)
       AND ($3='' OR t.serial ILIKE $4 OR t.holder_name ILIKE $4 OR o.phone ILIKE $4 OR o.team_name ILIKE $4)
     ORDER BY t.id DESC LIMIT 500`, [ev, st, s, `%${s}%`]);
  res.json(rows);
}));

// For the rare case a payment went through but the callback was lost, or a 'review' order the admin
// has decided to honour (e.g. paid after the category filled up). Admin confirmation overrides the capacity check.
app.post('/api/admin/orders/:id/confirm', requireRole('admin'), h(async (req, res) => {
  const receipt = clean(req.body?.receipt, 20).toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(receipt)) throw httpErr(400, 'Enter the M-Pesa receipt code (e.g. SHK1ABC2DE).');
  const o = (await q('SELECT id FROM orders WHERE id=$1', [req.params.id])).rows[0];
  if (!o) throw httpErr(404, 'No such order');
  let r;
  try { r = await finalize(o.id, receipt, { force: true }); }
  catch (e) { throw httpErr(409, e.code === '23505' ? 'That receipt is already used on another order.' : 'Could not confirm.'); }
  if (r.created) await maybeEmail(o.id);
  res.json({ ok: true, created: r.created });
}));

app.post('/api/admin/orders/:id/resend', requireRole('admin'), h(async (req, res) => {
  const o = (await q("SELECT id FROM orders WHERE id=$1 AND status='paid'", [req.params.id])).rows[0];
  if (!o) throw httpErr(404, 'Order not paid');
  res.json({ ok: await deliverEmail(o.id) });
}));

app.patch('/api/admin/events/:code', requireRole('admin'), h(async (req, res) => {
  const ev = (await q('SELECT * FROM events WHERE code=$1', [req.params.code])).rows[0];
  if (!ev) throw httpErr(404, 'No such category');
  const price = req.body.price !== undefined ? Math.floor(Number(req.body.price)) : Number(ev.price);
  let capacity = ev.capacity == null ? null : Number(ev.capacity);
  if (req.body.capacity !== undefined) capacity = req.body.capacity === null || req.body.capacity === '' ? null : Math.floor(Number(req.body.capacity));
  if (!(price >= 1) || (capacity !== null && !(capacity >= 0))) throw httpErr(400, 'Invalid values');
  await q('UPDATE events SET price=$1, capacity=$2 WHERE id=$3', [price, capacity, ev.id]);
  res.json({ ok: true });
}));

app.get('/api/admin/export.csv', requireRole('admin'), h(async (req, res) => {
  const fmt = (col) => `to_char(to_timestamp(${col}/1000.0) AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD HH24:MI:SS')`;
  const rows = (await q(
    `SELECT t.serial, e.name AS category, t.holder_name, o.team_name, o.name AS buyer, o.phone, o.email, o.mpesa_receipt, o.amount, t.status,
            ${fmt('t.used_at')} AS checked_in_at, ${fmt('o.paid_at')} AS paid_at
     FROM tickets t JOIN events e ON e.id=t.event_id JOIN orders o ON o.id=t.order_id ORDER BY t.id`)).rows;
  const cols = rows[0] ? Object.keys(rows[0]) : ['serial'];
  const cell = (v) => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
  res.type('text/csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.http) return res.status(err.http).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;

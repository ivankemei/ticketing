require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, secret } = require('./src/db');
const mpesa = require('./src/mpesa');
const T = require('./src/tickets');
const mailer = require('./src/mailer');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const HOLD_MS = 4 * 60 * 1000; // a pending STK push holds its slots for 4 minutes
const SCANNER_PIN = process.env.SCANNER_PIN || '1234';
const ADMIN_PIN = process.env.ADMIN_PIN || '9999';
const CALLBACK_SECRET =
  process.env.MPESA_CALLBACK_SECRET || crypto.createHmac('sha256', secret).update('mpesa-callback').digest('hex').slice(0, 24);
const CALLBACK_URL = `${BASE_URL}/api/mpesa/callback/${CALLBACK_SECRET}`;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// ---------- helpers ----------
const rateBuckets = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  rateBuckets.set(key, hits);
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

// ---------- availability (live counts) ----------
function availability() {
  return db
    .prepare(
      `SELECT e.code, e.name, e.tagline, e.kind, e.capacity, e.price, e.tickets_per_slot,
              COALESCE(SUM(CASE WHEN o.status='paid' THEN o.slots END),0) AS sold,
              COALESCE(SUM(CASE WHEN o.status='pending' AND o.expires_at > ? THEN o.slots END),0) AS held
       FROM events e LEFT JOIN orders o ON o.event_id = e.id
       WHERE e.active = 1 GROUP BY e.id ORDER BY e.sort`
    )
    .all(Date.now())
    .map((r) => ({
      ...r,
      unlimited: r.capacity == null,
      remaining: r.capacity == null ? null : Math.max(0, r.capacity - r.sold - r.held),
    }));
}

// Server-sent events: every open browser gets the new numbers the moment they change.
const clients = new Set();
let lastBroadcast = '';
function broadcast(force) {
  const data = JSON.stringify(availability());
  if (!force && data === lastBroadcast) return;
  lastBroadcast = data;
  for (const res of clients) res.write(`data: ${data}\n\n`);
}
setInterval(() => broadcast(false), 5000); // also catches expiring holds
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(availability())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/config', (req, res) =>
  res.json({ event: T.EVENT, support: process.env.SUPPORT_CONTACT || '', mock: mpesa.MOCK, events: availability() })
);

// ---------- orders ----------
const createOrderTx = db.transaction((ev, data) => {
  const now = Date.now();
  if (ev.kind !== 'spectator') {
    const dup = db
      .prepare(
        `SELECT 1 FROM orders WHERE event_id=? AND (phone=? OR lower(email)=?) AND (status='paid' OR (status='pending' AND expires_at>?)) LIMIT 1`
      )
      .get(ev.id, data.phone, data.email.toLowerCase(), now);
    if (dup) throw Object.assign(new Error('This phone number or email is already registered for this category.'), { code: 409 });
    if (ev.kind === 'team') {
      const t = db
        .prepare(`SELECT 1 FROM orders WHERE event_id=? AND lower(team_name)=? AND (status='paid' OR (status='pending' AND expires_at>?)) LIMIT 1`)
        .get(ev.id, data.team_name.toLowerCase(), now);
      if (t) throw Object.assign(new Error('That team name is already taken.'), { code: 409 });
    }
  }
  if (ev.capacity != null) {
    const used = db
      .prepare(
        `SELECT COALESCE(SUM(slots),0) n FROM orders WHERE event_id=? AND (status='paid' OR (status='pending' AND expires_at>?))`
      )
      .get(ev.id, now).n;
    if (used + data.slots > ev.capacity) {
      const left = Math.max(0, ev.capacity - used);
      throw Object.assign(new Error(left === 0 ? 'Sorry, this category is sold out.' : `Only ${left} left in this category.`), { code: 409 });
    }
  }
  const publicId = randId(8);
  const token = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare(
      `INSERT INTO orders (public_id, token, event_id, name, email, phone, team_name, game_id, slots, ticket_count, amount, holders, status, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`
    )
    .run(publicId, token, ev.id, data.name, data.email, data.phone, data.team_name || null, data.game_id || null,
         data.slots, data.holders.length, data.amount, JSON.stringify(data.holders), now, now + HOLD_MS);
  return { id: info.lastInsertRowid, publicId, token };
});

app.post('/api/orders', async (req, res) => {
  if (!allow(`order:${req.ip}`, 12, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  try {
    const b = req.body || {};
    const ev = db.prepare('SELECT * FROM events WHERE code=? AND active=1').get(clean(b.event, 20));
    if (!ev) return res.status(400).json({ error: 'Unknown category.' });

    const name = clean(b.name, 60);
    const email = clean(b.email, 120).toLowerCase();
    const phone = normPhone(b.phone);
    if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!phone) return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712345678.' });

    let slots = 1, holders = [name], team_name = null;
    if (ev.kind === 'team') {
      team_name = clean(b.team_name, 40);
      if (team_name.length < 2) return res.status(400).json({ error: 'Enter your team name.' });
      const others = (Array.isArray(b.players) ? b.players : []).map((p) => clean(p, 60));
      if (others.length !== ev.tickets_per_slot - 1 || others.some((p) => p.length < 2))
        return res.status(400).json({ error: `Enter the names of all ${ev.tickets_per_slot} players.` });
      holders = [name, ...others];
    } else if (ev.kind === 'spectator') {
      slots = Math.floor(Number(b.quantity) || 1);
      if (slots < 1 || slots > 10) return res.status(400).json({ error: 'You can buy 1 to 10 tickets at a time.' });
      holders = Array.from({ length: slots }, (_, i) => (i === 0 ? name : `${name} (guest ${i + 1})`));
    }
    const amount = ev.price * slots;
    if (amount < 1) return res.status(400).json({ error: 'Invalid amount.' });

    const o = createOrderTx(ev, { name, email, phone, team_name, game_id: clean(b.game_id, 40), slots, holders, amount });
    broadcast(false);

    try {
      const r = await mpesa.stkPush({
        phone, amount,
        reference: `${ev.prefix}${o.publicId}`,
        description: 'Tickets',
        callbackUrl: CALLBACK_URL,
      });
      db.prepare('UPDATE orders SET merchant_request_id=?, checkout_request_id=? WHERE id=?').run(r.MerchantRequestID, r.CheckoutRequestID, o.id);
      if (mpesa.MOCK) {
        // Simulated customer: approves after 5s, unless the number ends in 0 (simulates "cancelled").
        setTimeout(() => handleStkResult(r.CheckoutRequestID, phone.endsWith('0') ? 1032 : 0, phone.endsWith('0') ? 'Request cancelled by user' : 'Mock payment OK',
          { Amount: amount, MpesaReceiptNumber: 'MOCK' + randId(7) }), 5000);
      }
    } catch (err) {
      db.prepare("UPDATE orders SET status='failed', result_desc=? WHERE id=?").run(String(err.message).slice(0, 200), o.id);
      broadcast(false);
      console.error('[stk]', err.message);
      return res.status(502).json({ error: 'Could not send the M-Pesa prompt. Check the number and try again.' });
    }
    res.json({ orderId: o.publicId, token: o.token, amount, status: 'pending' });
  } catch (err) {
    if (err.code === 409) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- payment result handling ----------
const finalizeTx = db.transaction((orderId, receipt) => {
  const o = db.prepare('SELECT o.*, e.prefix FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=?').get(orderId);
  if (!o) return { created: false };
  if (o.status === 'paid') {
    if (receipt && !o.mpesa_receipt) db.prepare('UPDATE orders SET mpesa_receipt=? WHERE id=? AND mpesa_receipt IS NULL').run(receipt, orderId);
    return { created: false };
  }
  db.prepare("UPDATE orders SET status='paid', paid_at=?, mpesa_receipt=COALESCE(?, mpesa_receipt), result_desc='Paid' WHERE id=?").run(Date.now(), receipt || null, orderId);
  const insert = db.prepare('INSERT INTO tickets (serial, order_id, event_id, holder_name, created_at) VALUES (?,?,?,?,?)');
  for (const holder of JSON.parse(o.holders)) {
    for (let attempt = 0; ; attempt++) {
      try { insert.run(T.newSerial(o.prefix), o.id, o.event_id, holder, Date.now()); break; }
      catch (e) { if (!String(e.message).includes('UNIQUE') || attempt > 8) throw e; } // serial collision: roll a new one
    }
  }
  return { created: true };
});

async function deliverEmail(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(order.event_id);
  const tickets = db.prepare('SELECT * FROM tickets WHERE order_id=? ORDER BY id').all(orderId);
  try {
    const pdf = await T.buildPdf(tickets, ev);
    await mailer.sendTickets({ order, eventRow: ev, tickets, pdf });
    db.prepare('UPDATE orders SET emailed_at=?, email_error=NULL WHERE id=?').run(Date.now(), orderId);
    return true;
  } catch (err) {
    console.error('[mail]', err.message);
    db.prepare('UPDATE orders SET email_error=? WHERE id=?').run(String(err.message).slice(0, 200), orderId);
    return false;
  }
}

function handleStkResult(checkoutId, code, desc, meta = {}) {
  const o = db.prepare('SELECT * FROM orders WHERE checkout_request_id=?').get(checkoutId);
  if (!o) return;
  if (code === 0) {
    if (meta.Amount != null && Number(meta.Amount) < o.amount) {
      db.prepare("UPDATE orders SET status='review', result_desc=? WHERE id=?").run(`Underpaid: got ${meta.Amount}, expected ${o.amount}`, o.id);
      return broadcast(false);
    }
    const r = finalizeTx(o.id, meta.MpesaReceiptNumber);
    broadcast(false);
    if (r.created) deliverEmail(o.id);
  } else if (o.status === 'pending') {
    db.prepare('UPDATE orders SET status=?, result_desc=? WHERE id=?').run(code === 1032 ? 'cancelled' : 'failed', String(desc || '').slice(0, 200), o.id);
    broadcast(false);
  }
}

// Safaricom posts here. The secret in the URL stops strangers from faking payments.
app.post('/api/mpesa/callback/:secret', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  if (!safeEq(req.params.secret, CALLBACK_SECRET)) return;
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return;
    db.prepare('INSERT INTO mpesa_callbacks (checkout_request_id, payload, received_at) VALUES (?,?,?)').run(cb.CheckoutRequestID, JSON.stringify(req.body), Date.now());
    const meta = {};
    for (const it of cb.CallbackMetadata?.Item || []) meta[it.Name] = it.Value;
    handleStkResult(cb.CheckoutRequestID, Number(cb.ResultCode), cb.ResultDesc, meta);
  } catch (e) {
    console.error('[callback]', e);
  }
});

function loadOrder(req, res) {
  const o = db.prepare('SELECT o.*, e.name AS event_name, e.code AS event_code FROM orders o JOIN events e ON e.id=o.event_id WHERE o.public_id=?').get(req.params.pid);
  if (!o || !safeEq(o.token, req.query.token || '')) { res.status(404).json({ error: 'Order not found' }); return null; }
  return o;
}

app.get('/api/orders/:pid', async (req, res) => {
  let o = loadOrder(req, res);
  if (!o) return;
  // Fallback: if no callback after 20s, ask Safaricom directly (every 10s at most).
  if (o.status === 'pending' && o.checkout_request_id && !mpesa.MOCK && Date.now() - o.created_at > 20000 && Date.now() - (o.last_query_at || 0) > 10000) {
    db.prepare('UPDATE orders SET last_query_at=? WHERE id=?').run(Date.now(), o.id);
    try {
      const q = await mpesa.stkQuery(o.checkout_request_id);
      if (q.done) handleStkResult(o.checkout_request_id, q.resultCode, q.resultDesc, {});
    } catch (e) { /* still processing */ }
    o = loadOrder(req, res);
  }
  if (!o) return;
  const out = { orderId: o.public_id, status: o.status, event: o.event_name, amount: o.amount, email: o.email, message: o.result_desc, emailed: !!o.emailed_at };
  if (o.status === 'pending' && o.expires_at < Date.now()) out.status = 'expired';
  if (o.status === 'paid') {
    const rows = db.prepare('SELECT serial, holder_name FROM tickets WHERE order_id=? ORDER BY id').all(o.id);
    out.receipt = o.mpesa_receipt;
    out.tickets = await Promise.all(rows.map(async (t) => ({ ...t, qr: await T.qrDataUrl(t.serial) })));
  }
  res.json(out);
});

app.get('/api/orders/:pid/tickets.pdf', async (req, res) => {
  const o = loadOrder(req, res);
  if (!o) return;
  if (o.status !== 'paid') return res.status(409).json({ error: 'Payment not confirmed yet.' });
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(o.event_id);
  const tickets = db.prepare('SELECT * FROM tickets WHERE order_id=? ORDER BY id').all(o.id);
  const pdf = await T.buildPdf(tickets, ev);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="tickets-${o.public_id}.pdf"` }).send(pdf);
});

app.post('/api/orders/:pid/resend', async (req, res) => {
  const o = loadOrder(req, res);
  if (!o) return;
  if (o.status !== 'paid') return res.status(409).json({ error: 'Payment not confirmed yet.' });
  if (!allow(`resend:${o.id}`, 3, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many resends. Download the PDF instead.' });
  res.json({ ok: await deliverEmail(o.id) });
});

// ---------- staff: login, scanner ----------
app.post('/api/staff/login', (req, res) => {
  if (!allow(`login:${req.ip}`, 10, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts.' });
  const pin = String(req.body?.pin || '');
  const role = safeEq(pin, ADMIN_PIN) ? 'admin' : safeEq(pin, SCANNER_PIN) ? 'scanner' : null;
  if (!role) return res.status(401).json({ error: 'Wrong PIN' });
  res.json({ token: makeToken(role), role });
});

const scanTx = db.transaction((serial, who) => {
  const t = db.prepare('SELECT t.*, e.name AS event_name, o.name AS buyer, o.team_name, o.phone FROM tickets t JOIN events e ON e.id=t.event_id JOIN orders o ON o.id=t.order_id WHERE t.serial=?').get(serial);
  const log = (result, note) => db.prepare('INSERT INTO scans (serial, result, scanned_at, scanned_by, note) VALUES (?,?,?,?,?)').run(serial, result, Date.now(), who, note || null);
  if (!t) { log('INVALID', 'not found'); return { result: 'INVALID', message: 'Ticket not found' }; }
  const info = { serial: t.serial, holder: t.holder_name, category: t.event_name, team: t.team_name, buyer: t.buyer };
  if (t.status === 'void') { log('VOID'); return { result: 'VOID', message: 'Ticket was cancelled', ...info }; }
  // Atomic check-in: only one scan can ever flip valid -> used
  const r = db.prepare("UPDATE tickets SET status='used', used_at=?, used_by=? WHERE serial=? AND status='valid'").run(Date.now(), who, serial);
  if (r.changes === 1) { log('VALID'); return { result: 'VALID', message: 'Entry allowed', ...info }; }
  log('ALREADY_USED', `first used ${new Date(t.used_at).toISOString()}`);
  return { result: 'ALREADY_USED', message: 'Already scanned', usedAt: t.used_at, ...info };
});

app.post('/api/scan', requireRole('scanner', 'admin'), (req, res) => {
  const p = T.parseCode(req.body?.code);
  if (!p.valid) {
    db.prepare('INSERT INTO scans (serial, result, scanned_at, scanned_by, note) VALUES (?,?,?,?,?)').run(p.serial.slice(0, 40), 'INVALID', Date.now(), req.role, p.signed ? 'bad signature' : 'bad format');
    return res.json({ result: 'INVALID', message: p.signed ? 'Forged or damaged code' : 'Not a valid serial' });
  }
  res.json(scanTx(p.serial, req.role));
});

app.get('/api/scan/stats', requireRole('scanner', 'admin'), (req, res) => {
  const rows = db.prepare(`SELECT e.name, COUNT(t.id) AS issued, SUM(t.status='used') AS in_venue FROM events e LEFT JOIN tickets t ON t.event_id=e.id GROUP BY e.id ORDER BY e.sort`).all();
  const total = rows.reduce((a, r) => ({ issued: a.issued + r.issued, in_venue: a.in_venue + (r.in_venue || 0) }), { issued: 0, in_venue: 0 });
  res.json({ total, rows });
});

// ---------- admin ----------
app.get('/api/admin/summary', requireRole('admin'), (req, res) => {
  const now = Date.now();
  const rows = db.prepare(
    `SELECT e.code, e.name, e.kind, e.capacity, e.price,
       COALESCE((SELECT SUM(slots) FROM orders WHERE event_id=e.id AND status='paid'),0) sold,
       COALESCE((SELECT SUM(slots) FROM orders WHERE event_id=e.id AND status='pending' AND expires_at>?),0) held,
       COALESCE((SELECT SUM(amount) FROM orders WHERE event_id=e.id AND status='paid'),0) revenue,
       (SELECT COUNT(*) FROM tickets WHERE event_id=e.id) tickets,
       (SELECT COUNT(*) FROM tickets WHERE event_id=e.id AND status='used') checked_in
     FROM events e ORDER BY e.sort`).all(now);
  res.json({ rows, totals: { revenue: rows.reduce((a, r) => a + r.revenue, 0), tickets: rows.reduce((a, r) => a + r.tickets, 0), checked_in: rows.reduce((a, r) => a + r.checked_in, 0) } });
});

app.get('/api/admin/orders', requireRole('admin'), (req, res) => {
  const q = clean(req.query.q, 60), ev = clean(req.query.event, 20), st = clean(req.query.status, 20);
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT o.id, o.public_id, o.name, o.email, o.phone, o.team_name, o.game_id, o.slots, o.ticket_count, o.amount, o.status, o.mpesa_receipt, o.result_desc,
            o.created_at, o.paid_at, o.emailed_at, o.email_error, e.name AS event_name, e.code AS event_code
     FROM orders o JOIN events e ON e.id=o.event_id
     WHERE (?='' OR e.code=?) AND (?='' OR o.status=?)
       AND (?='' OR o.name LIKE ? OR o.email LIKE ? OR o.phone LIKE ? OR o.public_id LIKE ? OR o.mpesa_receipt LIKE ? OR o.team_name LIKE ?)
     ORDER BY o.id DESC LIMIT 500`).all(ev, ev, st, st, q, like, like, like, like, like, like);
  res.json(rows);
});

app.get('/api/admin/tickets', requireRole('admin'), (req, res) => {
  const q = clean(req.query.q, 60), ev = clean(req.query.event, 20), st = clean(req.query.status, 20), like = `%${q}%`;
  res.json(db.prepare(
    `SELECT t.serial, t.holder_name, t.status, t.used_at, t.used_by, t.created_at, e.name AS event_name, o.public_id AS order_ref, o.team_name, o.phone
     FROM tickets t JOIN events e ON e.id=t.event_id JOIN orders o ON o.id=t.order_id
     WHERE (?='' OR e.code=?) AND (?='' OR t.status=?) AND (?='' OR t.serial LIKE ? OR t.holder_name LIKE ? OR o.phone LIKE ? OR o.team_name LIKE ?)
     ORDER BY t.id DESC LIMIT 500`).all(ev, ev, st, st, q, like, like, like, like));
});

// Manual confirmation for the rare case a payment went through but the callback was lost.
app.post('/api/admin/orders/:id/confirm', requireRole('admin'), (req, res) => {
  const receipt = clean(req.body?.receipt, 20).toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(receipt)) return res.status(400).json({ error: 'Enter the M-Pesa receipt code (e.g. SHK1ABC2DE).' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No such order' });
  try {
    const r = finalizeTx(o.id, receipt);
    broadcast(false);
    if (r.created) deliverEmail(o.id);
    res.json({ ok: true, created: r.created });
  } catch (e) {
    res.status(409).json({ error: String(e.message).includes('UNIQUE') ? 'That receipt is already used on another order.' : 'Could not confirm.' });
  }
});

app.post('/api/admin/orders/:id/resend', requireRole('admin'), async (req, res) => {
  const o = db.prepare("SELECT id FROM orders WHERE id=? AND status='paid'").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not paid' });
  res.json({ ok: await deliverEmail(o.id) });
});

app.patch('/api/admin/events/:code', requireRole('admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE code=?').get(req.params.code);
  if (!ev) return res.status(404).json({ error: 'No such category' });
  const price = req.body.price !== undefined ? Math.floor(Number(req.body.price)) : ev.price;
  let capacity = ev.capacity;
  if (req.body.capacity !== undefined) capacity = req.body.capacity === null || req.body.capacity === '' ? null : Math.floor(Number(req.body.capacity));
  if (!(price >= 1) || (capacity !== null && !(capacity >= 0))) return res.status(400).json({ error: 'Invalid values' });
  db.prepare('UPDATE events SET price=?, capacity=? WHERE id=?').run(price, capacity, ev.id);
  broadcast(false);
  res.json({ ok: true });
});

app.get('/api/admin/export.csv', requireRole('admin'), (req, res) => {
  const rows = db.prepare(
    `SELECT t.serial, e.name AS category, t.holder_name, o.team_name, o.name AS buyer, o.phone, o.email, o.mpesa_receipt, o.amount, t.status, datetime(t.used_at/1000,'unixepoch') AS checked_in_at, datetime(o.paid_at/1000,'unixepoch') AS paid_at
     FROM tickets t JOIN events e ON e.id=t.event_id JOIN orders o ON o.id=t.order_id ORDER BY t.id`).all();
  const cols = rows[0] ? Object.keys(rows[0]) : ['serial'];
  const cell = (v) => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
  res.type('text/csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
});

// ---------- static ----------
app.use('/vendor/html5-qrcode.min.js', express.static(path.join(__dirname, 'node_modules/html5-qrcode/html5-qrcode.min.js')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`\n  Ticketing running at ${BASE_URL}`);
  console.log(`  M-Pesa: ${mpesa.MOCK ? 'MOCK mode (no Daraja credentials set)' : 'LIVE via Daraja'}   Callback: ${CALLBACK_URL}`);
  console.log(`  Email:  ${mailer.smtpConfigured ? 'SMTP' : 'no SMTP set, emails saved to data/outbox'}`);
  if (SCANNER_PIN === '1234' || ADMIN_PIN === '9999') console.log('  WARNING: default staff PINs in use. Set SCANNER_PIN and ADMIN_PIN in .env');
  console.log('');
});

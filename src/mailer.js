const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { dataDir } = require('./db');
const { EVENT } = require('./tickets');

const smtpConfigured = !!process.env.SMTP_HOST;
const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

const FROM = process.env.MAIL_FROM || `"${EVENT.name}" <no-reply@example.com>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendTickets({ order, eventRow, tickets, pdf }) {
  const rows = tickets
    .map((t) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${esc(t.holder_name)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;font-family:monospace;font-weight:bold">${t.serial}</td></tr>`)
    .join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111">
    <div style="background:#0b0d12;color:#fff;padding:22px 24px;border-bottom:5px solid #c6ff3d">
      <div style="color:#c6ff3d;font-size:12px;letter-spacing:3px;font-weight:bold">PAYMENT CONFIRMED</div>
      <div style="font-size:22px;font-weight:bold;margin-top:6px">${esc(EVENT.name)}</div>
      <div style="color:#9aa3b2;font-size:13px;margin-top:4px">${esc(EVENT.date)} · ${esc(EVENT.venue)}</div>
    </div>
    <div style="padding:22px 24px;border:1px solid #eee;border-top:0">
      <p>Hi ${esc(order.name)}, thanks for registering for <b>${esc(eventRow.name)}</b>.
      Your ticket${tickets.length > 1 ? 's are' : ' is'} attached as a PDF. Show the QR code at the gate; each ticket works once.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="background:#f5f6f8"><th align="left" style="padding:6px 12px">Holder</th><th align="left" style="padding:6px 12px">Serial</th></tr>${rows}
      </table>
      <p style="font-size:13px;color:#555;margin-top:18px">M-Pesa receipt: <b>${esc(order.mpesa_receipt || 'n/a')}</b> · Amount: KES ${order.amount}<br>
      Order reference: <b>${esc(order.public_id)}</b></p>
    </div></div>`;
  const info = await transport.sendMail({
    from: FROM,
    to: order.email,
    subject: `Your ${EVENT.name} ticket${tickets.length > 1 ? 's' : ''} (${eventRow.name})`,
    html,
    attachments: [{ filename: `tickets-${order.public_id}.pdf`, content: pdf, contentType: 'application/pdf' }],
  });
  if (!smtpConfigured) {
    // No SMTP set up: keep a copy on disk so the flow can be checked locally.
    const dir = path.join(dataDir, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${order.public_id}.json`), info.message);
    fs.writeFileSync(path.join(dir, `${order.public_id}.pdf`), pdf);
    console.log(`[mail] SMTP not configured, saved to data/outbox/${order.public_id}.*`);
  }
}

module.exports = { sendTickets, smtpConfigured };

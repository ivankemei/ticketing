const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { secret, EVENT } = require('./config');

// 32 unambiguous characters (no 0/O, 1/I)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randChars(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % 32];
  return s;
}

// e.g. KON-7QK2-M9XD. Uniqueness is guaranteed by the UNIQUE index; callers retry on collision.
function newSerial(prefix) {
  return `${prefix}-${randChars(4)}-${randChars(4)}`;
}

function sign(serial) {
  return crypto.createHmac('sha256', secret).update(serial).digest('hex').slice(0, 10);
}

// What is encoded in the QR: serial + signature, so forged codes are rejected before touching the DB.
function qrPayload(serial) {
  return `${serial}.${sign(serial)}`;
}

// Accepts a scanned QR ("SERIAL.sig") or a hand-typed serial. Returns { serial, signed, valid }.
function parseCode(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  const dot = s.indexOf('.');
  if (dot === -1) return { serial: s, signed: false, valid: /^[A-Z]{3}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(s) };
  const serial = s.slice(0, dot);
  const sig = raw.trim().slice(raw.trim().indexOf('.') + 1).toLowerCase();
  const ok = sig.length === 10 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(serial)));
  return { serial, signed: true, valid: ok };
}

function qrPng(serial, width = 480) {
  return QRCode.toBuffer(qrPayload(serial), { margin: 1, width, errorCorrectionLevel: 'M' });
}

async function qrDataUrl(serial) {
  return QRCode.toDataURL(qrPayload(serial), { margin: 1, width: 360, errorCorrectionLevel: 'M' });
}

// One page per ticket.
async function buildPdf(tickets, eventRow) {
  const doc = new PDFDocument({ size: [400, 640], margin: 0, info: { Title: `${EVENT.name} tickets` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (i > 0) doc.addPage({ size: [400, 640], margin: 0 });

    doc.rect(0, 0, 400, 150).fill('#0b0d12');
    doc.rect(0, 150, 400, 6).fill('#c6ff3d');
    doc.fillColor('#c6ff3d').font('Helvetica-Bold').fontSize(11).text('ADMIT ONE', 28, 28, { characterSpacing: 3 });
    doc.fillColor('#ffffff').fontSize(22).text(EVENT.name.toUpperCase(), 28, 50, { width: 344 });
    doc.fillColor('#9aa3b2').font('Helvetica').fontSize(11).text(`${EVENT.date}  ·  ${EVENT.venue}`, 28, 118, { width: 344 });

    doc.fillColor('#6b7280').font('Helvetica').fontSize(9).text('CATEGORY', 28, 180, { characterSpacing: 2 });
    doc.fillColor('#0b0d12').font('Helvetica-Bold').fontSize(24).text(eventRow.name, 28, 194, { width: 344 });
    doc.fillColor('#6b7280').font('Helvetica').fontSize(9).text('TICKET HOLDER', 28, 238, { characterSpacing: 2 });
    doc.fillColor('#0b0d12').font('Helvetica-Bold').fontSize(16).text(t.holder_name, 28, 252, { width: 344, ellipsis: true, height: 22 });

    const png = await qrPng(t.serial, 480);
    doc.image(png, 100, 292, { width: 200, height: 200 });

    doc.fillColor('#6b7280').font('Helvetica').fontSize(9).text('SERIAL NUMBER', 0, 506, { width: 400, align: 'center', characterSpacing: 2 });
    doc.fillColor('#0b0d12').font('Courier-Bold').fontSize(22).text(t.serial, 0, 520, { width: 400, align: 'center', characterSpacing: 1 });

    doc.moveTo(20, 568).lineTo(380, 568).dash(3, { space: 3 }).strokeColor('#c7ccd6').stroke().undash();
    doc.fillColor('#6b7280').font('Helvetica').fontSize(8)
      .text('Valid for a single entry. Each ticket can be scanned only once; a screenshot or copy will be refused after the first scan. Keep this code private.', 28, 580, { width: 344, align: 'center' });
  }
  doc.end();
  return done;
}

module.exports = { EVENT, newSerial, sign, qrPayload, parseCode, qrPng, qrDataUrl, buildPdf };

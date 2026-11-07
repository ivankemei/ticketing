// Safaricom Daraja STK push (Lipa na M-Pesa Online). Falls back to MOCK mode when no credentials are set,
// so the whole flow can be tested locally without a Safaricom account.
const KEY = process.env.MPESA_CONSUMER_KEY;
const SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE 
const PASSKEY = process.env.MPESA_PASSKEY 

const PARTY_B = process.env.MPESA_TILL_NUMBER 
const BASE = process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

const MOCK = process.env.MPESA_MOCK === '1' || !KEY || !SECRET;

let cached = { token: null, exp: 0 };

async function getToken() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const auth = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error(`M-Pesa auth failed (${r.status})`);
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return cached.token;
}

function timestamp() {
  // Daraja expects Nairobi time (UTC+3), YYYYMMDDHHmmss
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
}

function password(ts) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');
}

async function stkPush({ phone, amount, reference, description, callbackUrl }) {
  if (MOCK) {
    return {
      MerchantRequestID: 'MOCK-M-' + Date.now(),
      CheckoutRequestID: 'ws_CO_MOCK_' + Date.now() + Math.floor(Math.random() * 1e4),
      ResponseCode: '0',
      CustomerMessage: 'Mock STK push sent',
    };
  }
  const ts = timestamp();
  const token = await getToken();
  const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: SHORTCODE,
      Password: password(ts),
      Timestamp: ts,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_TILL_NUMBER,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: String(reference).slice(0, 12),
      TransactionDesc: String(description).slice(0, 13),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ResponseCode !== '0') {
    throw new Error(j.errorMessage || j.ResponseDescription || `STK push failed (${r.status})`);
  }
  return j;
}

// Ask Safaricom what happened to a push (used as a fallback if the callback never arrives).
// Returns { done:false } while still processing, else { done:true, resultCode, resultDesc }.
async function stkQuery(checkoutRequestId) {
  if (MOCK) return { done: false };
  const ts = timestamp();
  const token = await getToken();
  const r = await fetch(`${BASE}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: SHORTCODE,
      Password: password(ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.ResultCode === undefined) return { done: false }; // "being processed" comes back as an error body
  return { done: true, resultCode: Number(j.ResultCode), resultDesc: j.ResultDesc };
}

module.exports = { stkPush, stkQuery, MOCK };

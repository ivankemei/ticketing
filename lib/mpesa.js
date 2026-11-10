/**
 * Safaricom Daraja M-Pesa integration (lib/mpesa.js)
 *
 * Features:
 * - STK Push + STK Query
 * - Access token caching (with retry on expired token)
 * - Mock mode (never auto-enabled in production)
 * - Till (Buy Goods) and Paybill support
 * - Kenyan phone number normalization
 *
 * ENV VARS
 *   MPESA_ENV              "production" | anything else = sandbox
 *   MPESA_CONSUMER_KEY
 *   MPESA_CONSUMER_SECRET
 *   MPESA_SHORTCODE        BusinessShortCode (Till: the Store/Head Office number; Paybill: the paybill)
 *   MPESA_PASSKEY
 *   MPESA_CALLBACK_URL     Public HTTPS URL Daraja will POST results to
 *   MPESA_TILL_NUMBER      (Till only) the actual till number -> PartyB
 *   MPESA_TXN_TYPE         (optional) CustomerBuyGoodsOnline | CustomerPayBillOnline
 *                          Default: BuyGoods if MPESA_TILL_NUMBER is set, otherwise PayBill
 *   MPESA_MOCK             "1" forces mock mode (ignored in production unless explicitly "1")
 */

const IS_PROD =true;
const BASE =  "https://api.safaricom.co.ke";


const KEY = process.env.MPESA_CONSUMER_KEY;
const SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

// Safaricom Buy Goods Till configuration
const TILL_NUMBER =
  process.env.MPESA_TILL_NUMBER ||
  process.env.MPESA_PARTY_B;

const TXN_TYPE = "CustomerBuyGoodsOnline";

// PartyB must be the actual Till number.
const PARTY_B = TILL_NUMBER;

const HAS_CREDENTIALS = Boolean(KEY && SECRET && SHORTCODE && PASSKEY);

// Mock only when explicitly requested, or when not in production and creds are missing.
// In production, missing credentials produce a clear error instead of fake "paid" results.
const MOCK =
  process.env.MPESA_MOCK === "1" || (!IS_PROD && !HAS_CREDENTIALS);

const REQUEST_TIMEOUT_MS = 30000;
const MOCK_CONFIRM_AFTER_MS = 5000;

// --------------------------------------------------
// ACCESS TOKEN CACHE
// --------------------------------------------------

let cached = { token: null, expiresAt: 0 };

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function assertConfigured() {
  const missing = [];
  if (!KEY) missing.push("MPESA_CONSUMER_KEY");
  if (!SECRET) missing.push("MPESA_CONSUMER_SECRET");
  if (!SHORTCODE) missing.push("MPESA_SHORTCODE");
  if (!PASSKEY) missing.push("MPESA_PASSKEY");

  if (missing.length) {
    throw new Error(`M-Pesa is not configured. Missing: ${missing.join(", ")}`);
  }
}

/**
 * Accepts 07XXXXXXXX, 01XXXXXXXX, 7XXXXXXXX, 1XXXXXXXX, 254XXXXXXXXX, +254XXXXXXXXX
 * Returns 254XXXXXXXXX or throws.
 */
function toMpesaPhoneFormat(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");

  let normalized = digits;

  if (digits.startsWith("0")) {
    normalized = `254${digits.slice(1)}`;
  } else if (/^[17]\d{8}$/.test(digits)) {
    normalized = `254${digits}`;
  }

  if (!/^254[17]\d{8}$/.test(normalized)) {
    throw new Error("Invalid Kenyan M-Pesa phone number.");
  }

  return normalized;
}

function validateAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("Invalid M-Pesa payment amount.");
  }
  return Math.round(n);
}

// Nairobi timestamp: YYYYMMDDHHmmss
function timestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const v = {};
  for (const p of parts) v[p.type] = p.value;

  return v.year + v.month + v.day + v.hour + v.minute + v.second;
}

function generatePassword(ts) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString("base64");
}

// --------------------------------------------------
// ACCESS TOKEN
// --------------------------------------------------

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && cached.token && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  assertConfigured();

  const auth = Buffer.from(`${KEY}:${SECRET}`).toString("base64");

  const response = await fetch(
    `${BASE}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.errorMessage ||
        `Failed to get M-Pesa access token (${response.status})`
    );
  }

  const expiresIn = Number(data.expires_in) || 3599;

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(expiresIn - 60, 1) * 1000,
  };

  return cached.token;
}

/**
 * POST to Daraja with a bearer token. Retries once with a fresh token on 401.
 * Returns { response, data }.
 */
async function darajaPost(path, body) {
  let token = await getAccessToken();

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 && attempt === 0) {
      token = await getAccessToken(true);
      continue;
    }

    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  throw new Error("M-Pesa request failed after token refresh.");
}

// --------------------------------------------------
// MOCK STK PUSH
// --------------------------------------------------

function mockStkPush() {
  const id = Date.now();
  const merchantId = `MOCK-M-${id}`;
  const checkoutId = `ws_CO_MOCK_${id}`;

  return {
    merchantRequestId: merchantId,
    checkoutRequestId: checkoutId,
    responseCode: "0",
    responseDescription: "Mock STK push accepted",
    customerMessage: "Mock STK push sent successfully",
    mocked: true,

    MerchantRequestID: merchantId,
    CheckoutRequestID: checkoutId,
    ResponseCode: "0",
    ResponseDescription: "Mock STK push accepted",
    CustomerMessage: "Mock STK push sent successfully",
  };
}

// --------------------------------------------------
// STK PUSH
// --------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.phone
 * @param {number|string} input.amount
 * @param {string} [input.accountReference | input.reference]
 * @param {string} [input.transactionDesc | input.description]
 * @param {string} [input.callbackUrl]
 */
async function stkPush(input = {}) {
  // Validate first so mock mode catches the same errors as production.
  const phone = toMpesaPhoneFormat(input.phone);
  const amount = validateAmount(input.amount);

  if (MOCK) {
    return mockStkPush();
  }

  assertConfigured();

  if (!PARTY_B) {
    throw new Error("M-Pesa PartyB / Till number is missing.");
  }

  const callbackUrl = input.callbackUrl || CALLBACK_URL;

  if (!callbackUrl) {
    throw new Error("MPESA_CALLBACK_URL is not configured.");
  }

  if (IS_PROD && !/^https:\/\//i.test(callbackUrl)) {
    throw new Error("MPESA_CALLBACK_URL must be a public HTTPS URL in production.");
  }

  const reference = String(
    input.accountReference || input.reference || "PAYMENT"
  ).slice(0, 12);

  const description = String(
    input.transactionDesc || input.description || "Payment"
  ).slice(0, 13);

  const ts = timestamp();

  const { response, data } = await darajaPost("/mpesa/stkpush/v1/processrequest", {
    BusinessShortCode: SHORTCODE,
    Password: generatePassword(ts),
    Timestamp: ts,
    TransactionType: TXN_TYPE,
    Amount: amount,
    PartyA: phone,
    PartyB: PARTY_B,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: reference,
    TransactionDesc: description,
  });

  if (!response.ok || String(data.ResponseCode) !== "0") {
  console.error("[MPESA STK ERROR]", {
    status: response.status,
    response: data
  });

  throw new Error(
    data.errorMessage ||
    data.ResponseDescription ||
    data.error_description ||
    `STK push failed (${response.status})`
  );
}

if (!data.CheckoutRequestID || !data.MerchantRequestID) {
  console.error("[MPESA STK INVALID RESPONSE]", data);
  throw new Error("Safaricom did not return valid checkout request IDs.");
}

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    responseCode: data.ResponseCode,
    responseDescription: data.ResponseDescription,
    customerMessage: data.CustomerMessage,
    mocked: false,

    MerchantRequestID: data.MerchantRequestID,
    CheckoutRequestID: data.CheckoutRequestID,
    ResponseCode: data.ResponseCode,
    ResponseDescription: data.ResponseDescription,
    CustomerMessage: data.CustomerMessage,
  };
}

// --------------------------------------------------
// STK QUERY
// --------------------------------------------------

/**
 * Returns:
 *   { done: false }                                  -> still pending (or transient error)
 *   { done: true, resultCode, resultDesc }           -> final; resultCode 0 = paid
 * resultCode 1032 = cancelled by user, 1037 = timeout, 1 = insufficient funds, 2001 = wrong PIN.
 */
async function stkQuery(checkoutRequestId) {
  if (!checkoutRequestId) {
    throw new Error("CheckoutRequestID is required.");
  }

  if (MOCK) {
    // Simulate a successful payment a few seconds after the mock push.
    const match = /^ws_CO_MOCK_(\d+)$/.exec(String(checkoutRequestId));
    if (match && Date.now() - Number(match[1]) >= MOCK_CONFIRM_AFTER_MS) {
      return { done: true, resultCode: 0, resultDesc: "Mock payment successful" };
    }
    return { done: false };
  }

  assertConfigured();

  const ts = timestamp();

  const { data } = await darajaPost("/mpesa/stkpushquery/v1/query", {
    BusinessShortCode: SHORTCODE,
    Password: generatePassword(ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutRequestId,
  });

  if (data.ResultCode === undefined) {
    // Daraja returns errorCode 500.001.1001 while a transaction is still being processed.
    // Anything else is worth logging so real failures don't look like "pending" forever.
    if (data.errorCode && data.errorCode !== "500.001.1001") {
      console.error("[mpesa] stkQuery unexpected response:", data);
    }
    return { done: false };
  }

  return {
    done: true,
    resultCode: Number(data.ResultCode),
    resultDesc: data.ResultDesc,
  };
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  stkPush,
  stkQuery,
  toMpesaPhoneFormat,
  MOCK,
};

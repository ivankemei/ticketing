
/**
 * Unified Safaricom Daraja M-Pesa integration.
 *
 * Features:
 * - STK Push
 * - STK Query
 * - Access token caching
 * - Mock mode
 * - Till and Paybill support
 * - Kenyan phone number normalization
 */

const BASE =
  process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const KEY = process.env.MPESA_CONSUMER_KEY;
const SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;

const TXN_TYPE =
  process.env.MPESA_TXN_TYPE || "CustomerBuyGoodsOnline";

const PARTY_B =
  process.env.MPESA_TILL_NUMBER ||
  process.env.MPESA_PARTY_B ||
  SHORTCODE;

const MOCK =
  process.env.MPESA_MOCK === "1" ||
  !KEY ||
  !SECRET ||
  !SHORTCODE ||
  !PASSKEY;

const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

// --------------------------------------------------
// ACCESS TOKEN CACHE
// --------------------------------------------------

let cached = {
  token: null,
  expiresAt: 0,
};

// --------------------------------------------------
// PHONE NUMBER NORMALIZATION
// --------------------------------------------------

function toMpesaPhoneFormat(phone) {
  const digits = String(phone).replace(/\D/g, "");

  let normalized = digits;

  if (digits.startsWith("0")) {
    normalized = `254${digits.slice(1)}`;
  } else if (digits.startsWith("254")) {
    normalized = digits;
  }

  if (!/^254[17]\d{8}$/.test(normalized)) {
    throw new Error("Invalid Kenyan M-Pesa phone number.");
  }

  return normalized;
}

// --------------------------------------------------
// NAIROBI TIMESTAMP
// --------------------------------------------------

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

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return (
    values.year +
    values.month +
    values.day +
    values.hour +
    values.minute +
    values.second
  );
}

// --------------------------------------------------
// GENERATE DARAJA PASSWORD
// --------------------------------------------------

function generatePassword(ts) {
  return Buffer.from(
    `${SHORTCODE}${PASSKEY}${ts}`
  ).toString("base64");
}

// --------------------------------------------------
// GET ACCESS TOKEN
// --------------------------------------------------

async function getAccessToken() {
  if (cached.token && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  if (!KEY || !SECRET) {
    throw new Error("M-Pesa credentials are missing.");
  }

  const auth = Buffer.from(
    `${KEY}:${SECRET}`
  ).toString("base64");

  const response = await fetch(
    `${BASE}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
      cache: "no-store",
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
    expiresAt:
      Date.now() + Math.max(expiresIn - 60, 1) * 1000,
  };

  return cached.token;
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

async function stkPush(input) {
  if (MOCK) {
    return mockStkPush();
  }

  if (!PARTY_B) {
    throw new Error("M-Pesa PartyB / Till number is missing.");
  }

  const callbackUrl = input.callbackUrl || CALLBACK_URL;

  if (!callbackUrl) {
    throw new Error("MPESA_CALLBACK_URL is not configured.");
  }

  const phone = toMpesaPhoneFormat(input.phone);

  if (!Number.isFinite(Number(input.amount)) ||
      Number(input.amount) < 1) {
    throw new Error("Invalid M-Pesa payment amount.");
  }

  const reference = String(
    input.accountReference ||
    input.reference ||
    "PAYMENT"
  ).slice(0, 12);

  const description = String(
    input.transactionDesc ||
    input.description ||
    "Payment"
  ).slice(0, 13);

  const amount = Math.round(Number(input.amount));
  const ts = timestamp();

  const token = await getAccessToken();

  const response = await fetch(
    `${BASE}/mpesa/stkpush/v1/processrequest`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: generatePassword(ts),
        Timestamp: ts,
        TransactionType: TXN_TYPE,
        Amount: amount,
        PartyA: phone,
        PartyB:tillnumber,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: reference,
        TransactionDesc: description,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ResponseCode !== "0") {
    throw new Error(
      data.errorMessage ||
      data.ResponseDescription ||
      `STK push failed (${response.status})`
    );
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

async function stkQuery(checkoutRequestId) {
  if (MOCK) {
    return { done: false };
  }

  if (!checkoutRequestId) {
    throw new Error("CheckoutRequestID is required.");
  }

  const ts = timestamp();
  const token = await getAccessToken();

  const response = await fetch(
    `${BASE}/mpesa/stkpushquery/v1/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: generatePassword(ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (data.ResultCode === undefined) {
    return { done: false };
  }

  return {
    done: true,
    resultCode: Number(data.ResultCode),
    resultDesc: data.ResultDesc,
  };
}

// --------------------------------------------------
// COMMONJS EXPORTS
// --------------------------------------------------

module.exports = {
  stkPush,
  stkQuery,
  toMpesaPhoneFormat,
  MOCK,
};

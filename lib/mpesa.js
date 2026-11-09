/**
 * Wraps Safaricom's Daraja M-Pesa API. Requires these env vars for real
 * calls (see .env.example in the project scaffold):
 *   MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE,
 *   MPESA_PASSKEY, MPESA_CALLBACK_URL, MPESA_TILL_NUMBER
 *
 * MPESA_SHORTCODE is used to authenticate (BusinessShortCode/password).
 * MPESA_TILL_NUMBER is the actual Till that receives funds (PartyB) —
 * for many Till setups these are different values, even though they can
 * be the same number depending on how Safaricom provisioned the account.
 * If MPESA_TILL_NUMBER isn't set, falls back to MPESA_SHORTCODE.
 *
 * Without credentials (e.g. local dev), stkPush() returns a realistic
 * mock response instead of calling Safaricom, so the checkout flow and
 * UI can be built and tested end-to-end before Daraja credentials exist.
 */

const DARAJA_BASE_URL =
  process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

function hasCredentials(): boolean {
  return Boolean(
    process.env.MPESA_CONSUMER_KEY &&
      process.env.MPESA_CONSUMER_SECRET &&
      process.env.MPESA_SHORTCODE &&
      process.env.MPESA_PASSKEY
  );
}

async function getAccessToken(): Promise<string> {
  const key = process.env.MPESA_CONSUMER_KEY!;
  const secret = process.env.MPESA_CONSUMER_SECRET!;
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");

  const res = await fetch(`${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error("Failed to get M-Pesa access token");
  const data = await res.json();
  return data.access_token as string;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface StkPushInput {
  phone: string; // format 2547XXXXXXXX
  amount: number;
  accountReference: string; // e.g. order serial
  transactionDesc: string;
}

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
  mocked: boolean;
}

export async function stkPush(input: StkPushInput): Promise<StkPushResult> {
  if (!hasCredentials()) {
    // No Daraja credentials configured — return a realistic mock so the
    // rest of the checkout flow can be built and tested.
    return {
      merchantRequestId: `mock-${Date.now()}`,
      checkoutRequestId: `ws_CO_${Date.now()}`,
      responseCode: "0",
      responseDescription: "Success. Request accepted for processing (mocked — no MPESA_* env vars set)",
      customerMessage: "Success. Request accepted for processing",
      mocked: true,
    };
  }

  const shortcode = process.env.MPESA_SHORTCODE!;
  const tillNumber = process.env.MPESA_TILL_NUMBER || shortcode;
  const passkey = process.env.MPESA_PASSKEY!;
  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");
  const accessToken = await getAccessToken();

  const res = await fetch(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: Math.round(input.amount),
      PartyA: input.phone,
      PartyB: tillNumber,
      PhoneNumber: input.phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: input.accountReference,
      TransactionDesc: input.transactionDesc,
    }),
  });

  const data = await res.json();
  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    responseCode: data.ResponseCode,
    responseDescription: data.ResponseDescription,
    customerMessage: data.CustomerMessage,
    mocked: false,
  };
}

/** Normalizes 07XXXXXXXX / 01XXXXXXXX / +254XXXXXXXXX to Daraja's 2547XXXXXXXX format. */
export function toMpesaPhoneFormat(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  return digits;
}

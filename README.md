# NEXTPLAY CHAMPIONSHIP: ticketing (Vercel + Postgres)

Registration -> M-Pesa STK push -> ticket PDF by email + instant download -> QR scanning at the gate.
Pages: `/` public site · `/scanner` gate scanner · `/admin` dashboard.

| Category | Capacity | Price (KES) |
|---|---|---|
| KONAMI (PES) | 64 players | 1,000 |
| FIFA | 64 players | 1,000 |
| Call of Duty | 16 teams x 4 players | 5,000 per team |
| Chess | 64 players | 800 |
| Pool | 32 players | 800 |
| Spectator | unlimited | 200 (change in Admin) |

## Deploy on Vercel
1. Push this folder to your GitHub repo (replace the old files) and import it in Vercel. In Project Settings, Framework Preset = **Other**.
2. **Add the database:** Project -> Storage -> Create Database -> **Neon (Postgres)** -> connect to this project. This adds `DATABASE_URL` automatically. Tables and the six categories are created on the first request.
3. **Environment variables** (Settings -> Environment Variables), then redeploy:
   - `ADMIN_PIN`, `SCANNER_PIN`, `APP_SECRET` (long random text)
   - `EVENT_DATE`, `EVENT_VENUE`, `SUPPORT_CONTACT` (name defaults to NEXTPLAY CHAMPIONSHIP)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` for ticket emails
   - `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_ENV=production`, `MPESA_TXN_TYPE` (Paybill: `CustomerPayBillOnline`, Till: `CustomerBuyGoodsOnline` + `MPESA_PARTY_B`)
   - `BASE_URL` only if you use your own domain
4. Open the site. With no M-Pesa keys it runs in **test mode** (payment auto-approves after ~5s), so you can try everything first.

## Rules enforced
- Remaining = capacity - paid - payments in progress (held 4 min). A row lock per category means two people can never take the last spot. The site refreshes counts every 4 seconds.
- Serials like `KON-7QK2-M9XD` are unique (database constraint). QR = serial + signature, forged codes are refused.
- Scanning is atomic: only the first scan is VALID, any later scan shows ALREADY USED. All scans are logged.
- One registration per phone/email per player category. Team names are unique.
- Lost M-Pesa callback: the site asks Safaricom itself; Admin can also confirm with the M-Pesa receipt code.
- Emails are sent before the server responds and retried automatically; Admin has a Resend button.

## Local development
`npm install`, copy `.env.example` to `.env` with a `DATABASE_URL` (any Postgres), then `npm run dev`.

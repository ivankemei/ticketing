# Event ticketing (M-Pesa)

Categories: KONAMI 64 · FIFA 64 · COD 16 teams (4 tickets each) · Chess 64 · Pool 32 · Spectators unlimited.

## Run
    npm install
    cp .env.example .env     # edit event details, PINs, M-Pesa + SMTP settings
    npm start

With no Daraja keys the app runs in **MOCK mode** (payment auto-approves after ~5s; a phone ending in 0 simulates "cancelled"). Emails without SMTP are saved to `data/outbox/`.

Pages: `/` public site · `/scanner` gate scanner (SCANNER_PIN) · `/admin` dashboard (ADMIN_PIN)

## Going live checklist
1. Daraja app + Paybill/Till passkey -> fill `MPESA_*` in `.env`, set `MPESA_ENV=production`.
2. Host on a public HTTPS domain and set `BASE_URL` (Safaricom posts payment results to `/api/mpesa/callback/<secret>`; HTTPS is also required for the scanner camera).
3. Set `SMTP_*` (Gmail app password, Brevo, Zoho, etc.).
4. Change `SCANNER_PIN` and `ADMIN_PIN`. Set real prices/capacities in Admin -> Overview.
5. Back up `data/tickets.db` (SQLite, single file).

## How the rules are enforced
- Remaining count = capacity - paid - in-progress payments (held 4 min). Checked inside one DB transaction, so two people cannot take the last spot. Pushed live to every browser (SSE).
- Serials (e.g. `KON-7QK2-M9XD`) are random with a UNIQUE DB constraint. QR = serial + HMAC signature, so forged codes are rejected.
- Scan = atomic `valid -> used` update; a second scan returns ALREADY USED. Every scan is logged.
- One registration per phone/email per player category; team names unique.
- Lost callback? The site asks Safaricom for the result itself; admin can also confirm manually with the M-Pesa receipt.

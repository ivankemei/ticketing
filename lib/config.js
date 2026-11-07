const crypto = require('crypto');

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || '';

// Signs QR codes and staff sessions. Set APP_SECRET in production; the fallback is stable per database.
const secret = process.env.APP_SECRET || crypto.createHash('sha256').update('nextplay:' + DB_URL).digest('hex');

const BASE_URL = (
  process.env.BASE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '') ||
  `http://localhost:${process.env.PORT || 3000}`
).replace(/\/$/, '');

const EVENT = {
  name: process.env.EVENT_NAME || 'NEXTPLAY CHAMPIONSHIP',
  date: process.env.EVENT_DATE || 'Date to be announced',
  venue: process.env.EVENT_VENUE || 'Venue to be announced',
};

module.exports = { DB_URL, secret, BASE_URL, EVENT };

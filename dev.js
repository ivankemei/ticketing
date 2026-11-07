// Local development: serves the static site and the API on one port. Needs DATABASE_URL (any Postgres).
require('dotenv').config();
const express = require('express');
const path = require('path');
const api = require('./lib/app');
const { BASE_URL } = require('./lib/config');
const mpesa = require('./lib/mpesa');
const web = express();
web.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
web.use(api);
const port = Number(process.env.PORT || 3000);
web.listen(port, () => console.log(`NEXTPLAY tickets on ${BASE_URL} (M-Pesa: ${mpesa.MOCK ? 'MOCK' : 'LIVE'})`));

const express = require('express');
const got = require('got');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const { parsePhoneNumber } = require('libphonenumber-js');

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= CONFIG ================= */

const TARGET_HOST = 'http://51.89.99.105';
const LOGIN_URL = `${TARGET_HOST}/NumberPanel/login`;
const SIGNIN_URL = `${TARGET_HOST}/NumberPanel/signin`;
const NUMBERS2_URL = `${TARGET_HOST}/NumberPanel/agent/res/data_smsnumbers2.php`;
const SMS_API_URL =
  'http://147.135.212.197/crapi/st/viewstats?token=RVVUSkVBUzRHaothilCXX2KEa4FViFFBa5CVQWaYmGJbjVdaX2x4Vg==&dt1=2026-02-04 05:18:03&dt2=2126-05-09 05:18:16&records=10';

const USERNAME = process.env.PANEL_USER || 'Kami526';
const PASSWORD = process.env.PANEL_PASS || 'Kamran52';

/* ================= CLIENT ================= */

const cookieJar = new CookieJar();

const client = got.extend({
  cookieJar,
  timeout: 20000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/144 Mobile Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest'
  },
  retry: { limit: 2 }
});

/* ================= CACHE ================= */

let cachedNumbers = null;
let cachedSms = null;

let lastNumberFetch = 0;
let lastSmsFetch = 0;

const NUMBER_CACHE = 5 * 60 * 1000; // 5 min
const SMS_COOLDOWN = 5000; // 5 sec

/* ================= HELPERS ================= */

function getCountryFromNumber(number) {
  try {
    const num = number.toString().startsWith('+') ? number : '+' + number;
    const phone = parsePhoneNumber(num);
    if (!phone || !phone.country) return 'International';
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(phone.country);
  } catch {
    return 'Unknown';
  }
}

async function ensureLoggedIn() {
  try {
    const loginPage = await client.get(LOGIN_URL);
    const $ = cheerio.load(loginPage.body);

    const captcha = $('label:contains("What is")').text();
    let captAnswer = '';
    const m = captcha.match(/(\d+)\s*\+\s*(\d+)/);
    if (m) {
      captAnswer = (parseInt(m[1]) + parseInt(m[2])).toString();
    }

    await client.post(SIGNIN_URL, {
      form: {
        username: USERNAME,
        password: PASSWORD,
        capt: captAnswer
      },
      headers: { Referer: LOGIN_URL }
    });

    console.log('✅ Logged in to panel');
  } catch (e) {
    console.error('❌ Login error', e.message);
  }
}

/* ================= ROUTES ================= */

app.get('/', (_, res) => {
  res.send('Number Panel Proxy Running 🚀');
});

/* ===== Numbers API ===== */
app.get('/api/numbers', async (_, res) => {
  try {
    if (!cachedNumbers || Date.now() - lastNumberFetch > NUMBER_CACHE) {
      await ensureLoggedIn();

      const params = new URLSearchParams({
        frange: '',
        fclient: '',
        fallocated: '',
        sEcho: 2,
        iColumns: 8,
        sColumns: ',,,,,,,',
        iDisplayStart: 0,
        iDisplayLength: -1,
        iSortCol_0: 0,
        sSortDir_0: 'asc',
        iSortingCols: 1,
        _: Date.now()
      });

      const r = await client.get(`${NUMBERS2_URL}?${params.toString()}`, {
        responseType: 'json',
        headers: {
          Referer: `${TARGET_HOST}/NumberPanel/agent/MySMSNumbers2`
        }
      });

      cachedNumbers = r.body;
      lastNumberFetch = Date.now();
    }

    res.json(cachedNumbers);
  } catch (e) {
    console.error('❌ Numbers error:', e.message);
    if (cachedNumbers) res.json(cachedNumbers);
    else res.status(500).json({ error: 'Failed to fetch numbers' });
  }
});

/* ===== SMS API ===== */
app.get('/api/sms', async (_, res) => {
  try {
    const now = Date.now();
    if (cachedSms && now - lastSmsFetch < SMS_COOLDOWN) {
      return res.json(cachedSms);
    }

    lastSmsFetch = now;

    const r = await got.get(SMS_API_URL, { timeout: 20000 });
    const raw = r.body.toString().trim();

    if (
      raw.includes('Please wait') ||
      raw.includes('accessed this site too many times')
    ) {
      if (cachedSms) return res.json(cachedSms);
      return res.json({
        sEcho: 1,
        iTotalRecords: 0,
        iTotalDisplayRecords: 0,
        aaData: []
      });
    }

    if (!raw.startsWith('[')) {
      if (cachedSms) return res.json(cachedSms);
      throw new Error('Invalid JSON');
    }

    const data = JSON.parse(raw);

    const aaData = data.map(i => {
  let country = 'Unknown';
  if (i[1] && /^\d+$/.test(i[1])) {
    country = getCountryFromNumber(i[1]);
  }

  return [
    i[3],       // Service / Sender
    country,    // Country Name
    i[1],       // Number
    i[0],       // Service Type or label
    i[2],       // Full Message
    '$',        // Currency
    '0'         // Cost
  ];
});

    cachedSms = {
      sEcho: 1,
      iTotalRecords: aaData.length,
      iTotalDisplayRecords: aaData.length,
      aaData
    };

    res.json(cachedSms);
  } catch (e) {
    console.error('❌ SMS error:', e.message);
    if (cachedSms) return res.json(cachedSms);
    res.status(500).json({ error: 'Failed to fetch SMS data' });
  }
});

/* ================= START ================= */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

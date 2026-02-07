const express = require('express');
const got = require('got'); 
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const { parsePhoneNumber } = require('libphonenumber-js');

const app = express();
const PORT = process.env.PORT || 3000;

const cookieJar = new CookieJar();
const client = got.extend({
    cookieJar,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36'
    },
    retry: {
        limit: 2 
    }
});

const TARGET_HOST = 'http://51.89.99.105';
const LOGIN_URL = `${TARGET_HOST}/NumberPanel/login`;
const SIGNIN_URL = `${TARGET_HOST}/NumberPanel/signin`;
const DATA_URL = `${TARGET_HOST}/NumberPanel/agent/res/data_smsnumberstats.php`;

// SMS API URL
const SMS_API_URL = 'http://147.135.212.197/crapi/st/viewstats?token=RlRSQkhBUzRUc5WGZpiDYmhqdYldjHBqRYeFg2qWdGhch1BqXpOJWQ==&records=100';

// Credentials
const USERNAME = process.env.PANEL_USER || 'queenshaikhZ027';
const PASSWORD = process.env.PANEL_PASS || 'alizashaikh07';

// --- CACHING VARIABLES (Global Memory) ---
let numbersCache = null;
let numbersLastFetch = 0;
const NUMBERS_CACHE_TIME = 5 * 60 * 1000; // 5 Minutes

let smsCache = null;         // SMS ڈیٹا یہاں سٹور ہوگا
let smsLastFetch = 0;        // آخری بار کب اپڈیٹ ہوا
const SMS_CACHE_TIME = 5000; // 5 Seconds (Strict Lock)

// --- Helper Functions ---

function getCountryFromNumber(number) {
    if (!number) return "International";
    try {
        const strNum = number.toString().startsWith('+') ? number.toString() : '+' + number.toString();
        const phoneNumber = parsePhoneNumber(strNum);

        if (phoneNumber && phoneNumber.country) {
            const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
            return regionNames.of(phoneNumber.country);
        }
        return "International";
    } catch (error) {
        return "International";
    }
}

function fixSmsMessage(msg) {
    if (!msg) return "";
    let fixedMsg = msg.replace(/(\d)n/g, '$1 ');
    fixedMsg = fixedMsg.replace(/\n/g, ' ');
    return fixedMsg;
}

async function ensureLoggedIn() {
    try {
        const loginPage = await client.get(LOGIN_URL);
        const $ = cheerio.load(loginPage.body);
        const labelText = $('label:contains("What is")').text();
        const match = labelText.match(/(\d+)\s*\+\s*(\d+)/);
        let captchaAnswer = 0;
        if (match) captchaAnswer = parseInt(match[1]) + parseInt(match[2]);

        await client.post(SIGNIN_URL, {
            form: { username: USERNAME, password: PASSWORD, capt: captchaAnswer },
            headers: { 'Referer': LOGIN_URL }
        });
    } catch (error) {
        console.error('Login Failed:', error.message);
    }
}

// --- Routes ---

app.get('/', (req, res) => {
    res.send('Number Panel Proxy is Running with Anti-Spam Cache!');
});

// 1. Numbers API (5 Minute Cache Logic)
app.get('/api/numbers', async (req, res) => {
    try {
        const currentTime = Date.now();

        // ** Strict 5 Minute Lock **
        // اگر ڈیٹا موجود ہے اور 5 منٹ نہیں گزرے تو پرانا ڈیٹا بھیج دو
        if (numbersCache && (currentTime - numbersLastFetch < NUMBERS_CACHE_TIME)) {
            // console.log('Serving Numbers from Cache (No Upstream Hit)');
            return res.json(numbersCache);
        }

        // اگر 5 منٹ گزر گئے تو نیا ڈیٹا لاؤ
        await ensureLoggedIn();

        const fdate1 = '2026-01-01 00:00:00';
        const fdate2 = moment().tz("Asia/Karachi").format('YYYY-MM-DD 23:59:59');

        const searchParams = new URLSearchParams({
            fdate1: fdate1, fdate2: fdate2, sEcho: 4, iColumns: 5, sColumns: ',,,,',
            iDisplayStart: 0, iDisplayLength: -1, sSearch: '', bRegex: false, iSortCol_0: 0, sSortDir_0: 'desc', iSortingCols: 1, _: Date.now()
        });

        const response = await client.get(`${DATA_URL}?${searchParams.toString()}`, {
            headers: { 'Referer': `${TARGET_HOST}/NumberPanel/agent/SMSNumberStats`, 'X-Requested-With': 'XMLHttpRequest' },
            responseType: 'json' 
        });

        const rawData = response.body;

        // Transformation
        if (rawData.aaData && Array.isArray(rawData.aaData)) {
            rawData.aaData = rawData.aaData.map(item => {
                const number = item[0];
                const countryName = getCountryFromNumber(number);
                const currency = item[2];
                const price = item[3];
                
                return [
                    countryName,                            // 0
                    "",                                     // 1
                    number,                                 // 2
                    "OTP",                                  // 3
                    `${currency} ${price}`,                 // 4
                    "SD : <b>0</b> | SW : <b>0</b> "        // 5
                ];
            });
        }

        // Cache Update
        numbersCache = rawData;
        numbersLastFetch = currentTime;
        
        res.json(numbersCache);

    } catch (error) {
        console.error('Numbers API Error:', error.message);
        // اگر ایرر آئے تو کوشش کرو کہ پرانا کیش ہی بھیج دو تاکہ ایپ کریش نہ ہو
        if (numbersCache) return res.json(numbersCache);
        res.status(500).json({ error: 'Failed' });
    }
});

// 2. SMS API (5 Second Cache Logic)
app.get('/api/sms', async (req, res) => {
    try {
        const currentTime = Date.now();

        // ** Strict 5 Second Lock **
        // اگر ڈیٹا موجود ہے اور 5 سیکنڈ نہیں گزرے تو فورا پرانا ڈیٹا بھیجو
        // پیچھے ریکویسٹ بھیجنے کی ضرورت ہی نہیں
        if (smsCache && (currentTime - smsLastFetch < SMS_CACHE_TIME)) {
            // console.log('Serving SMS from Cache (Saving Spam)');
            return res.json(smsCache);
        }

        // اگر 5 سیکنڈ گزر گئے، تبھی نئی ریکویسٹ بھیجو
        const response = await got.get(SMS_API_URL, { responseType: 'text' });
        
        let rawData;
        try {
            rawData = JSON.parse(response.body);
        } catch (e) {
            console.error("Non-JSON Response from SMS API");
            // اگر JSON خراب ہے اور ہمارے پاس پرانا Cache ہے، تو وہی بھیج دو
            if (smsCache) return res.json(smsCache);
            return res.send(response.body);
        }

        if (!Array.isArray(rawData)) {
            if (smsCache) return res.json(smsCache);
            return res.json(rawData);
        }

        // Formatting
        const formattedData = rawData.map(item => {
            const cleanMessage = fixSmsMessage(item[2]);
            const country = getCountryFromNumber(item[1]);

            return [
                item[3],        // 0. Date
                country,        // 1. Country
                item[1],        // 2. Phone
                item[0],        // 3. Service
                cleanMessage,   // 4. Message
                "$",            // 5. Currency
                "0.005",        // 6. Price
                ""              // 7. Extra
            ];
        });

        // Footer
        formattedData.push([ "0,0.05,0,0,0,0,0,0.05,0,0,100%,0,9", 0, 0, 0, "", "$", 0, 0 ]);

        const finalResponse = {
            "sEcho": 1,
            "iTotalRecords": formattedData.length.toString(),
            "iTotalDisplayRecords": formattedData.length.toString(),
            "aaData": formattedData
        };

        // Cache Update
        smsCache = finalResponse;
        smsLastFetch = currentTime;

        res.json(smsCache);

    } catch (error) {
        console.error('SMS API Logic Error:', error.message);
        // Fallback: اگر ایرر آئے تو پرانا ڈیٹا زندہ باد
        if (smsCache) return res.json(smsCache);
        res.status(500).json({ "sEcho": 1, "iTotalRecords": 0, "iTotalDisplayRecords": 0, "aaData": [] });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

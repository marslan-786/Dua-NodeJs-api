const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

// --- CONFIGURATION (CLIENT) ---
const CREDENTIALS = {
    username: "Kami527", // Client Username
    password: "Kami526"  // Client Password
};

const BASE_URL = "http://51.89.99.105/NumberPanel";

// 1. Key Extract karne k liye ye Page open karein ge
const STATS_PAGE_URL = `${BASE_URL}/client/SMSCDRStats`; 

const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "http://51.89.99.105",
    "Accept-Language": "en-US,en;q=0.9,ur-PK;q=0.8,ur;q=0.7"
};

// --- GLOBAL STATE ---
let STATE = {
    cookie: null,
    sessKey: null,
    isLoggingIn: false
};

// --- HELPER: GET CURRENT DATE ---
function getTodayDate() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- HELPER: FIND KEY IN HTML ---
function extractKey(html) {
    // Ye specifically sAjaxSource wali line dhoonday ga
    let match = html.match(/sesskey=([^&"']+)/);
    if (match) return match[1];

    match = html.match(/sesskey\s*[:=]\s*["']([^"']+)["']/);
    if (match) return match[1];

    return null;
}

// --- 1. LOGIN & KEY FETCHING ---
async function performLogin() {
    if (STATE.isLoggingIn) return;
    STATE.isLoggingIn = true;
    
    console.log("🔄 System: Starting Client Login...");

    try {
        const instance = axios.create({ 
            withCredentials: true, 
            headers: COMMON_HEADERS,
            timeout: 15000
        });

        // A. Login Page fetch (Cookies k liye)
        const r1 = await instance.get(`${BASE_URL}/login`);
        let tempCookie = "";
        if (r1.headers['set-cookie']) {
            const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (c) tempCookie = c.split(';')[0];
        }

        // B. Solve Captcha
        const match = r1.data.match(/What is (\d+) \+ (\d+) = \?/);
        if (!match) throw new Error("Captcha Not Found");
        const ans = parseInt(match[1]) + parseInt(match[2]);

        // C. Post Login Request
        const params = new URLSearchParams();
        params.append('username', CREDENTIALS.username);
        params.append('password', CREDENTIALS.password);
        params.append('capt', ans);

        const r2 = await instance.post(`${BASE_URL}/signin`, params, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": tempCookie,
                "Referer": `${BASE_URL}/login`
            },
            maxRedirects: 0,
            validateStatus: () => true
        });

        // D. Save Valid Cookie
        if (r2.headers['set-cookie']) {
            const newC = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (newC) STATE.cookie = newC.split(';')[0];
        } else {
            STATE.cookie = tempCookie;
        }
        
        console.log("✅ Client Login Success. Cookie:", STATE.cookie);

        // E. GET SESSKEY (From SMSCDRStats HTML)
        // Hum API call nahi kr rahe, bas HTML mangwa rahe hain key nikalne k liye
        console.log("🕵️ Fetching Stats Page to extract SessKey...");
        
        const r3 = await axios.get(STATS_PAGE_URL, {
            headers: { 
                ...COMMON_HEADERS, 
                "Cookie": STATE.cookie,
                "Referer": `${BASE_URL}/client/SMSDashboard`
            }
        });

        const foundKey = extractKey(r3.data);
        
        if (foundKey) {
            STATE.sessKey = foundKey;
            console.log("🔥 SessKey FOUND:", STATE.sessKey);
        } else {
            console.log("❌ CRITICAL: SessKey NOT found in HTML.");
        }

    } catch (e) {
        console.error("❌ Login Failed:", e.message);
    } finally {
        STATE.isLoggingIn = false;
    }
}

// --- 2. AUTO REFRESH (Keep Session Alive) ---
setInterval(() => {
    performLogin();
}, 120000); // Har 2 minute baad refresh

// --- 3. OUR API ENDPOINT ---
app.get('/api', async (req, res) => {
    const { type } = req.query;

    // Agar key nahi hai to login karein
    if (!STATE.cookie || !STATE.sessKey) {
        await performLogin();
        if (!STATE.sessKey) return res.status(500).json({error: "Server Error: Waiting for Login..."});
    }

    const ts = Date.now();
    const today = getTodayDate();
    let targetUrl = "";
    let specificReferer = "";

    // --- CLIENT URLs ---
    if (type === 'numbers') {
        // Client Numbers URL (Notice: client path)
        specificReferer = `${BASE_URL}/client/MySMSNumbers`;
        targetUrl = `${BASE_URL}/client/res/data_smsnumbers.php?frange=&fclient=&sEcho=2&iColumns=6&sColumns=%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=-1&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=true&bSortable_0=true&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=asc&iSortingCols=1&_=${ts}`;
    
    } else if (type === 'sms') {
        // Client SMS URL (Using extracted SessKey)
        // Notice: iColumns=7 for Client (Agent had 9)
        specificReferer = `${BASE_URL}/client/SMSCDRStats`;
        targetUrl = `${BASE_URL}/client/res/data_smscdr.php?fdate1=2025-12-17%2000:00:00&fdate2=2259-12-20%2023:59:59&frange=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgnumber=&fgcli=&fg=0&sesskey=${STATE.sessKey}&sEcho=2&iColumns=7&sColumns=%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=-1&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=true&bSortable_0=true&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1&_=${ts}`;
    
    } else {
        return res.status(400).json({ error: "Invalid type. Use ?type=sms or ?type=numbers" });
    }

    try {
        console.log(`📡 Fetching Client Data: ${type}`);
        
        // Yeh request internal API ko hit kare gi jo JSON return karti hai
        const response = await axios.get(targetUrl, {
            headers: { 
                ...COMMON_HEADERS, 
                "Cookie": STATE.cookie,
                "Referer": specificReferer
            },
            responseType: 'arraybuffer',
            timeout: 25000
        });

        const checkData = response.data.subarray(0, 1000).toString();
        if (checkData.includes('<html') || checkData.includes('login')) {
            console.log("⚠️ Session Expired. Re-logging in...");
            await performLogin();
            return res.status(503).send("Session Refreshed. Try Again.");
        }

        res.set('Content-Type', 'application/json');
        res.send(response.data);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    performLogin();
});

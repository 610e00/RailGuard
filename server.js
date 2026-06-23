// ===========================
// RailGuard AI — TDX Proxy Server + LINE Bot 後端 API
// 啟動: node server.js
// 部署: Render（或本機測試 node server.js）
// ===========================

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const PORT           = process.env.PORT ? Number(process.env.PORT) : 3000;
const TDX_CLIENT_ID  = process.env.TDX_CLIENT_ID  || 'amy0105wy-8b71ef19-6ec0-415c';
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || 'b5e80f9a-68f2-45ca-878e-256b957ff13e';
const TDX_AUTH_URL   = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

// 簡易檔案式資料庫（小規模 demo 用，足夠期末專案使用）
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.conversations) db.conversations = {}; // 向下相容：舊db.json補上這個欄位
    return db;
  } catch(e) {
    return { pending: {}, trips: [], conversations: {} };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
// 初始化 db.json（若不存在）
if (!fs.existsSync(DB_FILE)) saveDB({ pending: {}, trips: [], conversations: {} });

let cachedToken = null;
let tokenExpiry  = 0;

// ── 台鐵站代碼對照表（已修正版）──
const TRA_STATION_MAP = {
  '南港': '0980', '台北': '1000', '板橋': '1020', '桃園': '1080',
  '中壢': '1100', '新竹': '1210', '苗栗': '3160', '台中': '3300',
  '彰化': '3360', '斗六': '3470', '嘉義': '4080', '台南': '4220',
  '左營': '4350'
};

// ---- 取得 TDX token ----
function fetchToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     TDX_CLIENT_ID,
      client_secret: TDX_CLIENT_SECRET
    }).toString();

    const opts = {
      method:  'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(TDX_AUTH_URL, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.access_token) return reject(new Error('TDX 授權失敗：' + data));
          resolve(json);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const json   = await fetchToken();
  cachedToken  = json.access_token;
  tokenExpiry  = Date.now() + (json.expires_in - 60) * 1000;
  console.log('[TDX] Token 已更新');
  return cachedToken;
}

// ---- 轉發 TDX GET 請求 ----
function fetchTDX(targetUrl, token) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { Authorization: `Bearer ${token}` } };
    https.get(targetUrl, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data }); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function toHHmm(t) { return t ? t.slice(0, 5) : ''; }
function toMins(t) {
  if (!t) return -1;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function getTrainTypeName(ti) {
  const ttn = ti.TrainTypeName;
  if (ttn?.Zh_tw) return ttn.Zh_tw.replace(/[（(].*?[)）]/g, '').trim() || ttn.Zh_tw;
  return '自強號';
}

// ---- 核心：查詢全班表，篩出兩站都停靠的車次 ----
async function fetchAllTrains(fromId, toId, dateStr) {
  const fromNum = parseInt(fromId);
  const toNum   = parseInt(toId);
  const direction = fromNum < toNum ? 1 : 0;

  const token = await getToken();
  const tdxUrl = `https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${dateStr}?$filter=TrainInfo/Direction eq ${direction}&$format=JSON&$top=500`;
  const result = await fetchTDX(tdxUrl, token);
  const data = JSON.parse(result.body);
  const raw  = data.TrainTimetables || [];

  const results = [];
  for (const t of raw) {
    const stops = t.StopTimes || [];
    const ti    = t.TrainInfo || t;
    const depStop = stops.find(s => String(s.StationID) === String(fromId));
    const arrStop = stops.find(s => String(s.StationID) === String(toId));
    if (!depStop || !arrStop) continue;
    if (depStop.StopSequence >= arrStop.StopSequence) continue;

    const depTime = toHHmm(depStop.DepartureTime || depStop.ArrivalTime || '');
    const arrTime = toHHmm(arrStop.ArrivalTime || arrStop.DepartureTime || '');
    if (!depTime) continue;

    results.push({
      trainNo: String(ti.TrainNo || ''),
      trainType: getTrainTypeName(ti),
      departTime: depTime,
      arrivalTime: arrTime,
      depMins: toMins(depTime)
    });
  }
  return results.sort((a, b) => a.depMins - b.depMins);
}

// ---- 依車次號查詢當天完整停靠站時刻表（給「已買票追蹤特定車次」功能用）----
async function fetchTrainByNo(trainNo, dateStr) {
  const token = await getToken();
  const tdxUrl = `https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainNo/${trainNo}/TrainDate/${dateStr}?$format=JSON`;
  const result = await fetchTDX(tdxUrl, token);
  const data = JSON.parse(result.body);
  const list = data.TrainTimetables || [];
  if (list.length === 0) return null;

  const t  = list[0];
  const ti = t.TrainInfo || {};
  const stops = (t.StopTimes || []).map(s => ({
    stationId: String(s.StationID),
    stationName: s.StationName?.Zh_tw || '',
    arrivalTime: toHHmm(s.ArrivalTime || s.DepartureTime || ''),
    departureTime: toHHmm(s.DepartureTime || s.ArrivalTime || ''),
    stopSequence: s.StopSequence
  }));

  return {
    trainNo: String(ti.TrainNo || trainNo),
    trainType: getTrainTypeName(ti),
    startingStationName: ti.StartingStationName?.Zh_tw || '',
    endingStationName: ti.EndingStationName?.Zh_tw || '',
    stops
  };
}

// ---- 查詢即時延誤 ----
async function fetchTrainDelay(trainNo, fromStationId) {
  const token = await getToken();
  try {
    const tdxUrl = `https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/StationLiveBoard/Station/${fromStationId}?$format=JSON`;
    const result = await fetchTDX(tdxUrl, token);
    const data = JSON.parse(result.body);
    const arr  = data.StationLiveBoards || [];
    const live = arr.find(l => String(l.TrainNo) === String(trainNo));
    if (live) return live.DelayTime || 0;
  } catch(e) {}
  return null;
}

// ---- 查詢前後班次（給 LINE Bot 用）----
async function queryNearbyTrainsForLine(fromName, toName, targetTime, dateStr) {
  const fromId = TRA_STATION_MAP[fromName];
  const toId   = TRA_STATION_MAP[toName];
  if (!fromId || !toId) throw new Error(`找不到站名: ${fromName} 或 ${toName}`);

  const trains = await fetchAllTrains(fromId, toId, dateStr);
  const targetMins = toMins(targetTime);

  const before = trains.filter(t => t.depMins < targetMins).slice(-2);
  const after  = trains.filter(t => t.depMins >= targetMins).slice(0, 3);
  const candidates = [...before, ...after].slice(0, 5);

  // 補上即時延誤（僅當天才查）
  const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (dateStr === todayStr) {
    for (const c of candidates) {
      c.delayMins = await fetchTrainDelay(c.trainNo, fromId);
    }
  } else {
    candidates.forEach(c => c.delayMins = null);
  }

  return candidates;
}

// ── CORS ──
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // ───────────────────────────────────────
    // 既有功能：TDX proxy（網頁版沿用）
    // ───────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tdx') {
      const targetUrl = parsed.query.url;
      if (!targetUrl) return sendJSON(res, 400, { error: '缺少 url 參數' });
      if (!targetUrl.startsWith('https://tdx.transportdata.tw/')) {
        return sendJSON(res, 403, { error: '不允許的目標 URL' });
      }
      const token  = await getToken();
      const result = await fetchTDX(targetUrl, token);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
      return;
    }

    // ───────────────────────────────────────
    // 【新】LINE Bot 用：查詢附近班次
    // GET /api/line/nearby-trains?from=台北&to=中壢&time=08:00&date=2026-06-20
    // ───────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/line/nearby-trains') {
      const { from, to, time, date } = parsed.query;
      if (!from || !to || !time) return sendJSON(res, 400, { error: '需要 from, to, time 參數' });
      const dateStr = date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const candidates = await queryNearbyTrainsForLine(from, to, time, dateStr);
      return sendJSON(res, 200, { candidates });
    }

    // ───────────────────────────────────────
    // 【新】暫存使用者目前的候選班次（等待選擇）
    // POST /api/pending  body: { userId, from, to, time, type, days, date, candidates }
    // ───────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/pending') {
      const body = await readBody(req);
      if (!body.userId) return sendJSON(res, 400, { error: '需要 userId' });
      const db = loadDB();
      db.pending[body.userId] = { ...body, createdAt: new Date().toISOString() };
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    // ───────────────────────────────────────
    // 【新】撈回使用者暫存的候選班次
    // GET /api/pending/:userId
    // ───────────────────────────────────────
    if (req.method === 'GET' && pathname.startsWith('/api/pending/')) {
      const userId = pathname.split('/api/pending/')[1];
      const db = loadDB();
      const data = db.pending[userId];
      if (!data) return sendJSON(res, 404, { error: '找不到暫存資料' });
      return sendJSON(res, 200, data);
    }

    // ───────────────────────────────────────
    // 【新】使用者選定車次後，正式寫入監控行程
    // POST /api/trips  body: { userId, from, to, time, type, days, date, trainNo, trainType }
    // ───────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/trips') {
      const body = await readBody(req);
      if (!body.userId) return sendJSON(res, 400, { error: '需要 userId' });
      const db = loadDB();
      const trip = {
        id: 'trip-' + Date.now(),
        ...body,
        createdAt: new Date().toISOString()
      };
      db.trips.push(trip);
      delete db.pending[body.userId]; // 清除暫存
      saveDB(db);
      return sendJSON(res, 200, { ok: true, trip });
    }

    // ───────────────────────────────────────
    // 【新】查詢某使用者目前所有監控行程（給排程節點用）
    // GET /api/trips?userId=xxx  （不帶userId則回傳全部，排程用）
    // ───────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/trips') {
      const db = loadDB();
      const userId = parsed.query.userId;
      const trips = userId ? db.trips.filter(t => t.userId === userId) : db.trips;
      return sendJSON(res, 200, { trips });
    }

    // ───────────────────────────────────────
    // 【新】對話狀態管理 — 多輪對話的地基
    // ───────────────────────────────────────

    // 取得使用者目前對話狀態
    // GET /api/conversation/:userId
    // 若無進行中對話，回傳一個全新的空白狀態（不是404），方便n8n端不用額外判斷
    if (req.method === 'GET' && pathname.startsWith('/api/conversation/')) {
      const userId = pathname.split('/api/conversation/')[1];
      const db = loadDB();
      const conv = db.conversations[userId] || {
        state: 'COLLECTING',
        collected: { from: null, to: null, time: null, type: null, days: [], date: null },
        candidates: null,
        notifyThreshold: null,
        updatedAt: null
      };
      return sendJSON(res, 200, conv);
    }

    // 更新（覆寫）使用者目前對話狀態
    // POST /api/conversation/:userId  body: { state, collected, candidates, notifyThreshold }
    if (req.method === 'POST' && pathname.startsWith('/api/conversation/')) {
      const userId = pathname.split('/api/conversation/')[1];
      const body = await readBody(req);
      const db = loadDB();
      db.conversations[userId] = {
        ...(db.conversations[userId] || {}),
        ...body,
        updatedAt: new Date().toISOString()
      };
      saveDB(db);
      return sendJSON(res, 200, { ok: true, conversation: db.conversations[userId] });
    }

    // 清除使用者對話狀態（完成或取消時呼叫）
    // DELETE /api/conversation/:userId
    if (req.method === 'DELETE' && pathname.startsWith('/api/conversation/')) {
      const userId = pathname.split('/api/conversation/')[1];
      const db = loadDB();
      delete db.conversations[userId];
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    // ───────────────────────────────────────
    // 【新】查詢特定車次當天時刻表，並確認上車站是否為停靠站
    // GET /api/line/train-info?trainNo=2007&date=2026-06-24&boardingStation=中壢
    // ───────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/line/train-info') {
      const { trainNo, date, boardingStation } = parsed.query;
      if (!trainNo) return sendJSON(res, 400, { error: '需要 trainNo 參數' });
      const dateStr = date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

      const train = await fetchTrainByNo(trainNo, dateStr);
      if (!train) {
        return sendJSON(res, 200, { found: false, message: `查不到${dateStr}的${trainNo}次列車，請確認車次號或日期是否正確。` });
      }

      let boardingStop = null;
      if (boardingStation) {
        const boardingId = TRA_STATION_MAP[boardingStation];
        if (boardingId) {
          boardingStop = train.stops.find(s => s.stationId === String(boardingId)) || null;
        }
      }

      const validBoarding = !boardingStation || !!boardingStop;

      return sendJSON(res, 200, {
        found: true,
        validBoarding,
        train,
        boardingStop
      });
    }

    // ───────────────────────────────────────
    // 既有 debug 端點維持
    // ───────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/debug/timetable') {
      const { from, to, date, top = '3' } = parsed.query;
      if (!from || !to || !date) return sendJSON(res, 400, { error: '需要 from, to, date 參數' });
      const tdxUrl = `https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/DailyTrainTimetable/OD/${from}/to/${to}/${date}?$format=JSON&$top=${top}`;
      const token = await getToken();
      const result = await fetchTDX(tdxUrl, token);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      return sendJSON(res, 200, { status: 'RailGuard API running', time: new Date().toISOString() });
    }

    sendJSON(res, 404, { error: 'Not found' });

  } catch(e) {
    console.error('[error]', e.message);
    sendJSON(res, 502, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🚂 RailGuard AI Server 已啟動於 port ${PORT}`);
});

// ===========================
// RailGuard AI — TDX API Layer
// v11：改用全班表查詢（DailyTrainTimetable 不帶 OD），支援任意兩站組合
//      修正站代碼對照表，顯示前後各3班
// ===========================

const PROXY_BASE  = 'http://localhost:3000/api/tdx?url=';
const TDX_TRA_V3  = 'https://tdx.transportdata.tw/api/basic/v3/Rail/TRA';
const TDX_THSR_V2 = 'https://tdx.transportdata.tw/api/basic/v2/Rail/THSR';

// 台鐵站代碼 V3（站名 → StationID，四碼字串）
// 已修正：彰化=3360，台中=2700（台中市區站），斗六=2600
const TRA_STATION_MAP = {
  '南港': '0900', '台北': '1000', '板橋': '1020', '桃園': '1110',
  '中壢': '1120', '新竹': '1220', '苗栗': '1310', '台中': '2700',
  '彰化': '3360', '斗六': '2600', '嘉義': '4200', '台南': '5200',
  '左營': '6300'
};

// 高鐵站代碼
const THSR_STATION_MAP = {
  '南港': 'NAK', '台北': 'TPE', '板橋': 'BAN', '桃園': 'TYN',
  '新竹': 'HSD', '苗栗': 'MQL', '台中': 'TXG', '彰化': 'CHH',
  '斗六': 'YLH', '嘉義': 'CHY', '台南': 'TNN', '左營': 'ZUO'
};
const THSR_STATIONS = new Set(Object.keys(THSR_STATION_MAP));

// ── 統一透過 proxy 發 GET ──
async function tdxGet(tdxUrl) {
  const proxyUrl = PROXY_BASE + encodeURIComponent(tdxUrl);
  const resp = await fetch(proxyUrl);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `proxy 錯誤 ${resp.status}`);
  }
  return resp.json();
}

// ── 時間字串 "HH:mm" → 分鐘數 ──
function toMins(timeStr) {
  if (!timeStr) return -1;
  const parts = timeStr.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function toHHmm(timeStr) {
  if (!timeStr) return '';
  return timeStr.slice(0, 5);
}

function sameTrainNo(a, b) {
  if (a == null || b == null) return false;
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a).trim() === String(b).trim();
}

const LIVE_TRAIN_TYPE_MAP = {
  1: '太魯閣', 2: '普悠瑪', 3: '自強號',
  4: '莒光號', 5: '區間快', 6: '區間車', 7: '復興號'
};

// ── 從 TrainTypeCode 取得車種名稱 ──
function getTrainTypeName(ti) {
  const ttn = ti.TrainTypeName;
  if (typeof ttn === 'string') return ttn;
  if (ttn?.Zh_tw) {
    // 簡化名稱：去掉括號內的說明文字
    return ttn.Zh_tw.replace(/[（(].*?[)）]/g, '').trim() || ttn.Zh_tw;
  }
  if (ti.TrainTypeCode) {
    const typeMap = {
      '1': '太魯閣', '2': '普悠瑪', '3': '自強號', '4': '莒光號',
      '5': '區間快', '6': '區間車', '7': '復興號',
      '11': '自強(3000)', '12': '太魯閣(3000)',
      'TR': '太魯閣', 'PP': '普悠瑪', 'E': '自強號',
      'G': '莒光號', 'CT': '區間快', 'DR': '區間車'
    };
    return typeMap[String(ti.TrainTypeCode).trim()] || '自強號';
  }
  return '自強號';
}

// ── 核心：查詢全班表，篩選有停靠 from 和 to 的車次 ──
// 不使用 OD 查詢，改抓當日所有南下/北上班次再自行篩選
// 這樣任意兩站組合都能查到
async function fetchAllTrains(fromId, toId, dateStr) {
  const normalize = id => String(id).replace(/^0+/, '').padStart(4, '0');
  const fromNorm = normalize(fromId);
  const toNorm   = normalize(toId);

  // 判斷方向：fromId < toId 代表南下（Direction=1），反之北上（Direction=0）
  // 台鐵站代碼由北往南遞增
  const fromNum = parseInt(fromNorm);
  const toNum   = parseInt(toNorm);
  const direction = fromNum < toNum ? 1 : 0;

  // 抓全部班次（$top=500 確保不漏）
  const url = `${TDX_TRA_V3}/DailyTrainTimetable/TrainDate/${dateStr}?$filter=TrainInfo/Direction eq ${direction}&$format=JSON&$top=500`;
  const data = await tdxGet(url);
  const raw  = data.TrainTimetables || (Array.isArray(data) ? data : []);

  const results = [];

  for (const t of raw) {
    const stops = t.StopTimes || [];
    const ti    = t.TrainInfo || t;

    const depStop = stops.find(s => normalize(s.StationID) === fromNorm);
    const arrStop = stops.find(s => normalize(s.StationID) === toNorm);

    // 兩站都有停靠，且出發站序號在目的站之前
    if (!depStop || !arrStop) continue;
    if (depStop.StopSequence >= arrStop.StopSequence) continue;

    const depTime = toHHmm(depStop.DepartureTime || depStop.ScheduledDepartureTime ||
                           depStop.ArrivalTime   || depStop.ScheduledArrivalTime   || '');
    const arrTime = toHHmm(arrStop.ArrivalTime   || arrStop.ScheduledArrivalTime   ||
                           arrStop.DepartureTime || arrStop.ScheduledDepartureTime || '');

    if (!depTime) continue;

    results.push({
      trainNo:    String(ti.TrainNo || ''),
      trainType:  getTrainTypeName(ti),
      departTime: depTime,
      arrivalTime: arrTime,
      depMins:    toMins(depTime)
    });
  }

  return results.sort((a, b) => a.depMins - b.depMins);
}

async function fetchSortedTrains(fromId, toId, dateStr) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchAllTrains(fromId, toId, dateStr);
    } catch(e) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
      else throw e;
    }
  }
  return [];
}

// ── 查詢單一車次即時延誤 ──
async function fetchTrainDelay(trainNo, fromStationId) {
  if (fromStationId) {
    try {
      const url  = `${TDX_TRA_V3}/StationLiveBoard/Station/${fromStationId}?$format=JSON`;
      const data = await tdxGet(url);
      const arr  = data.StationLiveBoards || (Array.isArray(data) ? data : []);
      const live = arr.find(l => sameTrainNo(l.TrainNo, trainNo));
      if (live) return { delayMins: live.DelayTime || 0 };
    } catch(e) {}
  }
  try {
    const url  = `${TDX_TRA_V3}/TrainLiveBoard/TrainNo/${trainNo}?$format=JSON`;
    const data = await tdxGet(url);
    const arr  = data.TrainLiveBoards || (Array.isArray(data) ? data : []);
    if (arr.length > 0) {
      const live = arr.find(l => sameTrainNo(l.TrainNo, trainNo)) || arr[0];
      return { delayMins: live.DelayTime || 0 };
    }
  } catch(e) {}
  return null;
}

// ── 補查即時延誤 ──
async function enrichWithDelay(candidates, dateStr, fromId) {
  const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (dateStr !== todayStr) {
    return candidates.map(c => c ? { ...c, delayMins: null, liveAvailable: false } : null);
  }
  return Promise.all(candidates.map(async c => {
    if (!c) return null;
    try {
      const result = await fetchTrainDelay(c.trainNo, fromId);
      return { ...c, delayMins: result !== null ? result.delayMins : null, liveAvailable: true };
    } catch(e) {
      return { ...c, delayMins: null, liveAvailable: true };
    }
  }));
}

// ════════════════════════════════════════════
// 【主要功能】查詢前後各3班（共最多6班）
// 回傳 { mode, candidates, recommended }
// candidates: 陣列，每個元素含 key('before'/'after'/'exact') + train
// ════════════════════════════════════════════
async function queryNearbyTrains(fromStation, toStation, targetTime, queryDate) {
  const fromId = TRA_STATION_MAP[fromStation];
  const toId   = TRA_STATION_MAP[toStation];
  if (!fromId || !toId) throw new Error(`找不到站代碼：${fromStation} 或 ${toStation}`);

  const dateStr = queryDate || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const trains  = await fetchSortedTrains(fromId, toId, dateStr);

  if (trains.length === 0) return { mode: 'between', candidates: [], recommended: null };

  const targetMins = toMins(targetTime);

  // 找前後各3班
  const beforeList = trains.filter(t => t.depMins <  targetMins);
  const afterList  = trains.filter(t => t.depMins >  targetMins);
  const exactList  = trains.filter(t => t.depMins === targetMins);

  // 取前3和後3
  const rawBefores = beforeList.slice(-3);          // 最近的3班（時間較早）
  const rawAfters  = afterList.slice(0, 3);          // 最近的3班（時間較晚）
  const rawExact   = exactList.length > 0 ? exactList[0] : null;

  // 補查即時延誤
  const allRaw = [...rawBefores, rawExact, ...rawAfters];
  const allEnriched = await enrichWithDelay(allRaw, dateStr, fromId);

  const enrichedBefores = allEnriched.slice(0, rawBefores.length);
  const enrichedExact   = allEnriched[rawBefores.length];
  const enrichedAfters  = allEnriched.slice(rawBefores.length + 1);

  const candidates = [];
  enrichedBefores.forEach((t, i) => { if (t) candidates.push({ key: `before${i}`, train: t, isBefore: true }); });
  if (enrichedExact) candidates.push({ key: 'exact', train: enrichedExact, isExact: true });
  enrichedAfters.forEach((t, i)  => { if (t) candidates.push({ key: `after${i}`,  train: t, isAfter: true  }); });

  // 推薦：優先 exact，其次最近的 after，其次最近的 before
  let recommended = null;
  if (enrichedExact)            recommended = 'exact';
  else if (enrichedAfters[0])   recommended = 'after0';
  else if (enrichedBefores.length > 0) recommended = `before${enrichedBefores.length - 1}`;

  return { mode: rawExact ? 'exact' : 'between', candidates, recommended };
}

// ── 查詢台鐵即時延誤（給已選定車次用）──
async function queryTRADelay(fromStation, toStation, targetTime, queryDate, trainNo) {
  const fromId = TRA_STATION_MAP[fromStation];
  const toId   = TRA_STATION_MAP[toStation];
  if (!fromId || !toId) throw new Error(`找不到站代碼: ${fromStation} 或 ${toStation}`);

  const dateStr = queryDate || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const trains  = await fetchSortedTrains(fromId, toId, dateStr);
  const targetMins = toMins(targetTime);

  let best = null;
  if (trainNo) best = trains.find(t => sameTrainNo(t.trainNo, trainNo));
  if (!best)   best = trains.find(t => t.depMins === targetMins);
  if (!best)   best = trains.find(t => t.depMins >= targetMins);
  if (!best && trains.length > 0) best = trains[trains.length - 1];

  if (!best) {
    return { trainNo: trainNo || '未知', delayMinutes: null, liveAvailable: false, status: 'normal', departTime: targetTime, trainType: '自強號' };
  }

  let delayMins = null, liveAvailable = false;
  try {
    const result = await fetchTrainDelay(best.trainNo, fromId);
    if (result !== null) { delayMins = result.delayMins; liveAvailable = true; }
  } catch(e) {}

  let status = 'normal';
  if (liveAvailable && delayMins !== null) {
    if (delayMins >= 16) status = 'high';
    else if (delayMins >= 1) status = 'warning';
  }

  return { trainNo: best.trainNo, trainType: best.trainType, delayMinutes: delayMins, liveAvailable, status, departTime: best.departTime };
}

// ── 高鐵替代班次 ──
async function queryTHSRAlternatives(fromStation, toStation, afterTime, queryDate) {
  const fromId = THSR_STATION_MAP[fromStation];
  const toId   = THSR_STATION_MAP[toStation];
  if (!fromId || !toId) return [];

  const dateStr = queryDate || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const thsrUrl = `${TDX_THSR_V2}/DailyTimetable/OD/${fromId}/to/${toId}/${dateStr}?$format=JSON&$top=200`;
  const data    = await tdxGet(thsrUrl);
  const trains  = data.TrainTimetables || (Array.isArray(data) ? data : []);
  const afterMins = toMins(afterTime);

  return trains.map(t => {
    const depStop = (t.StopTimes || []).find(s => String(s.StationID) === fromId);
    const arrStop = (t.StopTimes || []).find(s => String(s.StationID) === toId);
    if (!depStop || !arrStop) return null;
    const depTime = toHHmm(depStop.DepartureTime || depStop.ScheduledDepartureTime || '');
    const arrTime = toHHmm(arrStop.ArrivalTime   || arrStop.ScheduledArrivalTime   || '');
    const depM    = toMins(depTime);
    return { trainNo: t.TrainNo || '', departTime: depTime, arrivalTime: arrTime, depMins: depM };
  }).filter(t => t && t.depMins > afterMins).sort((a, b) => a.depMins - b.depMins).slice(0, 2);
}

// ── 建立替代方案建議 ──
async function buildSuggestions(from, to, time, queryDate, delayMins) {
  const suggestions = [];
  if (THSR_STATIONS.has(from) && THSR_STATIONS.has(to)) {
    try {
      const alts = await queryTHSRAlternatives(from, to, time, queryDate);
      if (alts.length > 0) {
        suggestions.push({ type: 'best', icon: '⚡', label: '最佳方案', action: `改搭高鐵 ${alts[0].departTime} 班次`, detail: `預計 ${alts[0].arrivalTime} 抵達` });
        if (alts.length > 1)
          suggestions.push({ type: 'alt', icon: '🔄', label: '替代方案', action: `改搭高鐵 ${alts[1].departTime} 班次`, detail: `預計 ${alts[1].arrivalTime} 抵達` });
      }
    } catch(e) {}
  }
  if (suggestions.length === 0) {
    const newDep = addMinutes(time, delayMins + 10);
    suggestions.push(
      { type: 'best', icon: '⚡', label: '最佳方案', action: `延後出發至 ${newDep}`, detail: '可避開延誤影響' },
      { type: 'alt',  icon: '🔄', label: '替代方案', action: '改搭客運或其他交通工具', detail: '可避免等候延誤班次' }
    );
  }
  return suggestions;
}

// ── Demo 行程處理 ──
async function analyzeDemoTrip(trip) {
  const queryDate = trip.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  let realResult;
  try {
    realResult = await queryTRADelay(trip.from, trip.to, trip.time, queryDate, trip.trainNo);
  } catch(e) {
    realResult = { trainNo: trip.trainNo || '未知', trainType: '自強號', departTime: trip.time, delayMinutes: 0, status: 'normal' };
  }

  let delayMinutes, status;
  if (trip.id === 'demo-green') {
    delayMinutes = 0; status = 'normal';
  } else if (trip.id === 'demo-yellow') {
    delayMinutes = Math.max(realResult.delayMinutes || 0, 5 + Math.floor(Math.random() * 6));
    status = 'warning';
  } else {
    delayMinutes = Math.max(realResult.delayMinutes || 0, 20 + Math.floor(Math.random() * 10));
    status = 'high';
  }

  const result = { trainNo: realResult.trainNo, trainType: realResult.trainType, departTime: realResult.departTime, delayMinutes, liveAvailable: true, risk: status, alert: null };
  if (status !== 'normal') {
    const suggestions = await buildSuggestions(trip.from, trip.to, trip.time, queryDate, delayMinutes);
    result.alert = { title: status === 'high' ? '高風險預警' : '列車延誤預警', reason: `${result.trainType} ${result.trainNo} 次｜列車延誤 ${delayMinutes} 分鐘，請考慮以下替代方案。`, suggestions };
  }
  return result;
}

// ── 主查詢函式 ──
async function analyzeTrip(tripData) {
  if (['demo-green','demo-yellow','demo-red'].includes(tripData.id)) {
    return analyzeDemoTrip(tripData);
  }
  const { from, to, time, trainNo } = tripData;
  const queryDate = tripData.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const traResult = await queryTRADelay(from, to, time, queryDate, trainNo);

  const result = { trainNo: traResult.trainNo, trainType: traResult.trainType, departTime: traResult.departTime, delayMinutes: traResult.delayMinutes, liveAvailable: traResult.liveAvailable, risk: traResult.status, alert: null };
  if (traResult.status !== 'normal') {
    const suggestions = await buildSuggestions(from, to, time, queryDate, traResult.delayMinutes);
    result.alert = { title: traResult.status === 'high' ? '高風險預警' : '列車延誤預警', reason: `${result.trainType} ${result.trainNo} 次｜列車延誤 ${traResult.delayMinutes} 分鐘，請考慮以下替代方案。`, suggestions };
  }
  return result;
}

function addMinutes(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const total  = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

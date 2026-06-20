// ===========================
// RailGuard AI — Shared Nav
// ===========================

function renderNav(activePage) {
  const unread = getUnreadCount();
  const badgeHtml = unread > 0 ? `<span class="notif-badge">${unread}</span>` : '';

  const topNav = `
  <nav class="top-nav">
    <div class="brand">
      <div class="brand-logo">R</div>
      <div class="brand-name">Rail<span>Guard</span> AI</div>
    </div>
    <div class="top-nav-right">
      <button class="reset-data-btn" id="reset-data-btn">重設資料</button>
      <div class="user-menu-wrap">
        <button class="user-menu-btn" id="user-menu-btn">
          <div class="user-avatar">王</div>
          王小明 ▾
        </button>
        <div class="user-dropdown" id="user-dropdown">
          <a href="settings.html">⚙️ 設定</a>
          <div class="divider"></div>
          <button class="logout-btn" id="logout-btn">🚪 登出</button>
        </div>
      </div>
    </div>
  </nav>`;

  const bottomNav = `
  <nav class="bottom-nav">
    <a href="home.html" class="${activePage==='home'?'active':''}">
      <span class="nav-icon">🏠</span>首頁
    </a>
    <a href="trips.html" class="${activePage==='trips'?'active':''}">
      <span class="nav-icon">🗓️</span>我的行程
    </a>
    <a href="notifications.html" class="${activePage==='notifications'?'active':''}">
      <span class="nav-icon">🔔</span>通知中心
      ${badgeHtml}
    </a>
    <a href="add-trip.html" class="${activePage==='add-trip'?'active':''}">
      <span class="nav-icon">➕</span>新增行程
    </a>
  </nav>`;

  document.body.insertAdjacentHTML('afterbegin', topNav);
  document.body.insertAdjacentHTML('beforeend', bottomNav);

  // User menu toggle
  const btn = document.getElementById('user-menu-btn');
  const dropdown = document.getElementById('user-dropdown');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => dropdown.classList.remove('open'));

  document.getElementById('logout-btn').addEventListener('click', logout);

  // Reset data button — direct reset, no confirm
  document.getElementById('reset-data-btn').addEventListener('click', () => {
    resetToDefaults();
    showToast('✅ 已重設資料，恢復預設三筆行程', 'success');
    setTimeout(() => {
      window.location.href = 'home.html';
    }, 1200);
  });

  // 啟動全站共用的即時監控（延誤輪詢 + 即時通知）
  startLiveMonitor();
}

// ===========================
// 即時監控（所有已登入頁面共用）
// 每 30 秒輪詢今日行程的即時延誤狀態：
// - 同一輪次內，相同出發站只查一次 StationLiveBoard（避免重複呼叫造成 TDX 限流不穩）
// - API 請求失敗時保留原狀，下一輪再試（不會把「查詢失敗」誤判成「查無資料」）
// - 風險等級變化（含恢復準點）時，立即跳出右下角 toast 通知，不需手動刷新
// ===========================
const TDX_TRA_V3_LIVE  = 'https://tdx.transportdata.tw/api/basic/v3/Rail/TRA';
const PROXY_BASE_LIVE  = 'http://localhost:3000/api/tdx?url=';

const TRA_STATION_MAP_LIVE = {
  '南港':'0900','台北':'1000','板橋':'1020','桃園':'1110',
  '中壢':'1120','新竹':'1220','苗栗':'1310','台中':'2200',
  '彰化':'2410','斗六':'2520','嘉義':'2610','台南':'2720','左營':'3300'
};
const THSR_STATION_MAP_LIVE = {
  '南港':'NAK','台北':'TPE','板橋':'BAN','桃園':'TYN',
  '新竹':'HSD','苗栗':'MQL','台中':'TXG','彰化':'CHH',
  '斗六':'YLH','嘉義':'CHY','台南':'TNN','左營':'ZUO'
};
const THSR_STATIONS_LIVE = new Set(Object.keys(THSR_STATION_MAP_LIVE));

function twTodayLive() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// 比對車次代碼是否相同（容忍不同 API 回傳格式：字串/數字/前導零差異）
function sameTrainNoLive(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a).trim() === String(b).trim();
}

function addMinsLive(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

// 取得某站的 StationLiveBoard，並在同一輪次內快取（多筆行程同站只查一次）
function fetchStationLiveBoardLive(stationId, cache) {
  if (cache.has(stationId)) return cache.get(stationId);
  const promise = (async () => {
    try {
      const url  = PROXY_BASE_LIVE + encodeURIComponent(`${TDX_TRA_V3_LIVE}/StationLiveBoard/Station/${stationId}?$format=JSON`);
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        return { ok: true, list: data.StationLiveBoards || [] };
      }
    } catch(e) {}
    return { ok: false, list: [] };
  })();
  cache.set(stationId, promise);
  return promise;
}

// 查延誤：優先 StationLiveBoard（同輪次共用快取），fallback TrainLiveBoard
// 回傳 { ok, delayMins }
//   ok=false        → API 請求暫時失敗（不穩定/限流），呼叫端應保留原狀，下一輪重試
//   ok=true,  null  → 兩個 API 都成功查詢，但目前查無此車次（尚未更新）
//   ok=true,  數字  → 已取得即時延誤分鐘數（0=準點）
async function pollFetchDelayLive(trainNo, fromStationId, cache) {
  let stationOk = false;
  if (fromStationId) {
    const board = await fetchStationLiveBoardLive(fromStationId, cache);
    if (board.ok) {
      stationOk = true;
      const live = board.list.find(l => sameTrainNoLive(l.TrainNo, trainNo));
      if (live) return { ok: true, delayMins: live.DelayTime || 0 };
    }
  }
  try {
    const url  = PROXY_BASE_LIVE + encodeURIComponent(`${TDX_TRA_V3_LIVE}/TrainLiveBoard/TrainNo/${trainNo}?$format=JSON`);
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      const arr  = data.TrainLiveBoards || [];
      if (arr.length > 0) {
        const live = arr.find(l => sameTrainNoLive(l.TrainNo, trainNo)) || arr[0];
        return { ok: true, delayMins: live.DelayTime || 0 };
      }
      return { ok: true, delayMins: null };
    }
    // TrainLiveBoard 請求失敗：若 StationLiveBoard 已成功查過（只是查無此車次），仍視為「尚未更新」
    return { ok: stationOk, delayMins: null };
  } catch(e) {
    return { ok: stationOk, delayMins: null };
  }
}

// 查高鐵替代班次
async function pollFetchTHSRLive(from, to, afterTime) {
  const fromId = THSR_STATION_MAP_LIVE[from];
  const toId   = THSR_STATION_MAP_LIVE[to];
  if (!fromId || !toId) return [];
  try {
    const dateStr = twTodayLive();
    const url = PROXY_BASE_LIVE + encodeURIComponent(
      `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/DailyTimetable/OD/${fromId}/to/${toId}/${dateStr}?$format=JSON&$top=200`
    );
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    const trains = data.TrainTimetables || [];
    const afterMins = afterTime.split(':').reduce((h, m, i) => i === 0 ? +m * 60 : h + +m, 0);
    return trains
      .map(t => {
        const dep = (t.StopTimes || []).find(s => String(s.StationID) === fromId);
        const arr = (t.StopTimes || []).find(s => String(s.StationID) === toId);
        if (!dep || !arr) return null;
        const depTime = (dep.DepartureTime || dep.ScheduledDepartureTime || '').slice(0, 5);
        const arrTime = (arr.ArrivalTime   || arr.ScheduledArrivalTime   || '').slice(0, 5);
        const depMins = depTime.split(':').reduce((h, m, i) => i === 0 ? +m * 60 : h + +m, 0);
        return { depTime, arrTime, depMins };
      })
      .filter(t => t && t.depMins > afterMins)
      .sort((a, b) => a.depMins - b.depMins)
      .slice(0, 2);
  } catch(e) { return []; }
}

// 用今天班表確認固定行程的車次號碼（每天第一次輪詢時執行）
async function confirmTodayTrainNoLive(t, todayStr) {
  const fromId = TRA_STATION_MAP_LIVE[t.from];
  const toId   = TRA_STATION_MAP_LIVE[t.to];
  if (!fromId || !toId) return t.trainNo;
  try {
    const url  = PROXY_BASE_LIVE + encodeURIComponent(
      `${TDX_TRA_V3_LIVE}/DailyTrainTimetable/OD/${fromId}/to/${toId}/${todayStr}?$format=JSON&$top=200`
    );
    const resp = await fetch(url);
    if (!resp.ok) return t.trainNo;
    const data   = await resp.json();
    const trains = data.TrainTimetables || [];

    const normalize = id => String(id).replace(/^0+/, '').padStart(4, '0');
    const fromNorm  = normalize(fromId);
    const targetMins = t.time.split(':').reduce((h, m, i) => i === 0 ? +m * 60 : h + +m, 0);

    let best = null, bestDiff = Infinity;
    for (const raw of trains) {
      const stops = raw.StopTimes || [];
      const depStop = stops.find(s => normalize(s.StationID) === fromNorm);
      if (!depStop) continue;
      const depTimeStr = (depStop.ScheduledDepartureTime || depStop.DepartureTime || depStop.ScheduledArrivalTime || depStop.ArrivalTime || '').slice(0, 5);
      if (!depTimeStr) continue;
      const depMins = depTimeStr.split(':').reduce((h, m, i) => i === 0 ? +m * 60 : h + +m, 0);
      const diff = Math.abs(depMins - targetMins);
      if (diff < bestDiff) {
        bestDiff = diff;
        const ti = raw.TrainInfo || raw;
        best = { trainNo: String(ti.TrainNo || raw.TrainNo || ''), depTime: depTimeStr };
      }
    }
    if (best && bestDiff === 0) return best.trainNo;
  } catch(e) {}
  return t.trainNo;
}

// 更新導覽列「通知中心」未讀數字徽章
function refreshNotifBadgeLive() {
  const count = getUnreadCount();
  const navNotif = document.querySelector('.bottom-nav a[href*="notifications"]');
  if (!navNotif) return;
  let badge = navNotif.querySelector('.notif-badge');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'notif-badge';
      navNotif.appendChild(badge);
    }
    badge.textContent = count;
  } else if (badge) {
    badge.remove();
  }
}

// ===========================
// 監控更新頻率（依距離發車時間遠近分三段）：
//   距發車 > 60 分鐘：每 30 分鐘更新一次
//   距發車 30~60 分鐘：每 10 分鐘更新一次
//   距發車 < 30 分鐘：每 2 分鐘更新一次
// 已發車（負值）之後仍以最高頻率（2 分鐘）持續追蹤，直到行程被清除或離站過久
// ===========================
function pollIntervalMsFor(minutesToDeparture) {
  if (minutesToDeparture > 60) return 30 * 60000;
  if (minutesToDeparture > 30) return 10 * 60000;
  return 2 * 60000;
}
// nextDepartureMs() 由 js/storage.js 提供共用實作（修正時區計算誤差，storage.js 一定先載入）

// 每個行程上次實際輪詢（呼叫 TDX）的時間戳，存在記憶體即可（重新整理頁面後第一輪會重新查一次）
const __rgLastPolled = new Map();

function shouldPollNow(t) {
  const depMs = nextDepartureMs(t);
  if (depMs === Infinity) return true; // 抓不到發車時間時，保守地每輪都查
  const minutesToDeparture = (depMs - Date.now()) / 60000;
  const interval = pollIntervalMsFor(minutesToDeparture);
  const last = __rgLastPolled.get(t.id) || 0;
  return (Date.now() - last) >= interval;
}

async function pollLiveMonitor() {
  // 先清除已到期的單次行程（發車時間+緩衝已過）
  const pruned = pruneExpiredSingleTrips();

  const todayStr = twTodayLive();
  const todayDay = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];
  const trips    = getTrips();

  const todayTrips = trips.filter(t => {
    if (t.type === 'single')    return t.date === todayStr;
    if (t.type === 'recurring') return t.days && t.days.includes(todayDay);
    return false;
  }).filter(shouldPollNow);

  if (todayTrips.length === 0) {
    if (pruned) document.dispatchEvent(new CustomEvent('railguard:trips-updated'));
    return;
  }

  const liveCache = new Map(); // 同一輪次內共用，相同出發站只查一次
  let changed = false;
  const pushNotifEnabled = getSettings().pushNotif !== false;

  await Promise.all(todayTrips.map(async t => {
    __rgLastPolled.set(t.id, Date.now());
    if (!t.trainNo) return;

    let trainNo   = t.trainNo;
    let trainType = t.trainType;
    if (t.type === 'recurring' && t.lastConfirmedDate !== todayStr) {
      const confirmedNo = await confirmTodayTrainNoLive(t, todayStr);
      if (confirmedNo && confirmedNo !== t.trainNo) {
        trainNo = confirmedNo;
        updateTrip(t.id, { trainNo, lastConfirmedDate: todayStr });
        changed = true;
      } else {
        updateTrip(t.id, { lastConfirmedDate: todayStr });
      }
    }

    const fromId = TRA_STATION_MAP_LIVE[t.from];
    const result = await pollFetchDelayLive(trainNo, fromId, liveCache);
    if (!result.ok) return; // 查詢暫時失敗（不穩定），保留原狀，下一輪再試

    const delayMins = result.delayMins; // number 或 null（尚未更新）

    let newRisk = t.risk;
    if (delayMins !== null) {
      newRisk = 'normal';
      if (delayMins >= 16) newRisk = 'high';
      else if (delayMins >= 1) newRisk = 'warning';
    }

    const liveChanged = (t.delayMins ?? null) !== delayMins || t.liveAvailable !== true || trainNo !== t.trainNo;
    const riskChanged = delayMins !== null && t.risk !== newRisk;

    if (!riskChanged && !liveChanged) return;

    let alert = t.alert || null;
    let suggestions = [];
    if (riskChanged) {
      if (newRisk !== 'normal') {
        if (THSR_STATIONS_LIVE.has(t.from) && THSR_STATIONS_LIVE.has(t.to)) {
          const alts = await pollFetchTHSRLive(t.from, t.to, t.time);
          if (alts.length > 0) {
            suggestions.push({ type:'best', icon:'⚡', label:'最佳方案', action:`改搭高鐵 ${alts[0].depTime} 班次`, detail:`預計 ${alts[0].arrTime} 抵達` });
            if (alts.length > 1)
              suggestions.push({ type:'alt', icon:'🔄', label:'替代方案', action:`改搭高鐵 ${alts[1].depTime} 班次`, detail:`預計 ${alts[1].arrTime} 抵達` });
          }
        }
        if (suggestions.length === 0) {
          const newDep = addMinsLive(t.time, delayMins + 10);
          suggestions.push(
            { type:'best', icon:'⚡', label:'最佳方案', action:`延後出發至 ${newDep}`, detail:'可避開延誤影響' },
            { type:'alt',  icon:'🔄', label:'替代方案', action:'改搭客運或其他交通工具', detail:'可避免等候延誤班次' }
          );
        }
        alert = {
          title:  newRisk === 'high' ? '高風險預警' : '列車延誤預警',
          reason: `${trainType || ''} ${trainNo} 次｜列車延誤 ${delayMins} 分鐘，請考慮以下替代方案。`,
          suggestions
        };
      } else {
        alert = null; // 恢復準時，清除舊 alert
      }
    }

    updateTrip(t.id, {
      trainNo, trainType, delayMins, liveAvailable: true,
      risk: newRisk, alert
    });
    changed = true;

    if (!riskChanged) return;

    const routeText = `${t.from} → ${t.to}`;
    const trainText = `${trainType || ''} ${trainNo} 次`;

    // ── 立即跳出右下角 toast 通知（不需刷新頁面）──
    if (pushNotifEnabled) {
      if (newRisk === 'normal') {
        showToast(`🟢 已恢復準點：${routeText}｜${trainText}`, 'success');
      } else {
        const icon = newRisk === 'high' ? '🔴' : '🟡';
        showToast(`${icon} 列車延誤 ${delayMins} 分：${routeText}｜${trainText}`, newRisk === 'high' ? 'error' : '');
      }
    }

    // ── 寫入通知中心 ──
    const notifs = getNotifications();
    if (newRisk === 'normal') {
      notifs.unshift({
        id:     'notif-ok-' + Date.now(),
        tripId: t.id,
        type:   'normal',
        title:  '🟢 列車已恢復準時',
        body:   `${routeText}｜${trainText} 已準點行駛`,
        time:   new Date().toISOString(),
        read:   false
      });
    } else {
      const already = notifs.find(n => n.tripId === t.id && n.type === newRisk && !n.read);
      if (!already) {
        const riskTitle = newRisk === 'high' ? '🔴 高風險預警' : '🟡 延誤預警';
        notifs.unshift({
          id:     'notif-poll-' + Date.now(),
          tripId: t.id,
          type:   newRisk,
          title:  riskTitle,
          body:   `${routeText}｜${trainText} 延誤 ${delayMins} 分鐘`,
          time:   new Date().toISOString(),
          read:   false
        });
        if (suggestions.length > 0) {
          notifs.unshift({
            id:     'notif-ai-' + Date.now(),
            tripId: t.id,
            type:   'ai',
            title:  '✨ AI 替代方案已產生',
            body:   `${routeText}｜${suggestions[0].action}`,
            time:   new Date(Date.now() - 1000).toISOString(),
            read:   false
          });
        }
      }
    }
    saveNotifications(notifs);
    refreshNotifBadgeLive();
  }));

  if (changed || pruned) {
    // 通知目前頁面（trips.html / home.html 等）重新渲染
    document.dispatchEvent(new CustomEvent('railguard:trips-updated'));
  }
}

function startLiveMonitor() {
  if (window.__rgLiveMonitorStarted) return;
  window.__rgLiveMonitorStarted = true;
  pollLiveMonitor();
  // 每 1 分鐘檢查一次；每筆行程是否真正觸發 TDX 查詢由 shouldPollNow() 依其
  // 距發車時間遠近的三段頻率（30/10/2 分鐘）決定，避免不必要的 API 請求
  setInterval(pollLiveMonitor, 60000);
}

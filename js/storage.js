// ===========================
// RailGuard AI — Storage Layer
// ===========================

const STORAGE_KEY_TRIPS    = 'railguard_trips';
const STORAGE_KEY_NOTIFS   = 'railguard_notifications';
const STORAGE_KEY_SETTINGS = 'railguard_settings';
const STORAGE_KEY_INITED   = 'railguard_initialized';

const DEFAULT_TRIPS = [];

const DEFAULT_NOTIFICATIONS = [];

const DEFAULT_SETTINGS = {
  pushNotif: true,
  emailNotif: false,
  smsNotif: false,
  alertAdvance: '30',
  language: 'zh-TW'
};

const STORAGE_VERSION = '6'; // v6: 移除假資料，重設只清空行程與通知

function initStorage() {
  if (localStorage.getItem(STORAGE_KEY_INITED) !== STORAGE_VERSION) {
    // 升版：清空行程與通知，保留設定
    localStorage.setItem(STORAGE_KEY_TRIPS,  JSON.stringify([]));
    localStorage.setItem(STORAGE_KEY_NOTIFS, JSON.stringify([]));
    if (!localStorage.getItem(STORAGE_KEY_SETTINGS)) {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
    }
    localStorage.setItem(STORAGE_KEY_INITED, STORAGE_VERSION);
  }
}

function resetToDefaults() {
  localStorage.setItem(STORAGE_KEY_TRIPS,  JSON.stringify([]));
  localStorage.setItem(STORAGE_KEY_NOTIFS, JSON.stringify([]));
}

// ---- Trips ----
function getTrips() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TRIPS)) || []; }
  catch(e) { return []; }
}
function saveTrips(trips) {
  localStorage.setItem(STORAGE_KEY_TRIPS, JSON.stringify(trips));
}
function getTripById(id) {
  return getTrips().find(t => t.id === id) || null;
}
function addTrip(trip) {
  const trips = getTrips();
  trip.id = 'trip-' + Date.now();
  trip.risk = 'normal';
  trip.notificationSent = false;
  trip.alert = null;
  if (trip.delayMins === undefined) trip.delayMins = null;
  if (trip.liveAvailable === undefined) trip.liveAvailable = false;
  // trainNo / trainType / departTime 由呼叫端傳入，不強制清空
  if (trip.trainNo   === undefined) trip.trainNo   = null;
  if (trip.trainType === undefined) trip.trainType = null;
  if (trip.departTime=== undefined) trip.departTime = null;
  trips.push(trip);
  saveTrips(trips);
  return trip;
}
function updateTrip(id, data) {
  const trips = getTrips();
  const idx = trips.findIndex(t => t.id === id);
  if (idx !== -1) { trips[idx] = { ...trips[idx], ...data }; saveTrips(trips); }
}
// ---- 時間輔助：以「台灣時間（UTC+8）」為基準的日期/星期計算 ----
// 這些函式刻意不使用 setHours()/getHours()/getDay() 等「依賴主機所在時區」的 API，
// 一律改用明確的 +08:00 ISO 字串與 getUTCDay()/setUTCDate()，確保結果與主機時區設定無關，
// 不會出現「兩個時間基準不一致」造成的誤判（曾發生過：用 Date.now()+8h 算出的「現在」
// 去跟用 setHours() 算出的「發車時間」epoch 比較，兩者基準不同，誤差達數小時）。

// 今天的台灣日期字串 YYYY-MM-DD
function twTodayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
// 將 YYYY-MM-DD 字串往後推 n 天（以台灣時間為準），回傳新的 YYYY-MM-DD 字串
function twAddDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00+08:00');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// 取得 YYYY-MM-DD 字串對應的星期英文名稱（以台灣時間為準）
function twDayName(dateStr) {
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(dateStr + 'T00:00:00+08:00');
  return dayNames[d.getUTCDay()];
}
// 將「台灣時間」的 YYYY-MM-DD + HH:mm 轉換成真實的 epoch 毫秒（與主機時區無關）
function twDateTimeToMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return NaN;
  const [hh, mm] = timeStr.split(':');
  if (hh === undefined || mm === undefined) return NaN;
  return new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+08:00`).getTime();
}
// 計算行程「下一次發車」的真實 epoch 毫秒
// 單次行程：date + time；固定行程：今天若符合星期且未發車則為今天，否則找未來最近符合星期的日期
function nextDepartureMs(t) {
  if (!t.time) return Infinity;
  if (t.type === 'single') {
    if (!t.date) return Infinity;
    const ms = twDateTimeToMs(t.date, t.time);
    return isNaN(ms) ? Infinity : ms;
  }
  if (t.type === 'recurring') {
    if (!Array.isArray(t.days) || t.days.length === 0) return Infinity;
    const todayStr = twTodayStr();
    const nowMs = Date.now();
    for (let offset = 0; offset < 8; offset++) {
      const dateStr = twAddDays(todayStr, offset);
      if (!t.days.includes(twDayName(dateStr))) continue;
      const ms = twDateTimeToMs(dateStr, t.time);
      if (!isNaN(ms) && ms >= nowMs) return ms;
    }
    return Infinity;
  }
  return Infinity;
}
// 倒數／已過時間文字
function countdownText(depMs) {
  if (depMs === Infinity || isNaN(depMs)) return '';
  const diffMin = Math.round((depMs - Date.now()) / 60000);
  if (diffMin > 60 * 24) return `${Math.floor(diffMin / (60 * 24))} 天後發車`;
  if (diffMin > 60) return `${Math.floor(diffMin / 60)} 小時 ${diffMin % 60} 分後發車`;
  if (diffMin > 0) return `距離發車 ${diffMin} 分鐘`;
  if (diffMin === 0) return '即將發車';
  return '已發車';
}

function deleteTrip(id) {
  saveTrips(getTrips().filter(t => t.id !== id));
}

// ── 單次行程自動清除 ──
// 規則：僅限單次行程（type === 'single'）。
// 當「發車時間已過」或「列車已完成行駛」時，系統自動移除該行程。
// 簡化判定：以表定發車時間 + 預估行駛時間緩衝（3 小時，超過台鐵最長行駛時間）
// 作為「已完成行駛」的判斷基準。
// 修正記錄：先前版本用 Date.now()+8h 當「現在」、卻用真實 epoch 當「發車時間」比較，
// 兩者基準不一致，造成幾乎所有當天行程一建立就被誤判為已過期而刪除。
// 現在統一透過 twDateTimeToMs()／nextDepartureMs() 取得「真實 epoch」，並用 Date.now() 比較，基準一致。
const TRIP_COMPLETE_BUFFER_MS = 3 * 3600000; // 3 小時緩衝
function pruneExpiredSingleTrips() {
  const trips = getTrips();
  const nowMs = Date.now();
  const kept = trips.filter(t => {
    if (t.type !== 'single') return true; // 固定行程永久保留
    if (!t.date || !t.time) return true;
    const depMs = twDateTimeToMs(t.date, t.time);
    if (isNaN(depMs)) return true; // 解析失敗時保守保留，避免誤刪
    return nowMs < depMs + TRIP_COMPLETE_BUFFER_MS; // 尚未到期才保留
  });
  if (kept.length !== trips.length) {
    saveTrips(kept);
    return true; // 有清除動作
  }
  return false;
}

// ---- Notifications ----
function getNotifications() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_NOTIFS)) || []; }
  catch(e) { return []; }
}
function saveNotifications(notifs) {
  localStorage.setItem(STORAGE_KEY_NOTIFS, JSON.stringify(notifs));
}
function markNotifRead(id) {
  const notifs = getNotifications();
  const n = notifs.find(n => n.id === id);
  if (n) { n.read = true; saveNotifications(notifs); }
}
function markAllRead() {
  const notifs = getNotifications().map(n => ({ ...n, read: true }));
  saveNotifications(notifs);
}
function getUnreadCount() {
  return getNotifications().filter(n => !n.read).length;
}

// ---- Settings ----
function getSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS)) || DEFAULT_SETTINGS; }
  catch(e) { return DEFAULT_SETTINGS; }
}
function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(s));
}

// ---- Auth ----
function isLoggedIn() {
  return sessionStorage.getItem('railguard_user') === 'wang';
}
function login() {
  sessionStorage.setItem('railguard_user', 'wang');
}
function logout() {
  sessionStorage.removeItem('railguard_user');
  window.location.href = '../pages/login.html';
}
function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '../pages/login.html';
  }
}

// ---- Helpers ----
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function formatDays(days) {
  const map = { Monday:'一', Tuesday:'二', Wednesday:'三', Thursday:'四', Friday:'五', Saturday:'六', Sunday:'日' };
  const order = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const sorted = order.filter(d => days.includes(d));
  if (sorted.join(',') === 'Monday,Tuesday,Wednesday,Thursday,Friday') return '每週一至五';
  if (sorted.join(',') === 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday') return '每天';
  return sorted.map(d => '週' + map[d]).join('、');
}
function riskLabel(risk) {
  if (risk === 'high') return '🔴 高風險預警';
  if (risk === 'warning') return '🟡 延誤預警';
  return '🟢 正常監控';
}
function riskClass(risk) {
  if (risk === 'high') return 'high';
  if (risk === 'warning') return 'warning';
  return 'normal';
}
function riskBadgeClass(risk) {
  if (risk === 'high') return 'badge-high';
  if (risk === 'warning') return 'badge-warn';
  return 'badge-ok';
}
function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch(e) { return ''; }
}

// ---- Toast ----
function showToast(msg, type='') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ---- Confirm Modal ----
function showConfirm(message, onConfirm) {
  let overlay = document.getElementById('confirm-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'confirm-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:360px">
        <div class="modal-body" style="text-align:center;padding:var(--space-xl)">
          <div style="font-size:36px;margin-bottom:12px">🗑️</div>
          <h3 style="font-size:16px;font-weight:700;margin-bottom:8px">確認刪除</h3>
          <p id="confirm-msg" style="font-size:14px;color:var(--color-text-sub);margin-bottom:var(--space-lg)"></p>
          <div style="display:flex;gap:10px;justify-content:center">
            <button class="btn btn-secondary" id="confirm-cancel">取消</button>
            <button class="btn btn-danger" id="confirm-ok">確認刪除</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }
  document.getElementById('confirm-msg').textContent = message;
  overlay.classList.add('open');
  const cancelBtn = document.getElementById('confirm-cancel');
  const okBtn = document.getElementById('confirm-ok');
  const closeModal = () => overlay.classList.remove('open');
  cancelBtn.onclick = closeModal;
  okBtn.onclick = () => { closeModal(); onConfirm(); };
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
}

// Init on load
initStorage();
pruneExpiredSingleTrips();

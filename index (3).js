const mineflayer = require('mineflayer');
const express = require('express');
const { SocksClient } = require('socks');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Không cache Dashboard/API trên trình duyệt hoặc proxy.
// Mật khẩu đã lưu tuyệt đối không được đưa vào HTML hay API response.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use('/assets', express.static(require('path').join(__dirname, 'public', 'assets')));

// Ô mật khẩu luôn để trống; chỉ hiển thị trạng thái đã lưu, không trả mật khẩu ra trình duyệt.
app.use((req, res, next) => next());

// ÉP MÚI GIỜ VIỆT NAM TOÀN HỆ THỐNG
process.env.TZ = 'Asia/Ho_Chi_Minh';

let BOT_USERNAME = process.env.BOT_USERNAME || 'YunoBabybu';
let BOT_PASSWORD = process.env.BOT_PASSWORD || '';
let BOT_HOST = process.env.BOT_HOST || 'vangioinetwork.xyz';
let BOT_PORT = parseInt(process.env.BOT_PORT) || 25565;
let BOT_PROXY = process.env.BOT_PROXY || ''; // Định dạng: host:port hoặc user:pass@host:port (SOCKS5)

// Khôi phục cấu hình đã lưu để bot có thể tự kết nối sau khi tiến trình Render restart.
// Trên Render, dùng Persistent Disk hoặc Environment Variables để giữ cấu hình qua redeploy.
const BOT_CONFIG_FILE = path.join(__dirname, 'bot-config.json');
try {
  if (fs.existsSync(BOT_CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8'));
    if (!process.env.BOT_USERNAME && saved.username) BOT_USERNAME = saved.username;
    if (!process.env.BOT_PASSWORD && saved.password) BOT_PASSWORD = saved.password;
    if (!process.env.BOT_HOST && saved.host) BOT_HOST = saved.host;
    if (!process.env.BOT_PORT && saved.port) BOT_PORT = parseInt(saved.port) || BOT_PORT;
    if (!process.env.BOT_PROXY && typeof saved.proxy === 'string') BOT_PROXY = saved.proxy;
  }
} catch (err) {
  console.error('[CONFIG] Không đọc được bot-config.json:', err.message);
}


// --- BẬT/TẮT CÁC TÍNH NĂNG TOGGLE ---
const toggles = {
  afkmode: false,
  thien: false,
  quylay: false,
  dinhthan: false,
  quanghao: false,
  ngoi: false,     // Nút ngồi (Sneak)
  attackLeft: false,
  attackRight: false,
  skill1: false,
  skill2: false,
  skill3: false,
  fightingSkill1: false,
  fightingSkill2: false,
  fightingSkill3: false
};

// Cấu hình tốc độ click chuột (tối thiểu 0.1s = 100ms)
let attackLeftIntervalMs = 500;
let attackRightIntervalMs = 500;

// CẤU HÌNH Ô CÔNG CỤ (HOTBAR 1 -> 9 tương ứng Index 0 -> 8)
let hotbarEnabled = [false, false, false, false, false, false, false, false, false];
let hotbarHoldDurationSec = 5;
let currentHotbarCycleIndex = 0;

let bot = null;
let reconnectTimeout = null;
let isReconnecting = false;
let connectionAuthorized = Boolean(BOT_USERNAME && BOT_PASSWORD && BOT_HOST);
let isManualStopped = !connectionAuthorized;
let isFirstSpawn = true;

let currentReconnectDelay = 10000;
let consecutiveFailures = 0; 

// TIMERS & INTERVALS
let actionTimeout = null;
let antiAfkTimeout = null;
let ramGcInterval = null;
let posCheckInterval = null;
let watchdogInterval = null;
let pingInterval = null;
let loginTimer1 = null;
let loginTimer2 = null;
let respawnTimer = null;
let commandResponseTimer = null;
// Theo dõi phản hồi server về trạng thái Thiền để tự bật lại khi bị server hủy.
let lastThienReapplyAt = 0;
let thienReapplyTimer = null;

let quylayInterval = null;
let ngoiInterval = null;
let thienInterval = null;
let attackLeftInterval = null;
let attackRightInterval = null;
let skillLoopInterval = null;
let fightingSkill1Interval = null;
let fightingSkill2Interval = null;
let fightingSkill3Interval = null;
let hotbarLoopInterval = null;

// Helpers dùng chung: các hàm này phải được khai báo trước khi createBot() chạy.
const managedTimeouts = new Set();

function managedTimeout(callback, delay) {
  const timer = setTimeout(() => {
    managedTimeouts.delete(timer);
    try {
      callback();
    } catch (err) {
      addErrorLog('Timer Error', err && err.message ? err.message : String(err));
    }
  }, delay);
  managedTimeouts.add(timer);
  return timer;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

let isAwaitingResponse = false;
let isAutoActionRunning = false;
let lastActionTime = Date.now();
let currentCoords = 'Đang xác định...';
let currentPosition = null;
let currentPing = 0;

const startTime = Date.now();
const serverChatLogs = [];
const errorLogs = [];    
const pingLogs = [];     
const botMentionLogs = [];

let lastTimeAge = 0;
let lastTimeAgeUpdate = Date.now();

function getVNTime() {
  return new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

function addChatLog(msg) {
  serverChatLogs.unshift(`[${getVNTime()}] ${msg}`);
  if (serverChatLogs.length > 30) serverChatLogs.pop();
}

function addErrorLog(type, details) {
  errorLogs.unshift({ time: getVNTime(), type: type, details: details });
  if (errorLogs.length > 30) errorLogs.pop();
}

function addPingLog(pingVal) {
  pingLogs.unshift({ time: getVNTime(), ping: pingVal });
  if (pingLogs.length > 15) pingLogs.pop();
}

function addBotMentionLog(msg) {
  botMentionLogs.unshift({ time: getVNTime(), text: msg });
  if (botMentionLogs.length > 20) botMentionLogs.pop();
}

function triggerChatWindow(durationMs = 8000) {
  isAwaitingResponse = true;
  if (commandResponseTimer) clearTimeout(commandResponseTimer);
  commandResponseTimer = managedTimeout(() => { isAwaitingResponse = false; }, durationMs);
}

function updateCurrentPosition() {
  if (!bot || !bot.entity || !bot.entity.position) return;
  const pos = bot.entity.position;
  const raw = [pos.x, pos.y, pos.z].map(Number);
  if (!raw.every(Number.isFinite)) return;
  const [x, y, z] = raw.map(value => Number(value.toFixed(1)));
  currentPosition = { x, y, z };
  currentCoords = `X: ${x.toFixed(1)}, Y: ${y.toFixed(1)}, Z: ${z.toFixed(1)}`;
}

function getHeldItemName() {
  if (!bot || !bot.heldItem) return 'Tay không';
  const item = bot.heldItem;
  return item.customName || item.displayName || item.name || 'Vật phẩm không tên';
}

function safeChat(msg) {
  if (bot && bot.entity && bot._client && bot._client.state === 'play' && !isManualStopped) {
    try {
      bot.chat(msg);
      addChatLog(`[TỰ ĐỘNG]: ${msg}`);
    } catch (e) {
      addErrorLog('Lỗi Chat', e.message);
    }
  }
}

app.get('/api/ping', (req, res) => res.send('PONG_OK'));

app.get('/api/status', (req, res) => {
  const online = !!(bot && bot._client && bot._client.state === 'play' && !isManualStopped);
  res.json({
    online, manualStopped: isManualStopped, username: BOT_USERNAME,
    host: BOT_HOST, port: BOT_PORT, proxy: BOT_PROXY ? 'Đang dùng Proxy' : 'Kết nối trực tiếp',
    ping: currentPing, coords: currentCoords, position: currentPosition, heldItem: getHeldItemName(),
    uptimeMinutes: Math.floor((Date.now() - startTime) / 60000),
    ramMb: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
    toggles, chat: serverChatLogs.slice(0, 30), errors: errorLogs.slice(0, 30),
    mentions: botMentionLogs.slice(0, 20), pingLogs: pingLogs.slice(0, 15)
  });
});

// ENDPOINT CẬP NHẬT CẤU HÌNH (USERNAME, PASSWORD, HOST, PROXY)
app.post('/api/update-config', (req, res) => {
  try {
    const { username, password, host, proxy } = req.body;
    
    if (username !== undefined && username.trim() !== '') BOT_USERNAME = username.trim();
    if (typeof password === 'string' && password.trim() !== '') BOT_PASSWORD = password.trim();
    if (proxy !== undefined) BOT_PROXY = proxy.trim();
    
    if (host !== undefined && host.trim() !== '') {
      let cleanHost = host.trim();
      if (cleanHost.includes(':')) {
        const parts = cleanHost.split(':');
        BOT_HOST = parts[0];
        BOT_PORT = parseInt(parts[1]) || 25565;
      } else {
        BOT_HOST = cleanHost;
        BOT_PORT = 25565;
      }
    }

    // Lưu cấu hình để tự khôi phục sau khi Render restart.
    try {
      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify({
        username: BOT_USERNAME, password: BOT_PASSWORD,
        host: BOT_HOST, port: BOT_PORT, proxy: BOT_PROXY
      }, null, 2), { mode: 0o600 });
    } catch (saveErr) {
      addErrorLog('LỖI LƯU CẤU HÌNH', saveErr.message);
    }

    addErrorLog('CẤU HÌNH', `Đã lưu cấu hình Bot [${escapeHtml(BOT_USERNAME)}]. Đang bắt đầu kết nối theo yêu cầu...`);
    consecutiveFailures = 0;
    currentReconnectDelay = 10000;
    isManualStopped = false;
    connectionAuthorized = true;
    createBot();
  } catch (err) {
    addErrorLog('Lỗi Lưu Cấu Hình', err.message);
  }
  res.redirect('/');
});

app.post('/api/command', (req, res) => {
  if (isManualStopped) return res.send('Bot đang ở trạng thái TẮT thủ công!');
  const cmd = req.body.command;
  if (!bot || !bot._client) return res.send('Bot đang ngoại tuyến!');
  if (cmd) {
    const safeCommand = String(cmd).slice(0, 256);
    try {
      bot.chat(safeCommand);
      addChatLog(`[WEB-ADMIN]: ${safeCommand}`);
      triggerChatWindow(8000);
    } catch (err) {
      addErrorLog('Lỗi gửi lệnh', err.message || String(err));
    }
  }
  res.redirect('/');
});

app.get('/api/toggle/:feature', (req, res) => {
  const feat = req.params.feature;
  if (toggles.hasOwnProperty(feat)) {
    toggles[feat] = !toggles[feat];
    addChatLog(`[CÀI ĐẶT] ${feat.toUpperCase()} ➔ ${toggles[feat] ? 'BẬT' : 'TẮT'}`);

    if (bot && bot.entity && bot._client && bot._client.state === 'play' && !isManualStopped) {
      if (feat === 'afkmode') safeChat(toggles[feat] ? '/afkmode vao' : '/afkmode ra');
      if (feat === 'thien') {
        if (thienReapplyTimer) { clearTimeout(thienReapplyTimer); thienReapplyTimer = null; }
        lastThienReapplyAt = 0;
        safeChat('/thien');
      }
      if (feat === 'ngoi' && !toggles.ngoi && bot) {
        try { bot.setControlState('sneak', false); } catch (e) {}
      }
      if (feat === 'quylay') safeChat('/quylay');
      if (feat === 'dinhthan') safeChat('/dinhthan');
      if (feat === 'quanghao') safeChat('/quanghao');
      if (feat === 'skill1') safeChat('/kinang_1');
      if (feat === 'skill2') safeChat('/kinang_2');
      if (feat === 'skill3') safeChat('/kinang_3');
      if (feat === 'fightingSkill1' && toggles.fightingSkill1) safeChat('/fightingskill_1');
      if (feat === 'fightingSkill2' && toggles.fightingSkill2) safeChat('/fightingskill_2');
      if (feat === 'fightingSkill3' && toggles.fightingSkill3) safeChat('/fightingskill_3');

      restartLoops();
    }
  }
  res.redirect('/');
});

app.post('/api/update-hotbar', (req, res) => {
  const duration = parseInt(req.body.duration);
  if (!isNaN(duration) && duration >= 1) hotbarHoldDurationSec = duration;

  for (let i = 0; i < 9; i++) {
    hotbarEnabled[i] = req.body[`slot_${i}`] === 'on';
  }

  addChatLog(`[HOTBAR] Cập nhật danh sách ô cầm vật phẩm (${escapeHtml(hotbarHoldDurationSec)}s)`);
  restartLoops();
  res.redirect('/');
});

app.post('/api/update-click-speed', (req, res) => {
  const leftSpeed = parseFloat(req.body.leftSpeed);
  const rightSpeed = parseFloat(req.body.rightSpeed);

  if (!isNaN(leftSpeed) && leftSpeed >= 0.1) attackLeftIntervalMs = Math.round(leftSpeed * 1000);
  if (!isNaN(rightSpeed) && rightSpeed >= 0.1) attackRightIntervalMs = Math.round(rightSpeed * 1000);

  restartLoops();
  res.redirect('/');
});

app.post('/api/inventory', (req, res) => {
  if (bot && bot._client && !isManualStopped) {
    bot.chat('[inv]');
    addChatLog('[WEB-ADMIN]: [inv]');
    triggerChatWindow(4000);
  }
  res.redirect('/');
});

app.get('/api/tusat', (req, res) => {
  if (bot && bot._client && !isManualStopped) {
    safeChat('/tusat');
    triggerChatWindow(4000);
  }
  res.redirect('/');
});

app.get('/api/toggle-bot', (req, res) => {
  if (req.query.state === 'start') { isManualStopped = false; connectionAuthorized = Boolean(BOT_USERNAME && BOT_PASSWORD && BOT_HOST); }
  else if (req.query.state === 'stop') isManualStopped = true;
  else isManualStopped = !isManualStopped;
  if (isManualStopped) {
    addErrorLog('THỦ CÔNG', 'Đã TẮT Bot từ Dashboard. Ngắt kết nối.');
    cleanupBot();
  } else {
    addErrorLog('THỦ CÔNG', 'Đã BẬT lại Bot từ Dashboard. Đang kết nối lại...');
    consecutiveFailures = 0;
    createBot();
  }
  res.redirect('/');
});

app.get('/api/reconnect', (req, res) => { isManualStopped = false; connectionAuthorized = Boolean(BOT_USERNAME && BOT_PASSWORD && BOT_HOST); consecutiveFailures = 0; addErrorLog('DASHBOARD', 'Đang yêu cầu kết nối lại bot...'); createBot(); res.redirect('/'); });
app.get('/api/clear-error-log', (req, res) => { errorLogs.length = 0; res.redirect('/'); });
app.get('/api/clear-mention-log', (req, res) => { botMentionLogs.length = 0; res.redirect('/'); });
app.get('/api/hard-restart', (req, res) => { process.exit(1); });

app.get('/', (req, res) => {
  const online = !!(bot && bot._client && bot._client.state === 'play' && !isManualStopped);
  const uptimeMinutes = Math.floor((Date.now() - startTime) / 60000);
  const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const toggleButton = (key, label) => `<button class="feature ${toggles[key] ? 'active' : ''}" data-toggle="${key}"><span>${label}</span><b>${toggles[key] ? 'ĐANG BẬT' : 'ĐANG TẮT'}</b></button>`;
  res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Yuno Babybu | Minecraft Bot Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
  :root{--bg:#090719;--panel:#15102b;--panel2:#1d1440;--line:#7042c8;--purple:#9b5cff;--pink:#ec79ff;--text:#f7efff;--muted:#b8a9d4;--green:#24e58b;--red:#ff526f;--gold:#ffb84d}
  *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 75% -10%,#54218b66,transparent 42%),linear-gradient(135deg,#080617,#100a27 55%,#090719);color:var(--text);font-family:'Be Vietnam Pro',Arial,sans-serif;min-height:100vh}
  .layout{display:grid;grid-template-columns:245px 1fr;min-height:100vh}.sidebar{background:#100b25ed;border-right:1px solid #8b54d855;padding:24px 16px;display:flex;flex-direction:column;gap:12px;position:sticky;top:0;height:100vh}
  .brand{text-align:center;padding:12px 4px 26px}.brand .mascot{font-size:54px;filter:drop-shadow(0 0 15px #bb72ff)}.brand h1{font-size:25px;line-height:1.1;margin:6px 0;color:#d6a4ff;text-shadow:0 0 18px #9b5cff}.brand p{font-size:11px;color:var(--muted);margin:5px}
  .nav{width:100%;display:flex;align-items:center;gap:13px;padding:14px 15px;border:1px solid transparent;border-radius:14px;background:transparent;color:#d9c9f5;text-align:left;font:600 14px inherit;cursor:pointer}.nav:hover,.nav.selected{background:linear-gradient(100deg,#7b35e8,#a24af0);border-color:#d9a4ff;box-shadow:0 6px 22px #8b3be855;color:white}.nav span:first-child{font-size:20px;width:25px;text-align:center}.side-foot{margin-top:auto;text-align:center;color:#bfa9e6;font-size:12px;padding:16px;border-top:1px solid #7042c855}
  main{min-width:0;padding:22px 26px 40px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap}.pill{border:1px solid #7042c8;border-radius:30px;padding:9px 14px;background:#17102d;color:#d9c7fa;font-size:12px}.online-dot{color:var(--green);font-weight:800}.hero{border:1px solid #8146ce;border-radius:22px;padding:30px;background:radial-gradient(circle at 85% 40%,#963eea66,transparent 40%),linear-gradient(110deg,#241044,#17102e);box-shadow:0 10px 36px #6e36aa33;margin-bottom:18px;overflow:hidden}.hero h2{font-size:clamp(23px,3vw,36px);margin:0 0 8px}.hero p{color:#d5c0f4;margin:0}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:16px 0}.stat,.panel{background:linear-gradient(145deg,#1b1436,#100d24);border:1px solid #6840a7;border-radius:17px;padding:18px;box-shadow:0 8px 28px #0005}.stat{display:flex;gap:13px;align-items:center;min-width:0}.stat .ico{font-size:28px;color:#bd7bff}.stat small{display:block;color:var(--muted);font-size:11px}.stat strong{display:block;font-size:17px;margin-top:4px;overflow-wrap:anywhere}.columns{display:grid;grid-template-columns:1.2fr 1fr;gap:15px}.panel{margin-bottom:15px}.panel h3{margin:0 0 15px;font-size:16px}.muted{color:var(--muted);font-size:12px}.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.action,button.submit{border:1px solid #a76aff;border-radius:12px;padding:13px;color:white;font-weight:700;background:linear-gradient(120deg,#7135d8,#a33de0);cursor:pointer}.action.green{background:linear-gradient(120deg,#07985c,#20c879);border-color:#41e99b}.action.red{background:linear-gradient(120deg,#bb244b,#ef405e);border-color:#ff7b90}.action.gold{background:linear-gradient(120deg,#bd6a0b,#f4a321);border-color:#ffc66b}.action:hover,button.submit:hover{filter:brightness(1.15);transform:translateY(-1px)}
  .feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.feature{border:1px solid #60418d;border-radius:12px;padding:13px;background:#100c22;color:white;text-align:left;cursor:pointer}.feature b{display:block;font-size:10px;color:#ff879d;margin-top:6px}.feature.active{background:#34205d;border-color:#c18aff}.feature.active b{color:var(--green)}
  label{display:block;font-size:12px;color:#d7c8ee;margin:12px 0 6px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #64448e;background:#0b081a;color:white;outline:none}input:focus{border-color:#c18aff}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.slot-grid{display:grid;grid-template-columns:repeat(9,1fr);gap:7px}.slot{background:#100c22;border:1px solid #62448d;border-radius:10px;padding:9px 2px;text-align:center;font-size:11px}.slot input{width:auto;accent-color:#b46cff}.logs{height:250px;overflow:auto;background:#090615;border:1px solid #4c3374;border-radius:12px;padding:12px;font:12px/1.7 monospace;color:#d7c6f4;white-space:pre-wrap;overflow-wrap:anywhere}.hidden{display:none!important}.section-title{font-size:24px;margin:8px 0 18px}.statusline{font-size:12px;color:var(--muted);margin-top:12px}.toast{position:fixed;right:20px;bottom:20px;background:#2b1950;border:1px solid #bd80ff;padding:12px 18px;border-radius:12px;display:none;z-index:5}
  @media(max-width:1000px){.layout{grid-template-columns:190px 1fr}.grid{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}}
  @media(max-width:650px){.layout{display:block}.sidebar{position:static;height:auto;padding:12px;display:grid;grid-template-columns:repeat(5,1fr);gap:5px}.brand{grid-column:1/-1;padding:5px}.brand .mascot,.brand p,.side-foot{display:none}.brand h1{font-size:19px}.nav{justify-content:center;padding:10px 4px;font-size:10px;gap:4px;flex-direction:column}.nav span:first-child{font-size:17px}main{padding:14px}.hero{padding:22px}.grid{gap:8px}.stat{padding:12px;gap:8px}.stat .ico{font-size:20px}.stat strong{font-size:13px}.form-grid{grid-template-columns:1fr}.slot-grid{grid-template-columns:repeat(5,1fr)}}

  /* YUNO SAKURA NEON — visual refresh */
  :root{--bg:#08091f;--panel:#111333;--panel2:#191944;--line:#9864ff;--purple:#a45cff;--pink:#ff8be9;--text:#fff4ff;--muted:#c8b9ed;--green:#28efaa;--red:#ff587f;--gold:#ffc05c}
  html{scroll-behavior:smooth}body{background:radial-gradient(ellipse at 68% 0%,#5c2a9a55,transparent 38%),linear-gradient(135deg,#08091d,#100c2d 55%,#08091c);background-attachment:fixed}
  .layout{display:block;min-height:100vh}
  body:before{display:none}
  .sidebar{position:fixed;z-index:30;left:0;top:0;width:100%;height:96px;padding:12px 18px;background:linear-gradient(180deg,#0b0b24f5,#100d2eea);border:0;border-bottom:1px solid #a76aff77;display:flex;flex-direction:row;align-items:center;gap:0;box-shadow:0 8px 30px #03031399;backdrop-filter:blur(18px)}
  .brand{position:absolute;left:18px;top:8px;width:225px;padding:0;text-align:left}.brand .mascot{display:none}.brand h1{font-family:Georgia,serif;font-style:italic;font-size:30px;margin:0;color:#f4c5ff;text-shadow:0 0 12px #d46cff,0 0 26px #9d54ff}.brand p{font-size:11px;margin:1px 0;color:#eee0ff;letter-spacing:.5px}
  .sidebar .nav{position:relative;width:auto;flex:0 0 auto;margin-left:12px;padding:12px 18px;border:1px solid #9d6cff88;border-radius:28px;background:#11102ee8;box-shadow:0 0 14px #a35cff33;white-space:nowrap;font-size:13px;justify-content:center;gap:8px}
  .sidebar .brand+.nav{margin-left:255px}.sidebar .nav:hover,.sidebar .nav.selected{background:linear-gradient(110deg,#7939e9,#c14de9);box-shadow:0 0 22px #b66aff99;border-color:#e5b9ff}
  .side-foot{display:none}main{position:relative;z-index:1;margin-left:0;min-width:0;padding:112px 20px 34px}
  .topbar{position:fixed;z-index:35;top:22px;right:22px;margin:0;pointer-events:none}.topbar>*{pointer-events:auto}.pill{background:#11102feF;border-color:#b17affaa;box-shadow:0 0 16px #9b5cff33;color:#f3e7ff;padding:9px 15px}
  .hero{border:1px solid #c17affaa;border-radius:20px;padding:22px 26px;background:linear-gradient(105deg,#19163fee,#29144fe8 65%,#4b2370cc);box-shadow:0 0 25px #a14eff3d,inset 0 0 22px #a35cff12;margin-bottom:14px}
  .hero h2{font-size:clamp(24px,2.5vw,34px);text-shadow:0 0 18px #c17cff55}.hero p{color:#eadbff}
  .stat,.panel{background:linear-gradient(145deg,#171638ed,#0d1029f2);border:1px solid #a36aff99;border-radius:18px;box-shadow:0 0 18px #8d4eff25,inset 0 0 18px #b77aff0a;backdrop-filter:blur(10px)}
  .stat{padding:15px 16px}.stat .ico{filter:drop-shadow(0 0 8px #b76cff)}.stat strong{font-size:15px}.panel{padding:17px}.panel h3{font-size:16px;text-shadow:0 0 12px #c98cff33}
  .columns{grid-template-columns:minmax(0,1.25fr) minmax(280px,.9fr);gap:14px}.actions{gap:9px}.action,button.submit{border:1px solid #d7aaff;border-radius:12px;background:linear-gradient(115deg,#7538df,#b14be9);box-shadow:0 0 15px #a34eff44;transition:.18s ease}.action:hover,button.submit:hover{filter:brightness(1.2);transform:translateY(-2px);box-shadow:0 0 22px #c17aff77}.action.green{background:linear-gradient(110deg,#079b70,#21d69b);border-color:#62ffd0;box-shadow:0 0 16px #12d89b55}.action.red{background:linear-gradient(110deg,#b92457,#f24d78);border-color:#ff9ab5}.action.gold{background:linear-gradient(110deg,#c47713,#ffb22d);border-color:#ffda86}
  .feature-grid{grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}.feature{background:#11112feF;border:1px solid #9563d7;border-radius:13px;transition:.18s}.feature:hover{border-color:#e2aaff;box-shadow:0 0 15px #a45cff55}.feature.active{background:linear-gradient(130deg,#392064,#4d2879);border-color:#d6a0ff;box-shadow:0 0 15px #a45cff44}
  input{background:#090a20;border-color:#8c61c7;border-radius:11px;padding:13px}input:focus{border-color:#e0aaff;box-shadow:0 0 0 3px #a45cff22}
  .logs{background:#08091c;border-color:#7651ad;color:#eadbff;border-radius:13px;min-height:150px}.section-title{color:#f5eaff;text-shadow:0 0 15px #a45cff55}
  .advanced{margin-top:14px;border:1px solid #8e60c5;border-radius:12px;padding:12px 14px;background:#0d0d27}.advanced summary{cursor:pointer;color:#e8d4ff;font-size:13px;font-weight:700}.advanced[open]{padding-bottom:15px}.advanced label{margin-top:14px}
  .toast{background:#21134a;border-color:#d3a0ff;box-shadow:0 0 20px #9b5cff66}
  #page-control .panel,#page-settings .panel,#page-logs .panel{max-width:100%}
  #page-control .form-grid{align-items:end}#page-control .form-grid input{min-width:0}
  @media(max-width:1100px){.sidebar{overflow-x:auto}.sidebar .brand{width:205px}.sidebar .brand+.nav{margin-left:220px}.sidebar .nav{padding:10px 13px}.columns{grid-template-columns:1fr}}
  @media(max-width:760px){body:before{display:none}.sidebar{height:auto;min-height:100px;position:sticky;top:0;display:flex;flex-wrap:wrap;padding:8px 10px;gap:6px}.brand{position:static;width:100%;text-align:center;padding:0}.brand h1{font-size:22px}.brand p{display:none}.sidebar .brand+.nav{margin-left:0}.sidebar .nav{flex:1 1 18%;margin:0;padding:9px 5px;font-size:10px;gap:3px;flex-direction:column}.sidebar .nav span:first-child{font-size:17px}.topbar{position:relative;top:auto;right:auto;margin-bottom:12px;justify-content:space-between}main{margin-left:0;padding:12px}.hero{padding:18px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.stat{padding:11px}.stat strong{font-size:12px}.columns{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.slot-grid{grid-template-columns:repeat(5,1fr)}}
  @media(max-width:420px){.sidebar .nav{font-size:9px}.grid{grid-template-columns:1fr}.actions{grid-template-columns:1fr 1fr}}

  /* YUNO BABYBU — polished sidebar dashboard */
  :root{--bg:#090b18;--panel:#14182a;--panel2:#1c2038;--line:#343c60;--purple:#a78bfa;--pink:#f0abfc;--text:#f4f2ff;--muted:#a6acc9;--green:#49e2ae;--red:#ff6685;--gold:#ffc66e}
  body{background:radial-gradient(ellipse at 80% 0%,#49307855,transparent 38%),radial-gradient(ellipse at 20% 100%,#173d5b44,transparent 42%),#090b18;color:var(--text)}
  .layout{display:block;min-height:100vh}
  .sidebar{position:fixed;inset:0 auto 0 0;width:248px;height:100vh;padding:24px 16px;display:flex;flex-direction:column;align-items:stretch;gap:9px;background:linear-gradient(180deg,#15172df7,#101426f7);border-right:1px solid #7d70b744;box-shadow:12px 0 40px #0004;backdrop-filter:blur(18px);z-index:40}
  .brand{position:relative;left:auto;top:auto;width:auto;text-align:left;padding:10px 12px 25px;margin-bottom:10px;border-bottom:1px solid #ffffff12}
  .brand .mascot{display:block;font-size:36px;margin-bottom:7px;filter:drop-shadow(0 0 12px #c084fc)}
  .brand h1{font-family:'Be Vietnam Pro',Arial,sans-serif;font-style:normal;font-size:25px;font-weight:800;letter-spacing:-1px;margin:0;color:#f3e8ff;text-shadow:0 0 18px #a78bfa88}
  .brand p{font-size:10px;letter-spacing:1.4px;color:#9da8ce;margin:5px 0 0}
  .sidebar .nav{position:relative;width:100%;flex:0 0 auto;margin:0;padding:13px 15px;border:1px solid transparent;border-radius:13px;background:transparent;box-shadow:none;color:#bfc5df;justify-content:flex-start;gap:12px;font-size:13px;transition:all .18s ease}
  .sidebar .nav span:first-child{width:24px;font-size:18px}
  .sidebar .nav:hover{background:#ffffff0b;border-color:#ffffff14;color:#fff;transform:translateX(2px);box-shadow:none}
  .sidebar .nav.selected{background:linear-gradient(100deg,#7254c9,#9365d8);border-color:#c7adff;color:#fff;box-shadow:0 7px 20px #7352c744}
  .side-foot{display:block;margin-top:auto;text-align:left;color:#7f89ac;font-size:11px;padding:16px 12px 5px;border-top:1px solid #ffffff12;line-height:1.8}
  main{margin-left:248px;padding:28px clamp(18px,3vw,42px) 48px;max-width:1800px}
  .topbar{position:static;display:flex;justify-content:flex-end;margin:0 0 22px;pointer-events:auto}
  .pill{background:#171b30;border:1px solid #41496d;color:#dfe3fa;box-shadow:none;padding:10px 16px}
  .hero{border:1px solid #62528f;border-radius:22px;padding:28px 30px;background:radial-gradient(circle at 90% 20%,#a78bfa25,transparent 34%),linear-gradient(115deg,#202440,#171b30 65%,#20203d);box-shadow:0 16px 40px #0003;margin-bottom:18px}
  .hero h2{font-size:clamp(25px,2.6vw,35px);text-shadow:none;letter-spacing:-.7px}.hero p{color:#c4c9e3}
  .stat,.panel{background:linear-gradient(145deg,#191e34f2,#121729f5);border:1px solid #3b4568;border-radius:17px;box-shadow:0 10px 28px #0002;backdrop-filter:blur(12px)}
  .stat{padding:17px}.stat .ico{filter:none}.stat strong{font-size:16px}.panel{padding:20px}.panel h3{font-size:16px;text-shadow:none;color:#f1edff}
  .feature-grid{grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:11px}
  .feature{background:#171c31;border:1px solid #424b70;border-radius:13px;padding:14px;min-height:66px;transition:all .18s ease}
  .feature:hover{background:#202642;border-color:#a78bfa;box-shadow:0 7px 18px #0003;transform:translateY(-2px)}
  .feature.active{background:linear-gradient(130deg,#293b4b,#263c50);border-color:#49e2ae;box-shadow:0 0 0 1px #49e2ae22}
  .feature b{font-size:10px;color:#ff8ca5;letter-spacing:.4px}.feature.active b{color:#49e2ae}
  input{background:#0d1223;border:1px solid #414b70;border-radius:11px;color:#f6f4ff;padding:13px}
  input:focus{border-color:#a78bfa;box-shadow:0 0 0 3px #a78bfa22}
  .action,button.submit{border:1px solid #a994f3;border-radius:12px;background:linear-gradient(115deg,#7053c8,#9870df);box-shadow:0 6px 16px #6c51bb2b;transition:all .18s ease}
  .action:hover,button.submit:hover{filter:brightness(1.12);transform:translateY(-2px);box-shadow:0 9px 22px #6c51bb44}
  .action.green{background:linear-gradient(110deg,#167b68,#25b991);border-color:#4be0b4}.action.red{background:linear-gradient(110deg,#a93458,#dc5275);border-color:#ff91a8}.action.gold{background:linear-gradient(110deg,#a66a22,#d69a3f);border-color:#ffd18a}
  .logs{background:#0b1020;border:1px solid #303b5c;color:#cdd6f4;border-radius:13px}
  .advanced{background:#11172a;border-color:#414b70}.advanced summary{color:#d9ccff}
  .toast{background:#252344;border-color:#a78bfa;box-shadow:0 10px 28px #0005}
  @media(max-width:1000px){.sidebar{width:218px}.sidebar .nav{padding:12px}.brand h1{font-size:22px}main{margin-left:218px;padding:22px 18px 36px}.columns{grid-template-columns:1fr}}
  @media(max-width:760px){.sidebar{position:sticky;inset:auto;width:100%;height:auto;min-height:0;padding:10px 12px;display:flex;flex-direction:row;flex-wrap:wrap;gap:6px;border-right:0;border-bottom:1px solid #7d70b744}.brand{position:static;width:100%;text-align:center;padding:4px 4px 10px;margin:0}.brand .mascot{display:none}.brand h1{font-size:21px}.brand p{display:none}.sidebar .nav{width:auto;flex:1 1 18%;justify-content:center;flex-direction:column;gap:4px;padding:9px 5px;font-size:10px}.sidebar .nav span:first-child{font-size:16px}.side-foot{display:none}main{margin:0;padding:14px}.topbar{position:static;margin-bottom:12px}.hero{padding:20px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.stat{padding:12px}.stat strong{font-size:12px}.columns{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.slot-grid{grid-template-columns:repeat(5,1fr)}}
  @media(max-width:420px){.sidebar .nav{font-size:9px}.grid{grid-template-columns:1fr}.actions{grid-template-columns:1fr 1fr}}
  /* Alignment fix: remove legacy horizontal offset from first sidebar item */
  .sidebar .brand+.nav{margin-left:0!important}
  @media(min-width:761px){.sidebar{width:248px!important}main{margin-left:248px!important}}
  @media(max-width:760px){.sidebar{width:100%!important}main{margin-left:0!important}.sidebar .brand+.nav{margin-left:0!important}}
  

  /* Bảng công pháp */
  .skill-table-wrap{width:100%;overflow-x:auto}
  .skill-table{width:100%;border-collapse:separate;border-spacing:0 8px;text-align:left}
  .skill-table th{padding:10px 13px;color:#bdb5dc;font-size:11px;font-weight:700;white-space:nowrap}
  .skill-table td{padding:12px 13px;background:#11172b;border-top:1px solid #414b70;border-bottom:1px solid #414b70;font-size:13px;white-space:nowrap}
  .skill-table td:first-child{border-left:1px solid #414b70;border-radius:10px 0 0 10px}
  .skill-table td:last-child{border-right:1px solid #414b70;border-radius:0 10px 10px 0;width:145px}
  .skill-table code{color:#e2c8ff;background:#241a3d;border:1px solid #59417f;border-radius:7px;padding:5px 8px}
  .skill-table .feature{min-width:118px;padding:9px 10px}
  .skill-table .feature span{font-size:12px}
  @media(max-width:760px){.skill-table{min-width:620px}}

  /* ===== YUNO SAKURA DASHBOARD — FINAL LAYOUT FIX ===== */
  html{scroll-behavior:smooth}
  body{overflow-x:hidden;background:
    radial-gradient(ellipse at 78% 0%,rgba(130,65,220,.22),transparent 38%),
    radial-gradient(ellipse at 8% 95%,rgba(75,40,150,.16),transparent 34%),
    #09091d}
  .layout{display:block;min-height:100vh}
  .sidebar{
    position:fixed!important;inset:0 auto 0 0!important;width:240px!important;height:100vh!important;
    padding:20px 15px!important;display:flex!important;flex-direction:column!important;
    align-items:stretch!important;gap:9px!important;overflow-y:auto;overflow-x:hidden;
    background:linear-gradient(180deg,rgba(17,13,42,.98),rgba(10,10,30,.98))!important;
    border-right:1px solid rgba(184,112,255,.38)!important;
    box-shadow:12px 0 40px rgba(0,0,0,.28);backdrop-filter:blur(18px);z-index:40
  }
  .brand{
    position:relative!important;inset:auto!important;width:auto!important;text-align:center!important;
    padding:8px 8px 20px!important;margin:0 0 8px!important;border-bottom:1px solid rgba(202,158,255,.18)
  }
  .brand .mascot{
    display:block!important;width:104px;height:104px;margin:0 auto 12px!important;
    border-radius:50%;overflow:hidden;border:2px solid #d8a2ff;
    box-shadow:0 0 0 5px rgba(174,95,255,.12),0 0 28px rgba(177,92,255,.55);
    font-size:0!important;filter:none!important
  }
  .brand .mascot img{width:100%;height:100%;display:block;object-fit:cover;object-position:center 22%}
  .brand h1{font-size:24px!important;font-weight:800!important;letter-spacing:-.6px;color:#f5d8ff!important;text-shadow:0 0 18px #a84dff!important}
  .brand p{font-size:10px!important;letter-spacing:1px;color:#c8b2ed!important}
  .sidebar .nav{
    position:relative!important;width:100%!important;flex:0 0 auto!important;margin:0!important;
    padding:13px 14px!important;display:flex!important;flex-direction:row!important;
    justify-content:flex-start!important;gap:12px!important;border:1px solid transparent!important;
    border-radius:13px!important;background:transparent!important;box-shadow:none!important;
    color:#ded3f8!important;font-size:13px!important;white-space:nowrap;transition:.18s ease
  }
  .sidebar .nav span:first-child{width:24px;font-size:19px!important}
  .sidebar .nav:hover{background:rgba(173,111,255,.13)!important;border-color:#9862d866!important;transform:translateX(2px)}
  .sidebar .nav.selected{background:linear-gradient(105deg,#7836d9,#a044e9)!important;border-color:#d8a4ff!important;color:white!important;box-shadow:0 7px 22px #873ee955!important}
  .side-foot{display:block!important;margin-top:auto!important;text-align:center!important;padding:15px 5px 4px!important;
    border-top:1px solid rgba(202,158,255,.18)!important;color:#b9a4df!important;font-size:11px!important;line-height:1.8}
  main{position:relative;margin:0 0 0 240px!important;padding:24px clamp(16px,2.2vw,34px) 42px!important;max-width:none!important;min-width:0}
  .topbar{position:static!important;display:flex!important;justify-content:flex-end!important;gap:10px!important;
    flex-wrap:wrap;margin:0 0 18px!important}
  .pill{border:1px solid #754bb1!important;border-radius:30px!important;background:#17132e!important;
    color:#eee2ff!important;padding:9px 14px!important;box-shadow:0 4px 18px #0003!important}
  .hero{
    position:relative;isolation:isolate;display:flex;align-items:center;min-height:220px;
    overflow:hidden;padding:28px 30px!important;margin-bottom:16px!important;
    border:1px solid #b66cff!important;border-radius:21px!important;
    background:linear-gradient(100deg,rgba(26,15,59,.98) 0%,rgba(46,22,82,.94) 55%,rgba(66,30,103,.72) 100%)!important;
    box-shadow:0 12px 36px rgba(77,28,128,.28)!important
  }
  .hero:before{content:"";position:absolute;inset:0;z-index:-1;opacity:.25;
    background:radial-gradient(circle at 75% 35%,#f1b2ff 0 2px,transparent 3px),
    radial-gradient(circle at 82% 65%,#d98aff 0 3px,transparent 4px),
    radial-gradient(circle at 65% 20%,#fff 0 1px,transparent 2px)}
  .hero-copy{position:relative;z-index:2;max-width:62%}
  .hero h2{font-size:clamp(24px,2.7vw,36px)!important;line-height:1.2;margin:0 0 10px!important;color:#fff1ff;text-shadow:0 0 18px #c06bff66}
  .hero p{color:#ead9ff!important}
  .hero .statusline{margin-top:9px!important}
  .hero-art{
    position:absolute;z-index:1;right:0;top:0;bottom:0;width:43%;
    background-image:linear-gradient(90deg,#281447 0%,rgba(40,20,71,.15) 40%,rgba(40,20,71,0) 100%),url('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAQDAwMDAgQDAwMEBAQFBgoGBgUFBgwICQcKDgwPDg4MDQ0PERYTDxAVEQ0NExoTFRcYGRkZDxIbHRsYHRYYGRj/2wBDAQQEBAYFBgsGBgsYEA0QGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBj/wAARCANEAQkDASIAAhEBAxEB/8QAHQAAAQUBAQEBAAAAAAAAAAAABgMEBQcIAgEACf/EAFQQAAEDAwIDBQUFBQMJBQUIAwECAwQABREGIRIxQQcTIlFhFDJxgZFCUqGxwQgVI2LRM3KCFiRDU5KisuHwFyVjZPE0NURUlCY2VoOEk6PSRbPC/8QAGwEAAgMBAQEAAAAAAAAAAAAABAUCAwYBAAf/xAA4EQACAgEDAgQCCQQDAAIDAAABAgADEQQSITFBBRMiUWFxIzKBkaGxwdHwFDNC4QYV8VJiFiRy/9oADAMBAAIRAxEAPwDFis8avjXwpZxCeI8KTz50vFt8iWohhokDmonAHxNasIzHAEHiDWCCFe6djXhQW3ig9Klo1viFwtd+JL4yrgbc4U4AOd+prvhhyIq3Uw/7AAYLpyQT8KIXTFh1EkBGcdaxyJFFOkbu3atYW24SwpTDEhDjgH3Qd6GxIhI8IinPo8f6UuzNhhQzCV/+8f6VKsBT9Yfj+0uqtKEET9LLXdbVcdOs3eFKachONBwOhQwBjO/lispduXbrH1RaZmjrFFLcQSOF6XxZ79KTyT6ZqrIOup8KwOWiNInNQ3AQthMtQQr5YoYlS7Wpf/upeT19pP8ASptWoGQ35xxrPFjbXsrGM9Y3Q9lexwa0E7pe0XLsBjas09fJFjHdoROQiQsR1uZ4VBaAdlE+VZ644necTcUhPkXCaJrbf5jGmn7O26s215wOuwis92tY5KI86rVN3GYLoNWKt6suQR+Mjrxp+6RpSlFky287SYp75C/XI3+tFVl7Ir3eeyG5a4ih5sW9Z7xh5vhDrYG6kK6kdRURDvbFvkh6HALDoOQpqQpI+nI1o3RPbnbL72cS9IakhQGZZYU2wt4cMeQPurxyV69ajZUw5XmG6CrS3uVfqff95lJqKVHI3+FSv7pQ7DQplJ48b1pHXtlsD/ZNZ79F0Jb0Mtju3XGQprhV8U+8nyJqlxeLLFOEaWinHnKcH6UXRSrruMq1GiGitNVxlfSYhbUUlJBHpTJbeDRxcLrY5DC0p0nGacVydTLcJSfhihWQltS8oa4B5cWapsqC9DFNoUH0nMjFp3xikSnHSpBSW8bt5+dJHuRzZz/iNUFPjBzGePSvsHyp6hcQe9D4v/zSP0pUOwM724H/APPV/Soise/5z0jeEnpXwB+7UuHrYOdqH/1Kv6Uo2/aQN7Mlfxkq/pUxSD/kPx/aekMEn1r4pI2ANTvf2jI/7iR/9Wv+lKB20n//AADf/wBWv+lS8kf/ACH4/tPce8HeFR6V6EKPQ0SpVZ+um0q//Wr/AKUsldm//DCB/wDrV/0ro0//ANh+P7TuB7wYDBUfdNLJiKx7p+lFDbtl6aZRt/51z+lPWJNgSsB3SiCnO+JzgP8Aw0QmkB7zmIINwVrUEpQfpS37qcA3QfpViSWrRFUl+FoNUuIsZaktznlpWP8AZ2PmK8izrK466iboj2ZCI7jySqW8ONSRkJyU9Rn6UQNEg4Jlnl46yujb1gZ4D9KbORVJ6GrDa1FpNSgHdDt8B5lu5uJV9eHFTSNE2PVllfnaKlyTOjtl56xz+EvlsDKlsLTs8B1TsoDfFUvpRjKyO3PSUq4gpJpDJoinWx0vKQ00VK3PCOdQ3syvIUutqZWxiRxHRjrMgNJHEpRwB51JvFtmYuIlQUyw0U8KDspWNycdc09umn7rp/VzUG5xVMO5C053CgeRB6iohruiXsMuIWlteVcWQo/TamQrNXBGDmT244McMqkoUh1HdeyIBPC0BkbEY8yabttTWYHtifazuQkt44U/3vXntXQaaZiodcKw4pGUADfOSM/CmIddYKiw4tsqHCooVjI8jVDenGZzOIo/dpkiL7KtbYZznhS0lOT6kDP401S4ocq4IOeVfAEDNCM7E5MjmOUvKxzr5Syo70gPjSnlXtxnczoKOcCnkWQWyU8WMimYG/lSiE71JcgzqsVORHqHFcWalrcpbkhtpsZUtQSB6k4qGQkkE+VHHZhaVXntOtELHgD3fOHHJKBxH8hRdSkmTU5Il7w9YXDTTqbY8y1OthYQxKt8gcTbiQnB+B9aBNf9nMZm3HWGje9k2B5X8VhXidt6z9hfmnyVRHqFnjuLrn3lk/jUjom/SdP3kgtpfhPju34zoyh1J5gin11AI4HMNFvmHbaePf2md34qkZyN6i3mTvkVoXtZ7MrfaozWr9JcTmn5i+FTJ3VBd592r+U/ZPyqkpcThztSl6twyINbSa22mDTiOhpstJqVeZIUdqYrbwdxQTpiDmMznpXJzmnBb8qTLZqkrIxPJzucV5xqztzpTuzw5xt51yU1HkTuJzxnzIr3jV9414U19wnyrmTPTourHJR+tdJkLz75HzpJSCE5rxsHi2r245no8RJdTyWR86VEt4/6RX1ps23k05bjqVyTV6lu09jMVTOlhPCmU+keSXFJH4GpC2XqbHntd5dJbbZVgqLinAjO3FwnIOM8qjVxlpTnFN1pIODVwsdDnMkARDxU+2m+IkO2uEI/UupPGTgAOKSk8uLBI6Cll3+7W+6QLow2xDlw+F1qVBSAhwhWUuAjbrw+o2NDL2qrw+yygGI2hloIKG4yAHQE4ys4ySQBnepq62202KBJaMh1iTPZZW3DZc7xDSdlHj26nkOYFMxcHUlekkY97QkQZ8uNqO3MJYj3dj2oso5NO5IcQPQKBx6Gq67qjKdJC+zq2tKP9lIkpT8CUn9aEuNPmKX6pRuEixmy9Q9mEXtC0JFnQ3EJvFuRxISPeUBzQfMHmD51lKZa5MK7zYb6FJLaXBwkYxW3ey91UrT5VHGHigOsOeahk4+BGRiqN7d9LtW/XCrzCY7uNcWC9gD3VH3h/tfnT/VL5ljq3bn+fzsY712n3ILQPnKDmx1l9IIPhbQAP8NMzEWr7NGsSySbnMQyxHW66oABKE5Jq2Oz79n5ep7kW77d2LQy34lt7LeI6kDkB60ps0TPmz/Ed4sq07WttWZtXFUgbim5bwatztd07o/TmuH7Vo24v3CAwkJVIewSpzHixgcs1VboHHsMUBfR5ZwZVdUa2KntEAg5wa7Sg+VdISSrlT9MIewCQHmslXD3WfEPX4VUlZbpKwMxiEE5OKVbQfKlgzil22PDyq1azmcnLTWTyq8f2fNPPyLvfb/3Z7qJETFQsj/SOncf7IqoYkXiUMjA6mtodmunG9Kfs7WRh1nu512Wq6PkjfCtmwfgkUfSu1l+Jk6+sEbxZlF5RCc1ENQih5OU4xVhTGkq4jimFvtiXJinCji4eQIpzkt1hVa72An2nbtAaiTbHfWDIs1wa7mS31SOi0+ShzqpO2Ts4Z0NqaP+6XXpljuLAkQJjmCVj7SSRtkH861HpTQulNRwmY10ZWiV3xUUMLKC8MclEDZPwxUh2k9ntuvUCDoIW5TVvnsqTbn20KUIEtAyg56JUNjmkuo1VS3eWMg859uO4/nT4w69FKhO4n52So5CiSKjXWdzR3qSwzLHfJloucZUeZEdUy80obpUOY+HUehoVfYwTtXLK88iJyMcSILA4B50iWj5VKLZO21IqZycYoVq5zEjS2QKTUgg4/KpFTOBSCmt9qpKThEaBsmlURlK3p0zH41gYqch2lSwMJ/CratOX6SaVloNyIamcJWAcgHY5501Sgg4AovnWhaEk8B+lRCbee9xivWachsYnXrwYjCilxYGKNtP6Tl3aW1FiRnHnnCEpQhJJJPpSWnbJ38hCeAnJrW3Z1pu3dn9kh3eQkm6yAHMhsksp6JSeXEetMtPpdi7mGT2EZeHaE6hsTPWueyK8aJs9rl3httBuLKnW2054m+FXCUqGNj6VUU+KGXSPWtl/tMvyZs2JKeW6ptwlbbbhJ7sFCTgDpWQL0MOq2r2oQNQlhGCRnie8R04qYADtImTJSWGGktoHdt8JI5qOeZqUbnR71MQ5OQpLqUJD6kKwFoSAni9CBjbr6UOr9/JqQtIHfyj5RHT+VLqrWL7e0VFiTHt0ktnSkZuPkNCU/wgnfHhob71XpUzOT/9lYY833fyTUJwVTqSxYH4CcM3R+z9C1pbLMpd2t2LQSHI7jqsOt7c+HG6aIu1jTdq1TaZDMB/vEwyp5LiWVJASrOQCR4sEA4FCGj/ANoFMh9uC5YGY7DSfHIU6SEJA5/8qtdOuLBeXIDTFxN2Ym94puMpISENBoqUf725ArTOt/nedsyMdvYe/wBnymloapqvLDZlZaG7OokXTTVxbu9thF0lK1y3Ql0kZyMc8enWortDl/5OW5+bEUpsuoVHZdSQOIH3iMedWvrHROlNMaHn3yVJEgPMgRW0HCW1LOUqz1wn6YrGurLvJelOxRLccYQo8AUokD4DpRtWrR6WuRvSOAMY/wDcQK1hSvEF7vIDzqlFWSTQ+tsqVsKePKUpZzSYQTg1mL38xsmKWbMRQ1vTpDSiNhSzLHFvin7EQqxtUEqMhGSGcjenLUfcbVKM28kgcNSDFoUT7poxKDPYimmLE7e9S26ysJy7Nktxkj+8oA/hmtvasZSia3AjABmI2mM2kcgEAJ/Ss4diGnlvdslnnFh51mCVyipppTg4koISPCDuSfwrTzmnNUzXkvf5PTUoeXwh6RhABPUjdQHyqTutNoLkDA7/AB/8k6xAR2ISncU/t0IMspykBThyfQVZ8bskluoCrheozHmmO0Vn6q/pTk9nFhjPIYcvNyfdI2Q3wA4+AG1Dt43p+gbPyBhtB2nJg5p66uWV8rihsceErK0hRxnkKtaHeGJtuM1lCksKzwFafEoDmcUMtdnliSQFSrkVHknvxn8BUpD0nGhNd1DuV0aQDnh9oyKQ6/UabUHcuc/KXO6NMvdrWi7H2uPam7QNIT5Ea7WZgfvK0y44SZCW8gOtqB2JHQjoOVZYdhlXJPrmv1Ltui4NqnS58ec4lyYcyVSG0LD3TCsjcVQ+o/2RLbcbtLm6f1i1ES86p1EV6ES23xHPCkpIwkdKO0vimnGUY4UYxnn7OB90GuVWOUmI1wVDkKbrhn7uK0ze/wBlTtPtr6hCt8K8MgZDsOQkZ/wrwc/Oqu1F2d6q006pN903crfjYrfjqCP9oZT+NMUeq3+2wPyMp8sysVxAEbjembjHTh5daLnrcSCQkEeY3qPctq+L3TXGpnNkh4DBMgAitS9j2guzXVfZtKVd1TW7zFWXH3WnuHgZwOEoSQQrfnnzrOjEItOAlOKuHsW1W1pvtCgqkKSIshXs7wWMjhVtv8Dg0bp6T5bBThuo/b7Yy8OKh9rDrCLXXYi/bLKbvYHlXa1g4UvuuB1k+S0fqKo6dZFRpRQpopIOCCMYr9EobQuTrinRgxsgMDZHor15Z+dBWr+yZOurc4JsJpi5pH+b3JloJ4j91wDmPXmKpTX1t6b+o7/zr9n3RpqdAjAnoRM29kOmXLlqFcoxu9ZhI75SeHIUrOEp+Z/KtMWddzmu/ua6S0uB5JAadAPdKxsRt4cY5VHdivZ7crBpu8ty4vc3ETvZ1pIyU8CeY9PFkVYLulYdkjC7XOYxDZQsLdceOVKGxOBzJrut8QpDmkEHHTHPPwhmk8nT17CfVKB7erZJZ0tp9ch1TyyhxK3VHPEpJxsfLGKyVfowC1VqXt51hbNR39iJYO+/dcNBDZcTw8alHJIHQeVZlvXCp5QWcJ6kUTYrHSobBg8/icxN4qSzbjAOQkhZxStqlsRbjxTEOLjrQppwNY4uFQ6Z65ArqWkd6cU1CdjWcOUfIiE9ZIz3QdNRODIT7Q9jPPHhqG4vSpGb/wDduGM//EO/kmonB86jex3D5D8p4yxZV1DTXsEBSksA+NZ5un19KIrXqi4W2zQpUSQ404w44UrScEZwD+eKr3vsukZPOpKDJUu3zWiolCGFLA8iVpzWm03iDhmIPaWV3FTxLEvfatebtpmLZH5S1RI2eBsn8/Oq7mz1y3cqpiVk+deoSTuaDu1llvB6Tj3NZ9Yz0ICwTnfy86cMxsnlXUdocXiRn0qXhQ1KUNqrqqLGV54ice35SCE1MRraojPDyo30D2caj1xeEWzT9tU+sYLjqvC0yPvLVyHw51r7s8/Z30fo1DVyvgRfLsjCuN5P+btK/kR1Pqas1Wq0+iH0hy3sOv8AqeUFpmHQHYXrjXJRIhW4W+3Z3uE4Ftv/AAjmv5VprRn7NXZ9pthuTfw5qGanBJlHu44Po2Ofzq4eYCUAIbSMJAGAB5AdK8dQwEhTqeLHLIzWc1XjOov9KHaPh1++XrWB1nEFu12uKItpixobI2DcNgIH4ClVvrKuINyifMDFcpfXjDcdWPU4pT2gJID3AgnkASSaUkc5PMuAxGTzrvdqPd3HA6JUCT8qhnI00yXJTBuLTiwArvGAcgchkGiglHCVqISkDJKtsD1plGviJ0lcaxxjNUg4ckqPAwg/3uaj6CrarGAJVfn7S1CcEgRhbFPFpSkOoXNIwUP5Sr/DnmKdPXl1m1xktJT7dIUUJCxgJxzUR6eVSZt0h9B9unrcJ/0bCAhI/WoO7QYbKCuPKW45GzxoStLy2geZKeePOuq9dj+qcBDGL3G+WbTli/eVzkKluFXAjJyp1fkkdAPOhRPa9bEILlwMhrJ8MaE0Dgeqzz+VR92sq71MhPSIj1yiREFtLMN7u0b75Od8mpy2af0rOiFKdOx2Fo2W0+glSfn1o4UaatN1oLH4Y4+H8Et2KBk8xW29pGjrw6GhLfiOnkmWCnP+LlRGWoU2Pwh0utKHLj40kfPINCsns/0lLSUi0hs/eiOHiT/hNObfpa8w4yWrBqpRZa2THktA8Poaqtr0p5qYr/8A1+4zIlFxkHEhtTdgnZ5q1txx+0twpa//AIqGkNLB9QNj86pDXP7K0nT9vduVov3tcVAyQ/GJKR6lHL6VqBq63a1pCL/aSpA5y4XiT8SmpqLNhzYvtEKUh9s7EpPL0I6VyvX6vTEHduX7x9/aQyV68ifl/drYmM8Y6EtqLRKVLbOQo0zhMrRITjIwelfoPr3sT0Rrttx96Cm2XI+7OhJCST/OnkoVWUT9n/RFljog6mjXH20khNxTJ4Iru+3Dt4Ffyq61pNJ4zRZhuQfbvJoodvTxInsv7YLiu3w9NzNNrvVw2aYfac4VrSOQX54860dYpV39lS7dY1vhgpz3DKy6pI9VHaspabFj7Of2gosUXUTIaElpx1aOBTKlpxwL6ZBxuNjmtQWuTHuEIOMymlM7KdUlQITsPCSKF8eoUFXRMBhnPP5dB90asGavD/fJGRqWz2rU1utcpoRn7wV9y+QAlxxAHgUfvFPL4YqUnwo8tsB1llax7vepCt/gapj9oF+E32ZQZntHDLjT21sFKsKBIOT6bYoI0Z24G6aggwNaOCTCba4Q4F8CkrSMhZPXOMUFR4JZfpxqaTyM5Hfjpj7O0qr0gbDK2Dz/AKxCztu0bGvPZ3dHX7THauVuCXo8mM3jvUk4Unbn5/KsB6iaLT60nmDitidpX7RVkmaWk2XSaJMZ95YbXIeHEEN9SnzNZE1iI7N2kNR57c5oK8MlsEJcB3zg8vhWg09N1Wk23jBzwPu+7n4zmvwagT1EAJOeM03B2pzI3WcU2A29aTP9aZ4xxO305DH/AI7v5JqIxUrN/wDcMUeTzn5Coreqr/rD5D8pEy0bv2UdoVmaMqdpK6JjnfvW2u8Tj4pzUBGYfjInNPNraWWCkpWkpPvJ8/hVhWbtT1FZHlNw7rMaCTgJQ8oA/EcqsSz9rFgv0b2fXenLTemVeFS3WUtvfJacZp8tKZJQ5/D+ffLs0noSPxmc221Z5b06aYJOcVql/sZ7Fu0GH7TofVqtL3JQyIU4FxhR8s+8PiM1VOs+x3V2gJKReoLT8JxWGblCX30d30ChyPocGqagC/lng+x4/wDfslT1MnJ6QBhxeJQyKuzsa7GLt2j3gPHihWSOsCTPKf8Acb+8s/Qdaj+x3slndoutEwsLYtcbDk6Uke6nohP86unkN63Mr9x6D0jGtVtiNxY0dHdx4zW3z9Sep617Xas6YCikZsP4SCc9Y7sNi09onTzFi09ARHYTsltG63VfeWr7SvMmnTk8B0t8aHHUjK98IaHqarqfq532n2ePJSJK08Ul/wCywj7o/WoGVqlUpz2dpxbcFBzw/acP3leZPl0pPX4VbYd7nk94coAHMueJcoLqFuJlJc4PecOyR8K4F9hPPFuMsvEbFTYyB86p1F5MhnilPliC2cBpB3WfL1PrUgzqqVOks261cEJrBK3B/o0jmc/rXH8HKnOf9S3Cy1nZqWm1OOHgSnY9Tny+NR151NAs8RUiS+21wI41FfNCfX1PQUDz9dWmFalOoK1pijhjpcP9s6dgT8TvQFd79IfhrbK33pJWC4t5jLbrquoWeiRyFT0ngzWtlxgQvT6XzOT0ENbRrG89ourXLVaYrse0x/FKmPjASnoAnqo9B86tGFPt1uLdrjKbbCBs2Dv8T61Sdg1T+4rEqJFbCSMqUoc3Vn7RqN/fcgy3Zjj6y6UnfPU0RqfDfPYqo2oOg9/iZC+1Xwq8KP5mXFrjXbVj0HKuFvfSZTyvZYqs/bOxV8hk0Edmmk0zI/78nB9KHCSHi4Q5KOcnJ+7n61Xl5nC63nT9hffUYrDapD6QehO/zI2o+Y15OYktFlCG4iWlNojpGzacYT868NA+noNdP1m5J+HYSCYCkCWdFlQod1uyZS22E8bb3Edhgpx+YpCVq3T7DTjrMhLzqOaMYKh6Gqsc1S/cYAZmLy4pss8fU4PEjPzyKgFznFH3jiqKvBwxzYTPHaOTLWuN2tN0aEy0TVxpyT/ZqPDxHyz5+XnSNs16tt4NXdpTpSeHv2/C6j+vzqrUyV5zxGnQllwhSzlY5k9aM/66vbsbkfiPtnRYmMGX0xqdkRUyVuJkwV7e0tD3D5OJ6GvXbVDlOC52SQIklW/eNe456KTyNU1Z7/JtUvvozgKVDhW0vdKx5EUZRbwqBDF6sWVwirEqEo5LCvT+U9DSq7w1qT9Gev3H4H+YnhWOqw+iy3u8THuDIYfOwIOUOfA/pTt6PHlMLjymUOtLHCttxIUlQ8iKh7TqK1X+IWUqHHjKmV7EfCnqZSoj6WJK+JpZw08fP7qvWlFlbK2MYI7ftKGQgynNbfs7aZn3Zd7tMydbkEEvMMp74I22UkE5KRjcc/Kq2uPZP2o2dgp0tKdu9tkeJEi2yOFK8D7aCcpPxrXOc8qC9UaYvSGX7hoy7ptM1ficadRxxnleak/YP8w+dO9B49qRiqxwR23DI+3HP28wmnVN0LTBt7vV3MhyJdJUtbjKilTchaiUqGxGD1oWkXJe+F1bevre/I1VLi9pDb1lvijxCciMC28PvHh94fzAVTd5t5hT3GGpTExoe7IjqyhY8x5fA1sWubYCv4dPsnL2Yc5kVNnKJPiNDs2QpwkE1JS0LGah30HipVqLGbgxe7kxkptJSpRJB8sU2Kd6khLksQ34jbnC0/jvEYB4scqYEUvdRKmx2nE84s0Yf+Kv8hUVUncD/wB1sD/xF/kKid/Og7z6vsEjLa1HZkRZPfxmFoSffGMAGo+2xHVpckLJKR4QPM1cb8OIbXmalLqCvu1IP3cc6FV6Vfi31m1MZMeU5lh7GwB8/hWyv8OAs3J0irTareMNJbsg0hdNbdptu08zJejxFOBct9Bx3bQO+P5jyHxrQv7QGndS6autuj6TcliwXOMmA5BR42w6nYcQOd1DBzzzmhjs9uVi0BfbfaLfl2S4+hMmSdlFSjjfyAB5eZrZSmY7zCS+hDnXC0gjPzrPeKauzQ6it2GVwePf4/liOqDuXiVb2ZWezdnfZ6IILeY7fey3hsX31Dc/oPQUI3/UMm73B2c6r1QkckjoKLu0/Ss9FrFysZcLPej2iIjqScBQ+fSvdOdlQdt6HdR3BTLriOL2VjHEnb7SjVWm1GlRTrLGyW+/4ytaHB5lTvPLTHLYOCs8TivM9BTYOEHdWBV7WfRen4N4Q2m2qltvJUkyZCwpKUnbHD0V61RlxiiPcpLCDlDby0D4AkU102uTUMyoOn6/+Ql6mQAmJLlLXgEnhTsB5V61MdaSsNrICxhWOo8qanY1G6gvkbT+mJt4kEcMZorAP2lckj5nFFnB4lG4wU1nrBLuqP3K3KQlEMBTieLcuKHl6CpDRUyXebq/Jdkuuw4Q4GkrUSnvDzI+ArK14Ydmz5t9kTHnJ8hzvT/MtR2A+oFa77PLJ+4dAW6Avd4NBbqjzUsjJJq173rr8jbiEeayrtB6woycbGuVEnalMCvCnKh8aDBlW6RVrSJGqbhOJylsJjI+QyanC8VFW/OoeyJQi3OOgY711bh9fFj9KkhyGK63JktxEUWVKaIScHmK+SorSFedeJ865B7t1SMbHxD9ahPZzF0n617xkDauSdsiuScivYnYoHlcYBNGVjkriWtq7QlcTjeWpcdZyl5FBjSU8XC5lIVyVjkaIQ8bdbGggEpA4V46g86rvXcNsKpYjrJqa0Lc6xdrW8r2KQeJlYO7auqD6iia06zYmRREuyQrOEuY5LT94eRHOgXT9zZBetNwV/mEo8Cif9Ev7Lg8vWmctuTarq7DleF5lfCccj5EehG4oOzSrb9HZ1HQ/D+dZdv7y+LVNLMoWyY6HOJPHFkdHkf/ANhUyopAxVNWHUXFGRbpjxS1xBbDx5sL6EenmKtGzXMXWAe8ARJZPA8gHkrzHoeYrM6/RNSdx/nxlNtX+Ygt2jaO09qbSzkHUFqclwEhSw9HGZEI4z3jfUjzT+BrFGvOyS9aRKLpDdbvenZSv80u8LxNuDolYHuL8wfI4r9EwjjGDzFZt7WLNfuyW/yNWacjtz9HXhzgvFjfTxMIcV9rH2ArooclfKmHg2vdW8nPXoD0P7H8D+MghDekzF1wg4B8ODQ4/GAe4TsM7mtA6z0TZbppt7WXZ869KtTfinW588Um2E/e++3nkv61SVxj8KjtitE+HGRKrK8GD9zisRZq2WZLclCTgOt5CVfWovhK3cbeLbfYVJyWjxHNR60HNA2DmDueeI0ubSmoTKFcOeNR2OegqJwfKpi4j/Mmh/MfyqKwaX3r6pAmamgvpvSY7EZBW+4sNd2OZJ2H51pSwdjOjo+moaLvcbsJqEhZQHEfwleQ8NUr2c9jOpdU2r99+2s2S2nZuXICip0j/VoGCR/NkCr8tUGfYbSiBMuz13LScImuDhW5jmkjPMdPStP4lqy2Epsww64/fp9kC0GlCnLjjtItnsBtH+XNt1Bpy+PvxW5SXpkKWQpRIOQpKhjbixkEVcDV/S1GWZSg2triDgJ5Ec6qBnU1ziTVusPrZVnw8J5VzL1FImQ5CJSyXXTxFwbcRJyc0ov0F+qYee+4Dp7zQ0VKBjEsm49oLBecYjtpeYCMJX95Y3z8KEhqW5C8InLmLJKxxb7YJ5fChBLzneJSD4MZNdPT2gy60twDwni33HxomnwyqkFVGcw5UCjiWDpfU63Z0sOPEsF1QbUN/wDEK6d7M9Lz4Lgi3a4NTXCVJefwUKUTyIA2quIV5fZaaEN0tpQAEhPX4+tFyL9dY2mJl1YiSZK2WVKSltJJUrGBgCh9VpLKm3UttziCaglzKouaHYF2kwFqSpyO6ppSkHIJBxsapftyvy2rNbbChZBkumQ8AfsI2A+uatWHIUtSxLCxIKiXEuAhXET1B351TOprDdu0LtKvsiwxfbWbM0hjhSochnOB1JOdqbqWOEHWBV0mywIozBfS+lp07tKs1oucVbQ40zXEKwctpHEDseROK1oyylqMhIGNqoXseshjSJ96fQoOKeTDaDmcpCTlXPlvt8qvziVwpUoYCuVeuYs2TOW43kDtPs4rxS8NqPkCfwrsNKWyt1I8KMZpB1CjHcIBxwK/KqpWAY1tgKbLHSN8pzn5mn450lYIpkx4jO4T3YJI8sVJsW9x6c5GbIyjfxeVcZgOsniN0JBriW0tDPfIBKm/FjzHUfSpJiEoylsPDg4U86+uuWxHQMZKeEnzFQ3ZOBJBOMxCPGEuEXWXQVJHFwnqPMU8hREFkiQykqzkK55FQtlkuQp6468lDasY/kVy+hyKkAtbElQaWcJO2DsRUm9pNcdY7lBHeJQcBOOH4A8j9aRclLdZbbyQEjBFN3VrecKlHOdq8SCVZPWvASQMdMJTxjyOxqXvjomaXhXZaeJyCtMOYvO/dK/snD6A+En1FQfed0kK8iM1NWgsS5zlnlrxFuTSobpzyCxgH5HBqm9TjeOo5/eWp7GR7ThRsFUc6W1N7C4xJWSS1hqQOrjJ5K+KT+FVRZXrlEedsV7SfboilNh3o+lJxxfHbcURsLcQribOCBkgdR1qFiV6qv4GXlDU5RxNIpebWEONLSQoBSVA7KFNb1DgXewS7dcoiJcOQ0W34yxkOII3Hx6igvQd6VPsC7epeZEPxtZPNHl8uXzFHKFBbKHUEYUAoVjLtOaLCp7QR69hmFtfaS1N2L9o6JlllO/u5/iXAmFPEiQ0ebLqTsrbZSTzG9AOrrFa7zYl6t01GEZlKgm42wHi9hcVyUg8yyo+6Tuk+E9Cd564tendRQ0aH1U2lMO7Z/d8o4y1ISM8KT0X1T5jIrEOprJqDsq7T5NouUdLhbBQtCge5nxl/mlQ/wBlQ8xWv8O1f9UmH+uB94/n3GWdRgylJbJSo7VFPtYV4asjWOnWLZc0PQFqdtsxoSobiuZbV9lX8ySCk+ooFlM8KjV91fGYFYmDIG4J/wA2QD94/lUXwipm5pxGQf5jUPn1pTqBhoPP1Rk3BKLJDat6UoiIYQlpCNgEcO2KF5dxmgrAfWhJOSM7Z86rLsX1hqmW7F0nOS3dbenDbUtSuFyKDyCs+8kfhWmp1psGn46G48RuXMSnjdffTxfJI5AU1sZdI4rK5J6fuZdRWzHAlOLlpWSpa08XMkVyl+PIaUjvAQRg4PKiK5uyL/Mkd2iLHab2JCAkfhVf3q3zYbbzluVwyB7uNgo+Xzo3d6Ccc+0fafSEkbukIXHVW9DLS1B/jThtad+Ijp8alrTAtMOGszIqZj7/AInluHn6D0oTe9oY081c5XGylCQ8UjJ4TndI+P6VMcNxnNoEcmLHUASsDiWQfypfodU2prO/gg8xpr9JXpyu05BhpaY0IktoishA3Qnh5DypLUev2NIOQ4QQlUiSvhaYTsSOprvS0SLGYKEy3XHTzKzvUXqzsnsWpZ8i8C53GLd3EcKJfelxLe22EHYD0FUu1XnEW5ImfutAPpEC+17W+m3ZkWcytr22JHWqU43jkBlKVeZB/OssruQ00wm4NwXozlwaMpuVFnFXfZJOTg+Eg80nBFNe1h3VGjtTzNC36OGpCVpcVJQoqRKaJylaD5Hr67UIacfjTtVx4FwdKI7iwOEfbVxDwjyz5+lHaLW10OFr9sffAqdQ6OWHBmrNIwhE0zZ2X3CuS4kPvLVzUtfiUTRu5JSW2muiM/iaC7ItyTd4yUpwgK4E+Wwo6j29oLdEhwEoRxDBq8jHLSAycmSluQhVncBGS5+VdtwgLO93g8a0qIHl4TTVcgMIYQ2cAbq+FdJuDheIH9mo8NUkE9JdlREdJqSiAXTsEoSjNTiXmG9Q5QoBTje4HKhOxyCLI40k+Lv1II+Bp0H1+098FeIcjXCm4mRDYAkpPmEy3UoO+AnP50yedW+pKnFe6MCkOIqUSTknc16SQgnntXgMdJ4sTI2+S02ibDuCiAwp4R3j5JXsD8lYqXWvCkr6HY1A6jYTcLD3DqeJsqbJB8gRUhbw6mOuE9nvGfBv1T9k/wDXlVXmgWeWfbMIWgmrzB0ziSQIrzOFAZ23rlnxtAnmNj8a67slfwV+lXZkVWdKTxpI86cxOMNNOpJ40HY+RBrgNnhFPWElqM+pDK3lNguJab95ZAzgeprzuAJcqyW1RChSJDlzdW2wl5CJaH1EJDalDCt/iD9aGLfc2pLCJsRYeQlRSoAEA42UBnoRuKJWI0O/WS1y7jHSt2OtbCEKPElAUkLGRyJG4qLukFduuSV4HdOJwD5EdKSaW3ydR5J6GOHT+o04Y/WXiOdM3xVm1UlxnvQhpwNr7wY40HB2+RH0q77ZKClPROIfwyFo9UK3H6iqAKmnZ6kg+JKUE/AjY/gfpVr2GfwR7FOcXs6lUJ0+o5H8K94pStgDr1/bn94uuT0x32haURrDQFw0+lwtTHUe0W54HBakt+JBB6Enb4E1QcS827t40QNBawUzA19bAoWq5O4SJik7FlZ6KOMEdT4huCDprUqJy9GT3rSQm4x2lPxSd/4rY4gPgcFPzrDvbK2zB7Q4msLJxR4WoYzd4jd2cFpxX9okEcilwKofwceblM4IOVPsf2I7fAwIHjEHrzbHz2Vz7VcIrjF103dCh1pwYUhp4YIPwcQf9qqbnJ8atq0vH1RH7RuzfVDK7dx63NrSlxxBwbow04lZcx1fQkHP3k78xWc5rOVE8wd60G4sCGGDn+fZK78EAiCd2SfZEf3jULiiO8N4ioH8xqB4PQUq1C+uBHrNW9iGkblqSVcLi5OlxbXFQG1lnw964dwnPkBuflV/P325WmK3HlvOXFlI4EFw/wAUD+91+de212xaZsUTTNjhNw7WwMBQOSVHmpXUk9TThS4hKnVymAgfbURTyyxrTusXjtCNOxUdYLuXGY/eEtWiO/l85UHUYCfP4in8mDsEOr759W2cYA+Aol9lbjMB1oFbjqclZG5HQfCo5uG47NMg8kn8ah5qt9kcrrHChfaBMjS0uJrJDy5b7kdxsOKYKyWyQeool4n7eO+iFSmhuU8+H0x5U4bWuVqeXHdRs00jB+OanYkJlDJRjIPPPWoPYqDBE62tyu1uYytl5gS3kgtpbkDfCds+tEHtfeDAViqB7d9Tam7NdKt3ywNwV/8AeDbTbr7ZUptKkk4x13GKq/U3bJ+0HG7NWNTuRIFnt0rw+0RY479oH3VqSSSgHoSKD1GzOVi0+okqOkIf2vn9ET5NmtJkOu62jZLTcfBS1HUeIpf8sndI586z92e2pN17RYmWcCPlx1QOUqXnCMeVQLts1e+lOs5sSfJYlOlw3F1XH3qlEjKjz35VfHZfpaNaLE3IAEm4O+Nzg3CVHp8ANqp0dZssBI6QRuvMs6zgMXmDHSrATxE/HFF3EVDmaDozQYvtvQtzL7qlnHoE0WI4sU7dczscE5G9eFwgbdDXIOwO+/KvQnJxVckBzI60KUh6e2duGYsj4EA1JNklQHnk/jUc0ktX2SjkHAh39KftD+KB5Iz+NeMkOkVyAv5V6Vfw1fA1xkl5Q8gK+eGIriv5TUDxOgZiDiO9t6Aocwn86I7zbvZ0N3Fsf2fgdx1QevyNDDj5DBaiNmXIQptIZQrG5xgE9KKW9O3q9tFep5xaYUNoEJXAkf3lczSTxG7y7lYHoI70ShqWQ9CZGsKxNW0ceIcQ/I04QpBkONpUCQEqIHSon2ORbwhLA/8AZFKbeRzKk/ez8MH5VJMpSq5JS0AEmOF5HXKudNFtDAEd4KKSuc9o82OB60/tqv8AvMj+Qn/dNNm2SRk05i5Q886B7rRA+J2FesI2H5S2qvkRxp3jFpW3n3XmHAPqk/nS9/mQygMrHG02rD8kqCG2TtjKjtxZPKo2DJVGQ+0FBJMdJBJx7q6yz2ja81T2o61OltHxZUq2QlFLEZjYOYOFPu+ZJ8+QxWf1YY3KV69YwS7yA2feaSU42h9uSl1pRQow3ghYUEq95ByPifrRXbLuTp1DIP8AZTQ4n0BTWLbDcO0XRuoToyeuZbUTXGXZSEse0qDYOy0ny3IOK15p2ItuyJiPKJdb4OMk7nwjemGnJYFbffMHudbAGAx7y69PXtNxtZWvc8CSr4jY/wDXrWVe23RLln0rPsrYccj2SaLjbnVDlDlkhbWf5HUfRVaD0SSidMiqV4C2pxHpyzU5qawWzVGm59iujQUzIYDTjgG7fFyIPmDg0Alo0eqJUccfz8xFjKAxE/N+23S52S+RbtapS4k2I6l5h5HNCxyPqOhHUEipPtHhQJyoet7HFRGt164i/FaHhhTE/wBsyPJJJC0/yqHlUpr7Q110LrSXp+6NeNo5bdSPC62fdWn0IpPTEU3nTd/0m7uJMUz4oP2ZDAKgR8W+MfIVpyA4Fq9P0lATdlZTl4azGT/eND/dH1+tF12a/wA1QMdaH+79BQOpr9cCYcy+uznVPaM7EhRpCoz9ukPpZYVctlqBOCWzzIFW/doyozykpcUvh3qj9OK1X2sa1cuECXCiS4SUONtn+GzGQDhIQkA9Rk/jV+QJlt1Im7LgzGpX7udEaQ637inODJ4T1GcitHS6IoBMDe3Y3MN7PqOFd4qBHdSpxtA7xHVB5b1ONFnueQFUfGlSrLehPt5BOcLQeTifI1P6w1oh/S/sVmW63Ikow6vGCyk8wD1J86XajQYcBOh/CM01IK+rrI7TvaXbZv7TF702XUm3SmW48KT9kyWgeNIPkrJx6p9at9SA1nfasSaitLzFrkuwXzFkM/xm5CVcJbUk5B4uh9aKNOftVXKPpCHFu1tj3q6tqLTzjbhaUtI2Ss7EFSvShNbUKWHPElXZv7y8+02PDuUC3xZsZqShD5khDieJPEgYSSPQk0HhaZoXDlNJebdQULQ4kKS4D9kg8x6Uhe9T33U1ts12iWn93uJQoybfJcClFK8YHENgRjNQLOtbK/d37NGmLYuyctJadbKFJUduJORhWOY+VWVOu0KJrtDSKKB5gwT+ME4to0ce1iQxaretuLARwSofeExXZHEcKbR0SBtjlmrehW7T90iKah21VsmJQVNqa2SsjoQKGbJ2SxIE8zbROk+0uo4SiRhSHOuc4yCTTh+5Xe0SHoC4UttxvwuKbQV4HoQKLpqGzHQxDq9JYGLFeD7RnbS/L1xBl4KY7JU3xq5rWdjj4VYBQE7DpVbouHeXOE/GcbcZTIRxqSMKTk8iP1qy17bnzqD5zFeOYmSSkJ5hPL0r1PnXRwF5AwDXx55AqGZKRtwPdXaG/wAgsKZPx5injC+KYtPkhNNL02TaVPJyVsqDqceh3/CvYkhHfPvE5HAjAG5O1d7Toj5Kgl5aiQBxYOfICmtwEmTCWhClMR14SSNluZ6D7o9edPoMYOMofkDKjlYRzAz5+ZpWUEuTWGidk5dV8uX40O/QiX1jkTiwxWGb5Fjx2kobbXxYA+6OZ8zR93yiN6ErMqDCC7jMfS2jBSnPMk7nA61KNXC73FzNqtLaY4wS7Ld4CQeR4Rkj51m/Ebka4gduJoNJXtrGRGVxHd6lWoDwvNhR+I2P4UyhNORr6hCh/CWwsN+mFjIp9dO/M+KXmkpd4VJUls8Q5dDTp+NwOW9SxhaQsK9cpyaKqtwtQE61Q+kjhCAU7bUvGbAZcVjPEefwGfzxSYJOENpK1q91I61JQovfwWFFRSACrbqriB+gwKs1Wo2qV7yqlNpDGBHaYk2bs1v10DT7ojwDH4WDg8a/CN+gBUCfhWduynRz2mo1o7TbpqJmDEXKMVMNSSpcxXEEqbAT5DKiVeVas7Q7RMuvYtf7Jbkh2U7FKkBW3eKCgs59SEmqN7POzA3f22DNlO8TXBI7sZ4UFQxkZGM8vlV3hVK3b7mP1cfdPPW9hBUdJcerNKuqvFs1LDaSj2Rh1DzoOFFCsEJHpTmG461eOLHhdYSfiQcfrVjM2T2zshYSvd32DhKupKU4z+FAymg1HjLcwnhRuT0BA/XFVaGwOXDdQcSVjrYvA6Qg07cmot4Lz6iloMrSoj1GAPqRVnsstOwXGkjwqyCepyOdUoGVrQnBKcb4658z61b2n5Qk21peclbKF49QMGgvFacYsEV6hO4gH2p9mrPaToFXdNJGoLWD7O4RjvQObZPkeY9fjWT9DWl+H2jpVIZW0mCzJdkhYx3aUsrSQry3UB863LPvL1rjvulgupZcAcSnYhJ5Kqoe1PTv+UGjbtdNFQG03KZwqnISnhdfQncgeudyOuKM8I1LqDS/1T0PtmdpqJ9RHEwlfo5WkqSnAyaGvZ1eRqyrxY5aYgU6wtCuIghQIOaHP3Q5/qz9Kdamrc5MXvU2ekHLferlaVuqtc2REW+0WHCwspLiFc0nHQ+VXP2U6nXobQt9h3+A+k3JSH4iE4C8hBSeIHdKTsaANLP6b0/Em3OSEzLvGwGmXAMDPLgB5nzP0olgSotyiOz7zbJC5sglSUPvlDbaeisDxKPxxTjw7QV2euw5PsP1MUilL+H6T2/dqeoA4UW7uI6PPg7xQ+Z2/Cq/vOqdRXNR9tvU9wqOA2hwoB+ScVYsPSF6uTpeZbZgQ/svrb3x5oB3J9aIrVoyxWH+NHY9ol81SnxxLJ9PKp6yobyFMLYohwBKWg9nt+vUf2m5yHLfEVv/AJwpSlqHnwk7D1NH3Yfo6xzdRzr73aXbfAJat4eUCXXATxvqHpjA6CoPtZ1o7HbXp20r/juDhkOo5pB+yPUjnVb6Ji3FTt2mw5D0dDUJbJU2sp4iv7PwwKzGp8tb1qRcnvDNJclFq2Oucdpr+dqrT7OsLNp+I83IXdVnMxCwpphO4ySPeJIxiojW/Zcze9Zt3qBqIoegoS2lPcAcKwcjxDn8/Oqs/Z90y3dbjKvNzmIbYtTzRabccAGTlR2PQ+lagkWObK1hCnRkNC2rjrE5xRA25pwMbk8s0fpkTYLG4mnSx9dXvccE8CTfZ4qRcEsNz4IQ7HTlbiRlDh5Ag4qD1lcHBrCemzy3Y7nFwLW0AQTw4I+PrSOqrxM0L2cL1GmQ6lcXGGEOFIWhaiAjYcyDnPpQ5Y9SxbzaI939ncYYlJ40qXuAeqVEciDXVX1mwdOkG8TuNICoeZFR7Gw5bFP4KX0ZJPUKBzvRu0938FtxO/GgHPyqIukd5+E6u393xujC1ZGOHG5+OK80pKD+lYWTkpSWj8UkipMZnMcydHjbB5HH410M43rnOFbclcvjXad9qrxO4nKm0utraUPCsFJ+BqEsmY6JTUhXG8xlBJ6AbDHyxRClOFBPnyqJnxvZ7qspThMxITkfeB3/AArm7tJKOZMxAoxWgNvAKj5klmLFkT5UluO2UqIdcVhKG0DdRNOJcgR4PdpWlK3AUgk4wANz8AKy12mdp12u+qJUW3z3H7CgiPEgpSAl8p5qVjdSeLfPXApbrNX5eEXqYwpUVjzG6Q11527NxGhH0ewIrYQEJuc5GXCNie5a6b/aVv6VW2nnO1DW9xkXTTI1FPW84lEiYiQpCXFAbBZBA2qIi6cbkuNXDUElb8iQAQlPupzyA2wDjpV29m6bB2WXKBcI2p3bkzdFojSbdGZUlqLxYw6oq2yCQNh50Ovgd5XzNvXn4yZsutYFun5Qq7O7N2jWy5w4WqGdQFCEf+0xXUPJazjwkK/E86u2ZDcC4bbPeur4ScuDCjtjJ8qmIxwnOx9acgJ4ys+8RjNKixrcMO0Zq7bdhkfBgCM2ounjdWMKPQDyFP0DhQEpGABgCvSAa+GBVTOWOT1ks9os3jPiGR1HnXEKDHtNmcQwye5SvCS22VKKScgYAycZIpVhbQfQXUlTefEAcEiipqNp55oKizlxl45ceD881wahqenedWzySGwZ5px7v7PGjylrixkMFvuHU8KlqJySfIAHb40EO29LCn7ao94tKy0pznlOefzGMUSTob8V3hD4ebVulxPUU2VHJkx1FACloUgqPVScY/BX4VZorSlhYn60g9YANingwYUhaWuWCOfx2NF2kLl3DMVpxXJ1TXyO4qJlQuJtbiBz3QPMDAH1waSsr7X71jw0rAdLvfcPUIAwD8zkfKnN+26kgwB8EYhndpDDesWIz5HstwiraWD94Hn9DVNyNSy9Ea0ft85S3YyXShWdyBnZQ/CiftK1CzY/3Tc5TvA0mYI5X0BcSUj8cVD9o1ri3iLCvRSB37aW3VeSsbH6flU/DKAoVXHpYY+0f6llC7cKe8HtYaa0tq6d+8kz2o0d9riDqMBId9fLPOqx/wCzK3f/AIghVOXOK7ZbSzDbX3jbylhxK90ub7A/LrQj+5rF/wDJ3D/900zANfpzkCQtRgx4zKg0tBtMC0K1PPbD8195TURtYylsJ95zHnk7UUaJn2659q1sZuaQ9HU6SUE+FS8Epz5jONqAVMypPZZDmxJCh+75brEhtPRLhCkq/Sl9LyRb7/bp6yUBt5KyT6HetR4fYvkipFxkcn5zNV7SMDr0mnru2pcx0rTlJOwAwBVfaxvSLDZnFNYMtwFLCPI/ePoKs7Uk+2WjTrl4luDueAFODu4SNgPjWadRawsFwuri70+4lUjIQUJ4kNJz1/KhtyY3OcASjR1k4Z+glbXNDoaeucjiWt8qQypW5WT7y/0q1tLaNVbezaUtTXjTHLr6sfbUOXy5fKgO2Jc1j2jRylnggRTxpbxgJbRyHzOKvpx1hGgHoQekCU+oqcZAw3jknJ60j0qB7GuA+A/WHfWOZRGlLhIs91RcYpQe5eU0sLTxJ4Vbbirogay1K7EMF+7SFtKQUpSk4GOqfhVGadSt2bPhuDfiz9Mg/lVwaUt0iVbWXVtLKmiAVEbHB6H4Uw8PO+vpxDNPbYo2oxAnfaBeb9eOzkwpFykPxoy0uhlRyMDb8M1O9j14eFpbtWAtksd4AoZAI51Ytz7KLGi2LkLu6WoSm+N0ulPCEEZJz0GKqzSZtDEoPafndzAU+61HkLVuEBRAz8cV3dVZkp0x+MLu09gQtYess6e5CTEeVDQlmUQW+5zjOeZ4eo9RUVpB8qNxgloMrbcDyW08gDzx86H9YXMKuLDLL7biWkZDjZwQo8xkc6i9K6hdidosFmdKUpEjiYAWd9xtn5ilznBis9ZcvAFt4zjIBB8q+bzxEKGDnB9KTjrGFNZ3QrHyO4pR0pQoOg7clenrXMzvSKrCiggbHmD60wuBckxPAMPMqC0p9RzHzFSTbiFpIPNPOmlygSJ8buoVwcgLUcLeaSCvh/lJ5H1rjHA4EtTrKZ7ataxIulEWS33SS3dZ277bCgA1G6ocOMgqPTyqm7LZ34Nyg3C5QXOB+Pxw0Opx3jZJAUB5EgjNX1L/AGa7RfLjNWxqe6ImqIfQ7LCXkvIOx4uvEFbE560QW7sdvsrTsPTmpVw3pFnbKLNfo++Gs5MWQ2dyjOcKG4rPaa0V6zzLx0Mb2aV7lBQcdpXV7Z1Vc+yODp6zwA5YbfNFwWzHjAvF1QCfEvmoDOwq1YvZOqZpJPtcZxlx9gK4SBxJUQCM+RzRrpJhFncZs81MeBJaSP4RIAWPNCuSgfrRvcZjXsjkOM80uatpXdpOSkHGMqI5CtNqvFloOKcYPOfeO9Noq6VyeSw5ilnhPRNJW4z1pMn2VsL4FBQKgkA79eVKBZqMtjb8O0RYKlt93HaS0hLYOEgD13O+TT5JPWsTbcLGJlH9Ma+sXyTXW9JpNKDBNVyk8RRNKpKeKkRXaedeIng5HSHLEJD9lhEAYDQNNrxES1aWXOEENPpUoY5hQ4D+Y+lLaYkKftamF79yrAPoac6gSBp1/O26MfHjTQqMVsA+MWm1hZsJ7/nBCYl1boSAUoO5V5gdBVUdoep5Wgr9p/UAhLkW1UhyLMW1s439pJHQjClbelXY4wk8+nL61XXaVptWo+yTUkWMnikxeGaxt9pvcj5o4q0mluUEBun78SLtlDjrBft2nwL9+z8zcrY8mQ1JlRlsLR1zxH5HblRDpyRE1L2V26BMloDrrS4DjgOe7kISFJJ9ayUjXGoY+mP8mxPBtqHxJQyUAltwZ3SrmOZOKsHRGpZVr/Z4vV3aKluW6/sSAM7qykcQ+YzTf+mK1hAejcfbxBE1G5oI6i7Rb7BmO2G8QkplQHFscfmArqOvLY1E/wDajdv/AJdmpvt0jw16uh3dkAMXOMiW24BzCgKqnu43+tT9ak7tmefVW7iN0c6Hmhq7SLc7HMqHOYU2/GSQCsAZBTn7Q3xXr9tipkOxbPIclFCipLTjZQ63w5yFpPXFCbXeJSlSSQQeYOCK0B2Hx2NU9pemo9+gNyHO+UyZKhhbzRbUChZ+0AORO9NtBrhXWwI+qCYkyAS3eVPd9ZXSbpuPZZdzU8IeUMNqOeFB3yT6bj4UKu2J82J3Utz4m2nFd1AZIwXiOa/7oH1NbC1X+z72V6S1LcbmiNJMSMC6WpL5U22NzgDrz5VmfU92/wAu+09q0w4qo8RLgYYaAwG2huTj4Cg7bDq0FjdO32y6i02fIQj7JtLuNWMT3EHvpqgU7b8HT6nerR1aiFCsrDPdd1KylpSCMbA865sUdqJbBwJ7tKQEtADkBsMfSojVL7869stLUpSm0Aknc5JoimoooUdpYhlDNMBGv2gjjwmcslKBkkZOdhz2/Orfia+dt8P91lhCoyMpWyBgtHfBB8/Sha86O1DaY16vsGc1AZUlx4uKwHFtjmlB6ZJI9aU03oq4XS0x5T144GX2Q4A2jxAKGcKP613TWHT7kZc55h1bPQM46yN1PqqddtM3Fg3FwIG3cB7YDi5Edc0Qdj7EhzS7zz7f+apWtIKxso56UzhdnunxqVUZc5IdjPJDyX1Zynny65FWMzDZtUGJaoqklpBITwjAxnPLyoR7rLrN547Qd7mfljDTSES0WawLv8y2ImTpL5YiMkAhIHPGdh6mn94fsk491f7EzEeQQtp8ICg2obpIUNxTPTz6JVjtKQM93MdZUPI5zRlfbGm6xmnGXEMuNjhPENlo8jWR1RfzmYnnM2GiqQadARwRBpp5Kno8tpYU1IRwEjlxdDUgOWCNj0qIgwW0wpluiOBaY6uJojkOox6ZBqYjvoeitOjHjGfn1FaSq7zFDe8zGop8tyvsY1QHIsgN7lB/syev8h/Sn6HcpC07pIrhxDbzRbWMpNMyt6K7gJ4yd8f6z1H83p1q3OZWsJ7Q4lUtBScuoyUD7wI3T8x+Ioob7pxsONnKVDINVoJHtCEuwncLbVkp5H1B8jRfarx3qcvpws7uYGxP3wPzHzpJ4jpSx3rHmhvCjaTJpxtBGFNoVjllIOKRJIHQAfKnQwpIUCCCMgjrX3dZ3pCwPSPq7AOsRRkjYAY6jrTlvPU5rxLWKWQgDpXFWVX2A9J2kV1yr4YAxXQFWjiLiZ8Ca7CwnckADcmkZD8eJDclSXA2y2niUojOB8KirhGev1t9jC5MFh0pK+A8Li05zwnyB69cVxmAllNRsPwls6WZYFgblMrDgkePjHIjkMV7qJf8CJFG5ekBRH8qAVE/UJ+tOLQ6hVki90hKEBsJCUjATjbAqKnv+06idGcoitBr/ErxK/AJoepd1uYkIJtLGMZKlgAgcxURHkNxbVc5cxJMcPoQ4MfZVhJ/4qnnwnuUk+eKSYitr0ldlBtC1KDykpWMgqS2VJyPiBTYWBU5+E75m0Zn59doFgOlu0+82JYIRHkq7o/ebJyk/QiiN24M2D9mNEE47+/3dTyQf9UykJz/ALWfpRN21M22+aQ0Z2qOQlui4MGFPZjr4P4zf2SenUeeBVFaj1JPv89hTyER4sVoR4sRnZthsckp9epPUnNaRLdyAnr+o/3Fr7ayx9+kN+0KWm4dh+iLkpQLjTb0In0Qvb86qDvaP9QSFufs72NCif4N6lNp+BQhX5k1W3F/1iqrW5ldh5BhFHiwWX+FQ9ocT9jkkf1q4+wa5FPb9p9UlxCGmS6s42SgBtWapxrwucQSOLqaMtDyG0quElhSvaeERm1IPIK98j4gY+daGtPMBpXjcCPviutWtcKIf9t3aHO1DcJESI4UQHXy4rH+kAzw59BQxofSCWe+1LKZxJfb4WkkbpR9750Wf9nsuQ01dr7GWxHR4m4zgwpw9CR0T6dalg2WmiBgbgYHxoi/T0qAtX1VhrtXW3k1c46x/HhtcCUJGABgUOexNzr/ACHhuCSkH0G1TMm4eyQHHAdwMJ+J2FNdPhK0Lc+WaCO5eZJYw7VtaxovZYhM3Tae8WhDcVasFpw7jiI+GfnQPpC5SHtHQpbJShfc4I5JAG2PQUn2pS5lw0OuJIfK48IpDCCAODKzketSnZnZ0S+zOGp5sLQsKBSrkRxdaHVytm09MfrC7dQ9mATwJGJtDydez76+oKL6UhpH3dvFn9KLoDTsh9TxyUtjgTnzPOmbkMRrk4wAeBC8DO+BRZaY7ZajtYxxguK+HSuABRxKDHmgZTablLsjjqG3nXfa4hXyUsbKT8+dWRclpm2Z6Hkx5Kk/2SzjOOgPUGqMvUB5EllUdSw4EqcSUHChg8wfOiOy9pcxqIiHqJhU1tOwkoSCsf3k9fiKQeIeHu7mxOcx94d4kgQU2nGOhhOxKhsXRtTRSgLSWFoB5HmPmDTZqc25dH4SXWu9T/GShB3AzuCPPO9ei4aWvsdx63yYntSRxpIPA4FDcZBpV21IcQblb46EyciQkpSMrON0n4jIqiiw0gZ7H8DCdXULy2znIz9o/wBSRbTxNpcHuqGaUVHQ83wODKTUZAuTalBA/snfEgn7J8v+vKpVlzOUHYj8qdcxAp5kZIhKjvB0lWfsvo2UPQ+deWSfeluyETGY7q47/ClyMSlakEZSspPU7jbyqYU3xgoIyk8xUjpW3OxLtIkLCSz3YS5kZPATsr5GhNYzJWWQ8iMdJsL4s6GPbXPVIUGmpC2x9ttKRxpPmEn9KKGg063lpYWBzPX5127bITqeGRGbXjkSNx8CNxTRVljh5LrUiYhSeRDuf03+dZ13SzkjBjUFl4ByI64Ak16BtmuW45Scrfdc2xhZpcIAHKquBPMx7xLFe7jelOGvuGvSM4yCMKSCPIilWUt94FcIzXIQa7QkpWK4QDJrntLFtgjwNHmdLUG2WWlPuKPRIBJP0FBCLog6dsl6bX4LxLCyT171KiPySPlUV266vOm/2fHozSwiRdFtwEYOCEkcSz/spI+dVfd9bC2/shaNvHeEvRby00MHo0tZ/Ki/D9EzILj/AJNj8DM81pWxgZe8vjTG67EUlGfLVvjRFe9JLqyPQpIpczolwtjMmOoLakJQ62R1SoAj8DX0GMqRrJltxSSEjGE8kjHKu59BDDpkyyx8LiYigXJ29/s/670e8StdnmN3yGDuUp7zungPqk1TCR3zyQlJUVHAAGSaufs/YS5243zTRbCkXWNcreoH+4tY/FAqobbGnSr2zbLY1mW6vukY2wepJ6AYJJ6AGtGuAxHvz9//AJF5XcAT8oR62KLd2Q6Xsp4S+7Ikz3sHOMkNpH+5Va7elEOs7mw/cW4UJ4uwoKRFYcP2wnYr/wASsn50K96P+jQ99gD4EruOW4hhcbVdPY0M29njU4MrcBAwPIVrn9lns0tGntCOau1DDVIu6nVKajyWvAykDwqAPvE889KAf2e+xh7XF6TqW+ocFihrylCsgSXBvw/3R1rUer7m3bNMT1sKQEpYKGwnYJSBgAfWjfE713nS0k7jwcdvh9vedsSuitivUyrNc3FVykuylucZfeUvizzHKgB9ACUgHmqijUbZYREjZOUNAH443oXmKShtJWMgHOPPyp3SgSgKvSK9KMmRV0SpbS8bpaGfio7D6VI2iOYsJtJ2OxNIPJ75bMXIGT3iz8KkzhKBjlVVhPSMZU+u48uPp28kwkOsOlJDylf2OHM8uuc0WdlzzjnZhFeeIWrjcGwxsFbDAqO7TFd12czMDdakI+qs/pUp2awHYvZvbkLyCpKncf3lEihnr9W74Sf+OY4nto9pfcKcKKskH1qatDBERL2SSRwj0FRNzQpV2ebPVxI/Cii2NBFsaH8uaieBPCQD5V+/ooxnhbXn61Gv21Ehb6GgEPNqyAeSgeVT620qvaDj3WT+dJSW0x75k8nE4PzFR6z2JXz8IrfKHWsKScHzHwNE0pN2kdnttegXWbFfjKXFeLDpSVDmnPntTyfBZfCsAIdHuq/rSFufdRZn47jSktuOdwpah4UOc0b/AIVXZWGGGHEtrLKcqY17O7wtDj2mrq6pTjZLkd1ZypSSckZ6kHerQYkhOOMp4hsccj6/A1U1ugherESHWlIXwKA6FKx+oo4iynFKIcXwrScE9AT1+B/OhlIVzUe3T5QpqWNYuHQ8fbDJt9GygaKtIzIz9y9kcSC4QeHPJaSMKQfiKrqLIIVggpHVPl6ipuGHWpCJDKylSSFAjmK5fSHQrJUuM8wsfvM6y3p+zz2Q8hnBZdBwpbR9w+pHI+oqTi3qDIABe7pR6ODhrySw1qvTzUgcCLtB3AJwHmz7yc/HceR+ND62e64mnG1IUnZSFDBB8iKyVymtis1GnNWoT2bv+8Mmwh5HE04hY80qzXfAU8xQH/Zqy2Sj+6cflSzcyckgNy5A8hxk1RvMuHh7MeGhrw16EUNRW9ROXJ32i8Ox47QDaWUtIWpSsZUVKUNgMgADrnNNJt2uUS9qgovkjhaiOSXVKZayOFJIA8PpR9OhutGVHbMS6jW6ehzWzZI9oaBvPSuwyrGeHYdTsBWZEdrmu5aLiDqF1BaYLrXdMtIwQoZ+zvsTQXetdapvrZbuuobjKaPNpT5Sg/4U4B+lM1/45qs4ZgPvP6QT/uaB0B/n2yy/2k9eWzUd2tGmbLLbls2lK1yXmjxILy8DhB5HhA3PmarzVd3cT+zrozTZUcuzpk9afJAVwJ+p4vpQopaCkAADOwr6fOfnpjpkKChHaDDaQMBKBvgD4kn51oadEunpSpei8/bz+8RWX72Z/ebA7I725dOxvTMlwKW63HUwtXRPdKKAT8gKsDSctbmonZDh2QBkn1P/ACqov2f3HWux3ikrV3PtLqWEnkE5yoj5nFWjFls2zTM2f7qiw/KJ8kIQeH9azWsQDzFA74h6HcoJ9pkbsnnWlr9q6JOuUjhDlxktsNoSVFxxwOJSD5Dckmqout2ZtarjCssQxnpDjjcmYtfE6tPEcoRjZCD1xknqelEHZg86/wBu9hnYJ7ueuas+SUIW4o/QVXlxlqk3B5wAkuOqV9VE03OAxPwA/OCs5C8SEuPElpJPnUVxnzqVuSj3ISRg5qI4qV3j1wcmfrHPulo0lboWidPMNsFpkJU20MCO0BzP8xqsu0jULbMS3WVtYL9ymtR0ozvwBQKz8NqdwIkqy2xTl6npm3mT/HuEsnYrxnhH8qR+VZ+Tq9es/wBpe3PsuKVAhrcDAPLhQhRKvmd/pTXQ6Ja/VnJ7n3PvKbXZzky09SS0Sb26RyTtQlM7x2WyoYDPEcfzEdfhmpJaH7lcnEpUUoJKnHPup/qaRuQT7e2w0AEIQEpA6ZrQ7SihfaU0EKyoOveNo7OQ7JVuV4Sn0Ap0tJDJz0TSnClDSUDlkCl1ISWznrtQjvzD4F60tJvOnhAL6WU94l1SiM5CQdvmTRVaoyIlrYjNp4UNISgDywKDtT3F5ztBtGnYboSFgvyQOZQOSf1o6aHAyBXrWGxcS9torUDrzISSkOX54/dJV+GP1olaT3URKAPdRj8KgGmi7f3R99wD5Dc0RuDDK1eSSaHbtICQaMm6LwN+7SPxpG98SZ7Ch1T+VPYyP8+ecI38I/Cm97TmRFA5k17vOxtNYPctSBnCxg0+i2qXN0jcYrToDT6kuKaKc8Skbgg9KUloSq3IjpI4gPCT5ipbSjiktMhYyO/CFA+R2rxyVllYyZHf5O/uzQ0PUE+QhKXZYaYdcOMq4chKj64Iz8KaTZ1uir79Li+MDHdFtRK0n7PkfQ5ox7boyYv7J96jMoCTbXGnQT9kpc58+oVVBdm8vWzloVbm27gu3nKmZk1tKRH/AJU8eStPltgUjcm+7POQeMe0Or1RprakgEN7y2IFwiSENgOEpUOJpzz9D6ippic9FIP2fvjcfMdPyquLXbNQ2SK4u/XBq4tOulaltJIUxnrnqPltRxbnyWkhxYVkDChyUDyNMgAy88GBg88QytGpmocxDzzLhb5LSgcSVJOxFSNxV3cyOn94syo77fexHHTwLcazyCjzKeRBoPZUIy+8aVwHqnoflRPBvNrvFuFlvjTKMK4476k57lzlxfA8iKVazQ+Z6l+2NNLrDWekcmEoIQ4hXGhYyCPyPrRRo2ysuzHrtMQFRoaC7g/aUBkD9ariXZVW6/kS45Q+nBC0rPCpPQpwcEGrQsbFylaOlxbe65Dalx1spcdT37TSynAWN+IDPMb0p1Xh7VKGDAgxu/im+op0JjCLKQYQedH8R7Ly8/eUeI/nVQ6/1Ci1atvzSlcJfs5S16qUAnA+RNXFM0/cLDpxtN6mxJM0RS4tyIkobVgYBAJz5VQvahBMqLYL8oZU/HXDfx0caVn8UqBrUeFeU75U5B4/X9JiL0LWY+Mq6zFa7x3J5SELY381JIH44qLUy4eYweooijshqW26jZSFBQ+RzTy42xpNzk90PAXVEDyGa0L5zJDSsTA9xT6YZjg+Aq48YHPHn8hXths1z1FqOPZ7a1xvunKlKOENIG6nFn7KUjJJNTUq2LA8KDilXbnexZXLTHLEOI6kJfRDYS0p8DkHFJGVfAnFUW1Mw9PWSNB/y7TSXY/dLRe4VzsFkj97aLJ3MSPLJKQ8rBK3MdeIgn4GiLtfubWnuxTUMsLCHHohhtAbeJwhIA+XEaGewC3Gwdkvtb7fdOXGSuTlQx4E+BJ+GxNAH7SesxcHrZpmO7/CaHtr6QeZOzefllX+IVlbKDZqyq/VB/Lr+MKJIXMqXQ8E2nS+r9YK8PsNtNvirP8Ar5JCNvUNhz61UkpCmncg4KetXr2kXK1Wjsj0loayqT3vci73daea5LqfCk/3UY+GapJ5lb6HVN4PdjiI6kedMAhZN2Ov5D+Zg9vGFg9dHP4KVKOSVGobvBUtdUEx0EfeNQ3CryNJryd8oxN19qur2dPaGkNrkf53NSWWwDvg+8fptVRdi0dUzWF1uhaTiNCUlBA5KcUAPwBqutYaynas1EqbKcUUDwtIJ2SmtH9jWjJNi7J0agmNcK7pICkJPPgTkJJ+JzWorsAYLA9TZtUkQtfhot9oZZAAWocTiupOKGnG1LnGQoeFWeH4Daiq8KMmf7K3sltPjV90dagpqP4rYTsnh8I9KNDErz3gmiYl8nqYyUT3qBnlk17IkIYjd48sIbRla1eSQMk10hAK1L6BNBXaVcpLOn0Wi3NLdmz8tpbb3PAN1H9KoPJxHSqWOBBfREh7U/a7ctSupPdtIUlvPJPEcJT/ALIq5RwqPD1AoI0BYBYdMR2XEj2l8988R59B8hijVPhacX6VS5yZM9cTi1x+O6PycbJyB8TUnLSEw3D6Y+ppKAO7goyd1eInzJry4SAGG28++4B8hvVZyTOiMo2y5Kh1WfyphcVh2bBwetervNptzZFwuUSKp1ZKQ+6EE/AGk2giWiI+wtLiO8VhaFBQI9CKsAE7iPJLai4nhPKrK0PYY0nQF+nLZBkxiFtLP2TgEfjVXIfWZBUc8Jdx8qurs7fQ72batb2ykMn67UHrnZKsj3H5iW1nBkX2r2lgW6DJKeJ6aye/ZUcoUtCQoHh5cjVVQppUjhdUEpSNlny9as3touvd32yRYZC3WEl0pztjAG/x5VWiYC03NTQb/hLPGkEfZO4+ld0Izp1LfzmRY5cx4tCy1wraDjahu2T+RqMZW7bSsIW45GBynAytB8iPLzopEAJZT3qwg9OLnXD1taeRkNuuH7yU4x8zVh2mSxI9i4qLCXFJUps/aScj5H9DUhFdZkYKVhQ8jsRULL0/PCi5bX5MR8/bSoAH4g7Gk4Nt1607/Gas05A5LUCws/7O1eJVRLVaWrZnJEmI1bLlDXcYgP8ABWhYS9HJ+6rkU+h2q39OByy2dqK5ElOsp91xIBUAfvJB/KssW3VktF0lRX4SoXsTZdky0zEKjspH3l9PIDmamNP9o+odSXBMLRSLrdHM4L7KSzHR6qdV0+ApLr9KLFPqAHWEf3fSJYnam9cldoLUu3+1SYUiG2hDbTS1BBBIWgjG3MGhi36PvWtNLyrLFtTriS83KjyXv4bTLo8DgUo+aT0zukUdRvbIlr4dZX1V4lkhRhRsoYR6LV7y/ntXcjVtzeQlphYjMpGEtMjhSkUCniz01rVSAdvf5Qinwh2IfOPnBq0/szw2+F7UGpFKVzLMFAAH+JWTRejsD0A4FFaLipxRyXPajnJ645VDG7zFklUl3J5+I09t+o7nDdBRJWpI+yo5oa3xXXucm0j5cflGX/WW49DjPykffP2coZjKXp68eMcmZqefpxp5fSqkk6GmWXVjdou9ieelZymKpQQ27/j6p8+Hf4Vq6xajYurYbcIQ9jkTzpzfrExe7YWuIMymwVRpQSCpheNlD08x1FX6T/kOorbZqDuB79x90U2Bkfy9QPtlH6nvKLDpCMi6vNgttjjZjp7oSFAeFltP2WhsM+Q86ydqqZLvWpZd1uK+8ekOd4vGwx90eQAwB6VbmuY14h3yZCva3Fz2VlDqlknPqPQ8xVR3VKi8SRWw02lWusMOc95Rq6DXxIW8onS2DdZKD3chxSEq6ZSBkD4DFCK1PMPKU0ooUQUkjyPMUWyn3VQxFO7aVFSc/ZJ54+NQEmOSkrxtnGfWoXqccQCwDAxBa6NgQm8J8XGRn0xUJw+lE92bIiI224j+VQfdCkepT1wcw50JpR/UepIyAypxCnkNNtgf2rhOyfgOZ9BW89Qx27PpK02mO2OGOhDaEgc+FOPzqpv2etGNNSG9RrjhLISWbegj7PJTnxUds+VXdf225F7JdI7qE3kn+Y7/AJU2uZa7lQc45P6RHr9Qu8IO3X5ytbmBDjFhSsvvHjdP6UNPPkrJzudh8KkrzKEqe6sHOVHOOnpUOpB4zjfb6U3HCcxho6dihj1M9XJQhl1xaghCRkqPQCq8i6ht161Y93SnFTXlezseHwoaHkfXcmve1LU6bPY0WiMvEqX72Pso6/WhjsnjLlapdmuboYbwCfvK/wCQqkWbMsI209rUnzF6y7ojCEuJAGyEU4fATDKBzUQPqaQiuA94roTgUus8T7LeORKz8BQpznMrHMcpIA4RyG1CWudRMadsrt0khXdRm1OkJ5k8gB8zRYyn+GpWMk8hVR9ui1iys21XJ6Q02sDr4skVzdtBI6zpHEq69zXpV6g3y6MpSl5sFKXfFjrwnPWi23aiVZrei5WCSqL3qwktK8TKz6pPL4ii3SFrts6Etu5W+PLbSBwpfRxAf9CutRdmdrm2hTVlKoa0rLqGSct5PMego5ba0yjL1k0YAYMcaY1yxeXRbJjCIlxbPF3YOUup+8g/pV+dmry1aT1a2lXvtsbf4qw1c3ZFimtxbkJUadGXxNPpT/Zkdc9RWney3WNygaMXfr7AlRochADrwbJbe4PGFpHltuKB1iK9TKp54P3EGSQcnE97TdXW+L2i3d2bLbaYglLC3XDhKSEgn8ennVU6j7aJS9OxZujmkONcaoj0qS2e8ZVjKCE+St8E1W1+eu/aNe37i1c1uxXZbsiVJkDu0d4pRICEczhOKM9LWHTdsiey92qYXMB5xYKgvfqBsP0qipLLAEXhQOv7SscnMtHsGnXifo+dO1A+9IcVNw05IUVLA4dxvy36Vbq3GPsNuqxzzyFVHpi2qj3Z6FZ7pIgPJIcJRhSXWzyJSduIcs0fp00iYM3O7TpafuKc4U/QUFqNQmnbYQSRGleiZ1DDoYjc9T2a3ulta2XHh/omj3q8/BNCd0uuqtUE2u3oNmiK/tnlD+IEnpgdT5fWjpVmtNohuLt8Nht1Kc8ak54B94/9c6dWG0BiKJUhPE64eMcW5SD1PqaGOuJU2NwOw9zCBpEBCDk9/hIaydnlmbske33OMJERtYe9lcOUrX99z75+OwqxIUkW23iFbmmorIGAhlISAPlTNIA2FdgbUmudrW3Ocxiiog2oJ2pZUSSedeb1zjG9ej1qrEvDmdYPPpXaVYpHO3KvQPPauFcyxXkrBmOR30uNrKVJ32q0tPXhNzhAKV/ETsaqBskYoi03cFQ7og8WEqOCKGuryJXrKF1NX/2HSQn7QelW1RIeqWGxxZ9lkkddiUKP0I+lZUvMUBxWwreuv7WL/wBlF5ioSFKEYvt/3keMfkfrWJLvCJyo1tv+N6k3aXy2PKnH2doix5lAz1XiV3Jj7kYqLehuGOt0J8CSATnrRTKa4HTtUVLiSBbVTEtExw53aljkFEZANOHSLSkB761wwGh/4ivyFDvAaLb6nMVoY+2T+FD3d+lI9Wn0kGZeZ+j2jEQrewHUISzBhNBLaQMDYYSBQ1qnUKi080lwpLyitxXx6Uneb73FqZtsQ7oHG6RyUv8AoKB5Elx95SlOF1Z5qVyFN9Ppsub37zO6PQl28x56453g4UJ4UevM0lIkMxIrkl9YQhCSok9MUk7IbjoyolSjySOZqtO0vUzzNjMBLnC5JVwcKT7qetFOxaPUWVnqm8uai1PKuTvurVwtp+6gbAVbPZXajA0YiWtJDklSnST5ck1ScZpUma1HbGVOLCE/EnFaft0NFutUSA2nCUNpbA+AoUjmXseMSUioKYyM8yM05bBUpx0dMNp/M1yE7gJG+NqkhA7iKw0oHJTxq+J3qJM6ojmBDcBS+8gpbSCpII5+tU32ux1TJEFahkmc2T8KvabLkMabU7I4RxANtjGDjzqkO0OSh4xVDcCY3v8ADNep9Z5ltoAwBJDTTJZsylpHNdRerShpkTZdzlsI9xLTS+EKPpjc1L6bf7yxtgDmtX50M66vdgyLaspky0ZICVYS1tuVH4dKvAzYZyscyr9T39TEN51uA2pgeD2maouK4j0QDzP5VYto7WbjN7L51gds6oL1ms3tWHVk+0HIRxEY2HCaqBq1ztbavixmld3CQ5thOEoQNyceZxRnqOzSoNzv10DpTHVZ1RXEnmeJSUoHKlD3O7s4+qOkml9iBtvQ8GS/ZVB0tJmfu68WpsPLVxMvcag2snfCk8gfWtBs6cix4iY8OK00hQxwNoAGPUVlnRU0uKiwXfBKaV3HFy4h9kj1Faq0XeHJtpEWaQJjA4FZ5kedX6nTB0FtZ+yMNJcQmMQXhQlQe0mE0k44mXW1D0G9HjcrvArun0IbScKdJzv5JHU1UGr70mL2qWuO8wp1IeHG2FFOQtXCdx9at8i3WOIUsR0d+o4TtucdTnkKW69d94XGSQJfpnYUbc4wTPnFCRLYtrba0pUoLc4vex5q+Pl0okQMAAD5VCafiuOldweJK3PdJ8vOp8JxilWrsDPtHQfwwulNi89TPhjG3Ous18AByFe4NCE5lonnwr7avcV6B5CuYzJAz5CCtYSBueVe8JCiCDkbb18BvXeCT613tJAzxNO4yyh1JGdjTYDflS7exHSq2lyNLg0+83cNN9y7uFoLah6EY/WsYavtht0pzuXBIjhxTYcSPdUk4KVDoRWudDP8UFbRPJQNUt2gdmFzMefqaxBc1lyS97bAQnxJAcPiSPtAdeopr/xvUJRe6WNgHH3xOyrVZYh7kfrM2y2u8cNPrJHZdt9xtD4OJ6EttHolxJJST+I+dP5lsShRU2SUHlkbj41GoD8ZfepT4m1pWn4g5rdsM9IIteHzK/1BaSygNqSQpKyCPKhb2JflVu6xhe1XIzWWVJZkKK0nG2eooT/c6vSk2ppDPkSizSkMRiX9Kkqe2A7pv1O5+NMi+FDgjpASObh5fLzoU0rdLvqWMu+3ZIjwVnhiREjHEOq1Hr6VI3O5KKzFjnB5KI6elNVO4ZijAHAidxmpUtTMZRJ5KX1PwqjdazjN1S8hKuJuP/CT5ZHP8ate6Pi06dlXFR3bQSnPVR2H41SgaedUuYUBxKFhbhVyJJ61XY2BL61k72f2oT+0KE2ocTbWX1beQ/qa0Y4pJlxk7YAKjVYdllrZVIuF4aYDYVhpAHJPUgfhVlNtKeuhSncISE/1qt5KwYfb7Ses0Nc+5IbQkkrVwpFFEliK3fS3OJaSNkoxucDbPkNqjbOHLRFF1BCVg8LQPU00cluTLwpx5ZWo+JSj5mhGBZj7SwYUfGJ6unKWhpoHYAukflVN6yw3plUp1QSGnkOZUcfaqyr3LQ/KUM+/4fkKDNY2Eah0RcbYyMOqRxNn+ZO4/pRFTbFAxIWMScyvZutXrdpxUCMsR0ZUVPp99YJ2CfL40CwbZKv63Zr7/s0Yr7lsc1vrP+jQOvmTyFS1s05cdRXNr97MuRWWMNODGFLUNsJH5mrCtdqbe1Z7O1AQxGtbBRGQlPhQTzUdtyTneq7rDaRWnGZZyeewnekbAxZ4KloYA4cMg43PVRqN7TnG29GS0IIDkqawyU9QlIKvzxR7DjrUGmgnhSkcXw6CgXtb7tVuhwENgKVKCyvzwjYUuc/SGtew/WEPWV0ufcwZ0dAjXbVUFlSi2JDaQtadileNiPUEA1c9susyDeUNT0dzcYwCXSn3X2+jg8wRz8jVaaUsI/c7V3bUpt2NPDDqx0Q4kFKvkoVIayuus73fFQ7fD7tUbLIcjjBWVDCjk+flV1Nr5AHToZYgKUhh1/OPbc6zr7t5UFJeUloqdZQ0ASUte6CTtgnfNXo1p+VMe725KUgKPEpHFla/QnoPhQL2JaDXp2Uu6zwlc3uuFxY3CSfsg+lXM8se0tgD3gR86W6vWv5jJV9/eHU6XYga3r7T5htLTCW204AGAKWArxI2ya66bUjMOzPBX3WvedfVydE+GDzr3G9dAbV8BvXp2fYrpIr4D0roCvZnRPQKUSNxtXIFKI58qiZYsOdClQcdGdvKhtjWTtl1jdIMhZ9lM10pWBu0eLn6jzoq0I3lxxXQ4FVjqCMF6nujvNKpjxB/xmivCqa7rbEsHGP1i7U4a5wfYRfU2htO609ousVxq1TkkqddYRll8c+MpHI+ePpQnaux21yXA7P1bblxc54oviKh6E4Ao00pdEQXFRH1YRnjbV90+XzFQvalpKVF0wq86cTm3l0SHWG9i0TzKf5Cd8dDT+q22uwabzCAeh6yNXl9G49oN9sNm0xbdDWO1WAtqSw+8S5xAlWUpzkj1qh/YkffR9amtY3GYzo63l0uJ7yU9ji544U1XH7yc+8r60ai+SNjHJ95Ky0A4MuK4p/dsNqLFbDfCnu20AYCEjaoFDDgXvkkn61fGorRG1oZUhmC3HuENriw2MB9A25feH41UzzDEdTq1e8klKR60707C5ckYI6j2ijWeGtpW56Sse0y5Bq2RLUleAtwuLx1CRgfiarUOE7AkJJ3FEnaFPS9q5cZICgw2E/M7mkrVH09I0a8ZEhDV374hoKUcqTsAMcsbn6UG5BsIg9FRtJAIGBnmXl2cW5MLs0iSFIwp7LvxydqL4UQR2S657yjxK9SelMrHGLNjt8VIHcxmEJGORIHOpJbvEQByH41Uc5lXUkzqQ+tTYK1HhQNh0FNYz5TAekk4Uv3f0pCe8XCmKn3l8/RPWmt0eLMJmOnZSvGR5DkK9tkhGjhDslbv2UjApVshiNxFOSTsPM0hHytISTgJ3UaVU6l98NJOEpSQBUXO0ZnVXcQI1TpyO8pmYwjunyMDbIOc748zTmXbxZLO8svl5SvCniSBgnyx86nLb/FlhIxltPu+tROquKRdYdrb54L7gHToPwFUVOa6je/XtGN4Flq6degjO1o42VLxni8I+lAHatD459rSOXerP8Au1bUK39y022BjhTk/E70A9oNmn3W52puAwXnFuOnA2AGOZPlS/w713EnvCNf/bCrHHZ1aBcdL3i1lJJfaQsY5gjbI9aNNKaDatbri0MvKecOXJco5UfRI6VH9nluVp+ZHS84Vvv5bc+6Ns4FW22ePeveJX2aexq0OA2DLdCAKwSORObfBjwYiY7KcAdfM+ZrzjLs5bbZISk+JQPMDp9d/lXNwmJhROIEBagQgEZya5tsZ5iOVPkFa8H4fGkwyENh6np+stb6Rwp+cfproVwK7oQwifGvArflXi1BKSfKmjcgKexnaomWKMx+mvRXKNxXYFeE9PRXYxXAGBXQr09OhzpVAPFSQG9LNDxgCuGSXrLH0I1wx1L9RVJO3hLl2nklXdvSnVJ4uaTxmrz0riPpxx07DhUr6Cqi7R9LKjQbZqhlXdRpbLaJagNm3ceFZ8uIbZ8x60X4HfWuqauz/IcfOLHYedZn4CCsm9RoEtkSngz3y+7Qo8uLyNWvpK4om6VcgywlRbKkFKtwpJ6fjWaO0+92w2uFboshLsgKDiy2c8AxtvVkaB1FIkdn0G6LWe94Ud4fvcJwfwrUa7SedUCvWQ2722QA/aEsUa0xbaiCkiP7S8Uj7uQk4rPvCfKtr6tt8C+NGHcWW3WX0uoTxjPCSBhQ9RWf/wDsqnf6kfWhkt3KAx5nVqNi5E0w9EVZbaxKgqKpEk96tf8AKDgJqpe0HTy4epfamE8MaWnv2wOQz7w+RrS8exsux24ElIUUIPAo+e/4EUBdqNkZY0wy6WuBUSQW9/uqBI/KrfC/FALwnc8H9IfqnTU1mo9ZmGZpGxS1rcnWhh5xzdThGFH51AQ+z23W2/m5oHfw0DwRnRnhUTgHPUCrh/c6n2kPFOG1+6fOpeFoGfcY4U1GDccEEuungTtv860VrUY3WYEz66F3OFEZtPMpjIjtJCQlIG3SlC22lsr6AURW3S9kbuAjzZ8l5Sjw5Yb4Ug/E0VyNJ6RtLjxuoleyNsBwvJcyQs8kY9aV26ims45J+UZp4KQvrMqFlgKmrff2SRxKPkgdPnUbcHEyJPfHZS98eSRsKmLxJYckLZiAhC1ZOeePspqDXwqkrdHuoGB6kUQy45ii9BWSojd5wMxy2Ns+Jf6CvIKVpHfKB4lnOPSuxHU6pSljwJ8Sz5nyp24pEe2rexkobKgPM42H1Iqi1vTiQr4IMJ7XLtD+ixNZucZRZ8T7fhSUbni4id80KWOWm936Zd15IdV4CeiBskfQZoGuOn4sdlIt98XLlKUlD8Up2CjurB8hnrVj6ft4hwUIQnAwPypXr7QQKwYz0dfLWScTwlCvNRxUZcFxIAVJkuIbShpxQUr0O4HrUwlsBtIA3zn8aF9caduF/sbTdvSgrYkKcUFq4RwEYP41zREVup9zO3Ekn5Rnb9UQpWpbYwyeYbcSfMkkKH0q4GlYAqodJ9nSLatV3ub6npcZSVsBvZtHU/GrkQ2ktpWnkRkVT42wNqke0u0TZrPziD8ZEiQw44ThlXEE9CemfhToHJrwJNehO9JGbOPhC1AHM7AGa65CuRtXyjVREmBPFDiSRQyZSmbu20rqsoI9eYolSc8jmg/VnFbr3b5iUktvyG21Y+yrOAf0qJl1R5wYZsHibBpwAKaxVfwwKc5ztXBIHrPSNq8FekV91rs5Okj1pdkeMUgBThjPepHrXCZYnWWQwUw+zmU+vYJiuLP+yacOQrfqHRAtkhtC4cuKGykjIAKRg/I4PyqK1I4qJ2RTlA4/zdKP9pSR+tR+gr4lUJFqmL4SkYaUT08qXgH647GLDp2sqe5eoaUV2l9iLEvSa9SaVjJhzYnGmbbAr+G4Wzha2ieR2zw9Qdqj7W1KsvZjbLK2g+3SWw2hscwVbk/KtHXVuxTdPzrfdS4tuXc3EoDCuFY8WOIH0/Gqs7Roi+zOW9cjYpFzjBnij3BO6UAYHCv7pz16ith4Z4lY4FVhye2e/wBshU6hyTwYJdqepVaWtlhQHAt1LSm3TnmQE86qn/tZf+8v60Ma31PNvWjI9znPFx+Rc5CySdgOBGw9KrL94L+8aMZFq9LcmDDWvSNqz9bbfaHoUJplEhcxpsYSXf7RI+PWh/tM07L1BohyFb2iuS460PLACtyfgM1JXbWls01px+73NKmWGE53O6z0SB5mmuh9VT9UQ3J93abhKkp72JBHvNs9FLP3lc8eWKy9C6mn/wDdA4U/ef51lyi9D55HT8YJ2fQES1xGDNeTIfaQEpSU5Q38B1PrXF2iONSULZ799WcDj91PwFWXLYbebWShPEnn0xQNc9V2azzzCvMS4w3COJC2gHW3B5g86YabXX6lyxBY+0Y6bVM5zjM5cs8ZyI1OuLTTS2R3j77YwlCegPmqqy1pfEXOUpLRUiK2TwNk8/VXrUrqzXS7pCFut/FHgIVxcBVlTh+8o+fpVW3O4LUSCutD4fpLK/pbuvYe0q1eqatNueTGUx0ocUUnK1nArhlsrUlhHJPvHpTJtbkiVlI8R2GfsjzqaZZ7lsJT/wCtMLGzM67ZM5mpQxbFIb6nHxpm6nvO6ZOAnIUrPknf86VuAWru20nOTnFML+4uHZJAQr+M4O5R9MqNDMcTmcRsu2Ih3SVK2Up9XGNvdB6Ud20JMZI8k0JoeTcbcxKSkJ42UnHltRZbmlJZSeeQKz7nzLMnvH4wtXHaPgMkA89jTiAsKW22pIKVJVnPWuJDzYbSEYHCcK880x9qdYiNSmMEIWRvyIO1GjjYT7wQLw2PaTlznwYdmUqU4hpKwW0DqtR5ACn9nkd/Z2FE7hPCflVbPuP3RJlTld66hxPd+SBnoKNNOP8AAt6Ko8jkCgvELBZ9XtDNLQ1aHd1MJMjNeHnXw36V6U+LBpTCRxPAR1rrAIzXmADtXwNRMlE218LvAahNatpVYUOEZLbqFj5KBqXkAjDielQupHhI028jPiAzvUDLUGSDJ2IvKeVPUnzqNghXADUimvSDRUDrXtccVfA5513E5Ohzp3CSFS20nqoU1AzT+1oKrqwMfbFVt0MmDCbtRw12P9wlRSXpURvbr/FCsf7tArchMVHecfAEjiJzyxvRr2sPoTou0xlEfxLk1t/dQtX9KpDtIvpt2iHI0R9tuZcFexsFauEDiGVKz6J/MVVpKWuda16kwfRP5enZz7kw+s12g3G3RpDE9h9ZWhSkpcBUCtWQCPWjK9ui76mbYU7xIi4ZDKlDu3FkZXxpOysDAx51kfsn0tqqH2x21wsiSGQp5DSXcpUQnCc78gTWy7TaWI9hbh3BpuS4olx5SxnicJyTnnzrQeKUrpHUZzxx9v8APxiG5mb1N1mOP2m+zSNpaPbJem4bzcOdJflOQkjIiq4UJIR5pJGcdM1mLu1/cX/smt8/tLdzHt2mGWEkNhUgAEk493qazllr/VI/2RXqL2srVm5P+4C9jZ5h5K1bq3tEuLSbpOUbewsLKQMIJHIAdavjsnuT7+uFe2yC4pyMoZUfLGPwqjbcymBDbix0cKEDA9fWirTOopdi1BHucYBamSchXJQPMVrtbR5+mahABwcdo602rZ8o7fW4mpX5Li5AdhtFxJy24CcbedVn2wtR4ul7Ul1xK5peWcp+6Rvj0zSNx7TpN509IZslqeZcKOKS5niDafTHL41Vt9v0+6Ja/ec5byGEd22Vn3E+VZvwnwm6m5bbPTtPTv0hO3+mAZjg+3Xt7yGmTVBJSFVCOKVKkBpA4lHfH9aVf76TMLTQ36+nrT6HD7pYbYTxrV7yz1rSWtE97l25nUOAllA+pUetPFN5Ow2xtSyWeFZSpWcda8WoJcUrokb0MWzKsRrwI9tGU8XdJKz6noKD9RSxIuRjoVxIYHASOqjur+lFFxmC2WJ+cs/xXDhseajy+nOgAklOSSSdyfM1wyDHmEGnHuKxBpR3ZUpo/LlR/aXkmGhexwnP4VVVifcj3eUw4f4b4S4j0UBgj6YNH9ndUbehIOPs5PxpF5X0xHxMdq+dPu+Akk/h2ShR58RWo/Kn7kZDej0DG5Tx/jmk3eB4hDIAATwJ9fWpF5gN2BbZVnhaIyaldaGC495xEI4PtBeEytJeCQFEg8II69Kf2uSWbkh7cBSRnf8A66iuI+G1IX94ZrxxtSZikJ8OTxJ+B/51CsLdW1ffrCrSa7FszweDDpl5DjQUDSnF60N2m4eENOHBGxBqcDnEBg0nIxCiuDHOR51z8K5SrbY0onGN6jOTkpChg1AajY4LLIVjbgJoh2qK1KU/5OSU+bavyqDciTRjmPLcsGM2fNIP4Cn5WkJJzgDc0OWq5Mi2RRlS3FNIIQkZUfCKVky7k60ltuMgNvrDXvELbSeaj0PXlVlVD2fVEpttSv6xj9qfJebEluGVRzywr+IR97h6j051IW9+DLklyQtJZSAlAJxxLV1+Q/Oo5YdShLbeQkYGBTVaz3ik8O53UeRJpynh6BgRFFmsdlKnvJgTEtxwV5Wv3Qkc1HlRLZ4M1Lca5raaUzxgOFlzj7o+SvKq8feJdXwkhahxD4Hn+NGvZep9u7SSXeGMGv46F+6oev8AWhNV4eEpezPSEf8AYHjaPnHfa+tYi6dZPIvvO488ISkf8RrFPalry1XrtUTapcl5VptSTH4o2CVvH31D0BwM/wAtaI/au17N0hH05AhxnTJkxJCYr5HgQoqAKieqkjBA8yKy9ozsrN+tb1/vSpKGCCWG0HC3lfeP8ufrU/ANOQ/ne3SVX6r6BaV98n7+Jp/ssn2+G6zqGG4mUwG0socSc8SQACf+vKtFsPszIiJEdYUhaQoVmXRNva07oO32hRHGy3hQ9Scn86tHSWpS1H9jccPCndJzuKK8Z0xvbzV6jj7IHYwcwJ/agSUwdMk/6yT+SKzbxDzFaE/aTnGZadNklJ4XZAynrsis7cXqaC0yEVAH+cwFxhiJawWlKeHOCrmaVD5bGE7VFruVujr4pD/eO8+BPSo6TqNLrncQmypZ5JR4lf8AKtmXAkg0sPSuqm7Pc5USXIQ1HnxHGF8R2zwkpJ+Yx86D/aZFzuTbQOGGzxrJ6+QqOt1okPTDOvDwCBuGgc4+J6mi63QmfFIDeCs8QSeg6VEleWA5OPwhf9RvRVbqJ7GggpPAClKjlSjzVUghptlOUjl+dKJSa6U0tTiUAZoZ3JMgATGTiu6bKzzpNS0IY7pW6z4lA9T0FOpoYRJDaVEpQNyeqqGtRXBVuh8QyHpAPdefkVf09a6pGMmSK7MgyB1RcjOuiIba+JmNkZHJSzzP6VD/AGc1y0hfdl1R3UcDNdggpxXRBs5i0ZKlrdcZGXWuFxA8yBuPmMiju1OpdtCHWjsrxJ+e+KDbMAZroHMcNSibmbVPgxVqAjLW5HUegUTlB+HNNLLBhneNaz9HWolgW0lxaV43/Spa4OoFnfCtgUYqDs0pBbUTzNO7o/m3lKeaiEgUvJBsVR0ENKEIWbqYxQCYqV/cViu5hV7M2+j7GysfdNKQUccRxHXeu2EhTZQoZ6EGqku8uzcIW6CxNhiQS53bUwEZV4V8PLI5H51LxJ54AFmothv2R1UV0nuXdkqP2T0+lKtp6HmDg/GoaysBt6fVM5pn3L5b9RCOO93m+adhVREFzCQmpRKs4oCTYYM7JV0qD1I4f3YpgbrcBSlPUkiiBvBODQ1NShWo5aHMlYSlTZJ5I5EDy3/OrtNULX2k8Si680rvAzI2zB62WpAkrS44nhbUpG2wGBiia3yEFxbinMggHfkmqa7Ru1ix6DSbcke33ZfjENtWA2OhcP2R6c6qJ/tF1Fq3iXcbgtDYOUxI5LbSR8Bz+JrUUadbT5SHEz72l2JY8y3e1ztG1KJ8yw6QuMeM02AgyWjlbhwCoBfTy2oN0f2q6t0/bH0akcMlplILKJCCsr8wHE8vnQhAdUqMgE7Bbn/FXFxuYgxlOJlGOR15/gacf9dUlQbOMCeKcZmgNKdrmmNXd02y97LPSc+zukZWOoSeR+HpVjwLr3TwjtO/wnVJKkg4DmDtn03rAcjUcF+YiQ8x3chCgUzoA7l1JHIlPuqrYHZVI/e2gdO6hvOqLeZj/EWGHkFpMsIOElSs+FRxuOW1JLWqweciWaap7W2oM4l5doBsUrsMl2vUzsaRIloS3DbkpSpwKPDlSc7pwM+L1qnI8BXdNsw46i2gBKAlPhAHKqU7T+1fWcDXsyLPhLhXFtWO+lJCyEdO6HuhHkRmojSmvL9eLsFXG8yXxj3VuZB+VE+FeHioFQ2Sxyf9S0LWXw+czRT0C7xI/tL8VxLAIT3mQQCeQ2NKQbg9GfS4lRBFDWk9XQh7ZDuLp7h6OQCTyWCCk/mKmJCwBlJFE6ig1sUaQ1VS1kFDkGQfbRdxMsNjVxbpefGPLwoql/avUUf9qTilWe1pzyedP+6mqq4ledJL6gjYEXWHLZk25eYEq4uNxHn7i8TktxE+Ef3lnYUY2ezOykQno92iBB8b8OIk8TXkFrPM1WVmXqC7XVqBZmmoNvKuHCUDJHUk9TV72K1MWuEiDDbA6uL6k9ST506RieZP0qOmTHsa3LlPhOMMo5+p8qI48XACE86SjqShCW0J2FFenTZGVyHbq8ODu8JSBkqPXFU3XFVLEZl+mq3nk4kAE95I4RjYYz5AV87LYhQlPNvIdW4CAAN0gdaTuj7KGXu4y22tXLO4T0FRiIy5r3ATwsoA419EjyHrXcAjJhOQnAHMVt7DUxlc+Y4ERmyVKz9rG5+VV7dpjmotQvTgMMlXdsp8kDl/WjDUkxLluRaox4G1+/w/c8vnQ6zEDSCtCQlPuoHp1NSCFjuMFsPYSHnMobcDSNggYpn7vOnklanJC1Y2Jpo4g44T15VLEpE+skhar9LbQSCGUEehzU7PhMS4aITvurSpBX1B5hXxB3pppuChDL0zg/ivL4eL+VOwqbTGLshsEfa/5UvvUNW2ff8AWONMm3YTPdN3V1cNJex7QyosvpHRadj9edT6p65krhCClprkT1VQ/KgOWO/omOMqbjzCGXVY8PeD3FZ9RtUm0sIdIzsTk0tSkq5U9YcbldQRCK3n+GSK9Ue7mkcgd6Stx/hZ553pWZ7qXOqTigD1hK9Y7Wy3JYKF8jyPlUY46/Dk5dBVj3wPtD7w/WpCK4VJFLvxW5TXCrII3SocwatqtC+h+VMqtrJIZeGEVgraebS62oEHyqXaHhFBoMq1Sjw7o5qbH/EPTzFEUK5IeaSSeflVF9JrPHI7GSS0WD4jrJXJAquO0/UEzTGnJeooLaHpERlSi0rqgjBJ+BwflRfNuau6IikgHYLI3V/dH6mgLVbD120nc7QtAdclR3GxHb8TjilJwPxxROk0tjfSDiBavUIFKdSZiaXLm3W7vT58hciVIcLjrqzkrUTuaPtE2W7Xh9bNrtkqarYHuUEhPxVyH1q19A/s122IY87Xk4zHyAo2uKvDaTts45zV8BtV8RWLTaLcq122A1borGEIbYbCUnbmAOdNtEz0NvxzEKKe8ydb4r0W/rstxBacTIW04EqBKFZ5A/EVOnSttmTERY1pVOlL2ShZKyf0AptMjQrZ2hzmLtcEuSY0xanWUqw64eLPwGQc1ofQtnsMrS0a+WaMpCJzYUS4ricHQpUrzBBrRXauqqoFhu/KMqaRbxmU7/2cWDTWnpmotaRY70SI0XEWqN4UOuH3ELUNzlWBgdM0FWztL9r0wLfKtb7hsbRfc9iIQ0hHHkISOmBtnyzRJ+0FrFiVJTYLS8FRoSipakHZ1/l8wkbD1JoQ7H9LOS9K6mRMbIclj2XCueSgn8zSPUO7WDAxkfd7TlmrOnfbpuPxzC5OqYnaprFdwutvDtinEKjReId5CUlIB7tf2VbEkcj5UfSexyWxZU3rTbkW8QkpzxNtBqS2BjZaBzx5ist6DvU7Tt6dhvcXsnfhpw5/snd+FXpnBHyrYHZFrGe/dVRlSAlhxsFxHmRsFD+bPP0onR3N5ItpwGXqD3xLdLYNQfpPrSpWDJbnNtHiBW8lvB9SKuJfGRg9Nql9SWXS94nCeq3twrnHWHe8ZOGn8Y3I6HlimL4DaSo4PX40bq9SL9rBcSvxCk1EAyt+01Y/dltSTv3jv5JqreOrL7T1ZtlsVwpB717OPgmqs4j5mk+o4aKX6y4NK6eXDiJLDYEl0Dc8mk9KsKJGRFjJaBKj1UeZPnScGKmMxwhO53Jp+0hB/tCR5YH50ydpIDJnzYwOFAJWfwpXi4E44snrivFcQXwIHAB06mlERVJ8Tg4U896j84alZkdKQmVMajuOcDKR3ryvIdB869uNxaMQJZb7qMjcJ6rPTP8A1ypBSkPOOyFKASs8RzsAkcs/nUclZuktAbBDJOEeo6n51DblsntIu+BgRJyI46GVuZLr54j6DpSd0bDDa0p2DaOEfGiRtlPtoVw8vCn0FQF/T4XT5uhNXA5kCOIKuIAKgRv0pq43xSmSMko4lY+VP3j/ABlUk22FuvrzulHCPzrkp+EnLWyGYbSeEJ4U5IHnUxDQjvWyRncH8aiIysxGkKOCpIz9Kkba4p6YhtX3wPjvQVlZ2H+d42rfNij+dIa3O1N3nT0u1OJ2fbKUE/ZXzQr0wcVWNtlyHWw3LCmpLSizIbUMFK0nCgfz+dXxHtoXwbZBIz6jrWZ9Qajuts7Z5sO+RsIflKhrlJTwgOJ/syoeakYGeuKC1A3AsvUSvSWrXYFbofzlpW10FsAHNSDiA4wpPPIodtLygQDREhYxmkzCOyeeI3gO8gelTDSvOh0vpjXRbZOAfEKnIryXUggiqzOue8VmMpfZBAw4jdKv0oVulyj2+C+6qeiIw0pKn05PGjfdIxyBonlOrJ9mjY71QGXFcmwevqfIUL6q0ib5OjNxpyoEYNFmUUI4lvozkAHlnOd/WmOjrZ0IYZHaK9XaisNpwe8m3ri29ES7APtLjyQpKkHiKgeRz0FQDCJsLVURbrjaTIDiVpTuccOefxFEdot0Kz2tq3w/BHaSEIQeg+NQ9xCZGroAjni4A4f9ynNRA4xE+eZKpdEdgySeI8kJ8zS9rjS3pHtcxRPVCTTu3W1CmUOPeIo2AP507kvpiICGkhbyvdB6epqRcE4Ucy1VLdJlv9oTST9i7TI2s4oJi3NSQ+B/o3kpA+ikgfMGk9Odpd5s+iZ2lIslLLTyy+iRnCm0EYcSk9M7H5mrx1tpaLqjTUq2Xlaj7QMhY95tQ3SofA1mu59mt7h3OPHnNPXGElZAdto4i55BXVPrRFI2KSRnvJhXrPHeQN6cbl2Vdx94OuJZYz1A3Uv8MD51aXZClbHZ65OcyS5dMqzzIHCk/rVeauiiLKjWssFhcdsKWyRjuyRsnHoB+NXj2YWFSOy63oCc95H9pVkfaU4SPwAqG0ljY8pxzKFuFgat/bxfdMygURLg67Hz90q/iNLHqDgii/R11ft7T8S5SVRLhb1FDygcbD7Y+IFSH7QOn37H2o23ULKClUuKzJSoDYrb8J/IfWnF00ydVQmrrZFstTZEZIy4cJcbVg4J8x51LwkAbmB/8kqgRlh2hPYdbSdU6qdhtpUG5pTw5/0TSCCSfUhI+aqObg8EpPioO0ZpKNpGzKddlIlXWQkB11HuNp+4n9T1qVlvlSCSqr7nV29I4E7fqGtwD2gb2kv8dotx/wDHd/4U1WPFVi9oP/uS3K/8w7/wpqt8j0pRqj6+IG01mkePhxkAZNKJO/CCCTuT0qP9pDzhDJJSeauWfh6U/YaV3XFg/Smu3HJhlaY5ioUUuE8WT502uc1YidzxkrdPAP1NLlODvQJqnVrFsdmOoAV7M0fEeQP/AK1FRmSNpOZGawv/ALRf7doi0ukOvrSqYtB3Q0N+D543o+tMRLUZUgjZI4UiqT7I4Mu+6uuWpJhU4tI4Qs9VrP8ASr5kKSw0iIjGEDc+ZqAORxKKjuG8xRtGFNqI5mhLUqyO6/mfUfoKLlr4O79P6UD6mdJcinoHFn8KsUHrLW6SCfWErUoqAxuc04hR0BxSWVlxtauIKPUEUwuERcyOqOji3BWrbmBvw/P9KnrVGDcJC1blCM4+VWLjqZWoiyAe9wBjhyAKlLCwp++MNt+8XBz+NdMwe+t7spXgX3ZcSgCldLyUMX+G6WytsrUVkfZHDsaqYErwIWmQ+6XTbXR7SmO6AhYUApJP/W1VX23wtN3TVJlNQ0OMspTFnLAx3wHJW3VJxvR67qm2OacSTDDlwR4EKKccGOSs9fhVez2PbUve0AOpez3gI97POl9Gn3OXfjHEFtbPSQdtjSGYxMNxU1tk8JSo/wAUDHnyV+ZqegTY8uKFtuAihOxwn9PJXEjOKKmlkYeUSHE80kn4bZ9K5kyJrExVyjsLC+MmVGSNyPvp8yOvmKE1Xh5A3pD9JrSDtsPHvJrUGWgzMR9lXCr4GlrfdCyz3hORjl51FybmxcrEUtLCuMAgim1qLi5jLbzClM4Ku8B2Tjn86WrV5jbRHT3LXXuaTmon9Su6GujelEtK1A6zlkuEJCCdiQTtxAZx61Fdltp1VaNDhOrn3VT3F+GOtzjDDY2A9CckmjCF7OhjiSR3jviUPyH0pwXG0p5iniVBcY7TLWOXYse8i58t4oLTKF5OxIFRcJ12Nqq3ocZWoPIdTnHu7A5NTrode2aTwj7x2FMmWWGtRMyFrK1MsKJKj1UQOX1ooDIwJAAk4EKmnExYypLm7ixhKfyrhi1zJaDJcdCAs5yeZqK/eHtD3GpKuEchTyRqN9lhLZbQztgZ3PxPlXhW6/V6mMERlGEjHVTKGILMcyFeHJcP2lDy+dC7jSbfbHbg+jhUE4bRyxnYD50VQ4RuklMuUVLTnKAep+8aB+2O9R9P2xEXi4XFsOLbHm4RwoHyyT8qtW05FXeU2ux4zM5aglu3bUdwuSlFaXHSEq8wPCPyrXGlIbcTs0t6EpCeBhtr6JH9ayVCbS7Jiwe7P8R5CPkVAf1rYTZVD0lHYKOHcqA9M7fhV2rUBVUe8iRgQP8A2lbV7b2O6avjbaSYzymlrxuApI/VOaAOxpTlzsTUTIU5AfVGUk/6tY4kH8SPlVydobP7+/ZVvLYTxuQFpexzKQFYJ+i/wrOPZPLuTGqlw7QG3JEmN4m3FcKctqCgc+YGfxoTQOKsqT3I/WX6bYti7+h6y3pUaXDLiXmzwtr7tR+6ccv6VFSX1YOaOe6cKH13V1l1UptLbyWkkJBA2UM9RVZ35MuzvLEpWY6VlAdOwB8iat8wE8wO/aLG2dO0Hu0GYEaZgPLVhCZLwJ/wIqpf8oo/3FUS9ot9RdtNwWIbnHHanPpKk8lqCEb/AAqtO6d+4fpSTW2/SemClvabwhx+8UkDYH8qmBLQzCdihsEkjxHoBUMJfAs8AycYGOlJKdUt0b7k1onGYyW0VpgdYreLoIFmflHGUpwkevSs4doN7U5LTZ2l5VkPSSPvH3U/Ln86t3X93bttmU+6oBphJdKSffVySn5n9aobStqlau7QIsRxRW5Lf43Vny5qNUWnau0dTBLm42jvNAdmFoOn+zOI+6gJdkZlLz6+7+GKKGe8caS44cqUeI/Ooe+3iJbbla9Ms++/lKG0+SRz+AxUy06A2lPlgV7G0YE6MD0jtJFaQppZz7n9KBNdIca0tMlRz/EZZcWk4zg4o173+A/mhi+Rvb7TKhue482psn4gj+lTAJBElYZD6beXcbaw7JQhLvd+PhGApRGCofhTslzjTDaUUKcd7skDkAck010Nbp7el4K7mEiSpS0rCBgDfYfQCiZ23obu/flGcpyMDkTsTV67Sg98SwEOJIRj3jK9tkbEeYpOxRBFlYXtwEj5f9YpaOr2dwK4cjkpPmKdNIR+8W+A8SFjn5pqDthSBJLjBBjqUwW+IoOE5zimDyy2pIG9O5EtBBQn3elNOJDqqqQEdYNJbUliaY0JbNQtMAFC+4kqA+ys+FR+B2oSVLYjxzJdTltvdZA3SPMfCr/RZY187Of3S4lIamQu6+CiNj9cVmwty2HHoUxv+K0pTDySOageFX1/WgNHd5wdD1B/CecYxI+cliPqthNscbci3M+BCTs27jJP91QGfjTO3KurHa9KtKpQVbjDae7lQORkHdAxt4hgnqKF75aXNOars92hTHiw0HUNtu7hBA4uD1yMgUdaRuyrxETe3oojqcQGUA7nhGDz8iTy9KjXpgLCQMGENczVhM5Ahgyh4+6MeajT5HdMp43DlXUqqNFyB8KE8RpVlh2YrjdUUoH/AFtRhU9+IMFJirspTpJzhpPP1qBekPtXb2lbaAgYQoZ3APIH86L4FvakSSHQEsMp4uEnnQm7Bb/f0mY8sLQtzjQ2OZ8s0TpymSIXSoEnGJn8Edw1gnk4Rv8A4R+tcwof7xbdbcSrhD38R1W/EBjAB/OkYiHZUpDWFJ6kJ+yPX1oygwEIYSgI4WwOQqm6wV/OXbsDAnkBKI+FkAADwiqD7Y2YmsNUyra7IVH9lKQ0pIzkgb/nV9uJLkghHuDYVXWpOzdiXNenIuSkOuuFw942DjPQYqOhNIcm7uJUQO8pTSGjb/J1nZoEhMaTFZfD6pSQQ5wIGQCPLlWmLmy6mDHbIPLNRWhtNptkt6e+82+ooDTZSnGAOdEV3eCnggDICcCo3Oi27KhwJBsdRHOktOQrlY7+7JClFy3PQygnwFLid9uWdhWPdOKf0j2gsuutqQ5Bllt5HXAJSsfQmt4aNsy5nZhemmcpelR30pI5j+GoJP1rFFztaP34X0ylSlupS464rn3hHiB8znrVHh9Q1Oqt56YkxUThh2l5SlhwlIPEkjwkdQeR+lRWvkQU9i18nyGEvJcjJaWnG6HuIJSr9a4sNxbkaPtshZytgexv9TlO6D804+lNdVzYcrQF5S/EKo6GQpaAfeII4T9aItp/xPaQsr9Rmdv3Z3mkYaFnAEt5W49Ej9KY/u5n7wqal3RMXR8I92CFSHkn/dNDv75R94fShLWpQgHrBcIOs12PAgqrtkApWtYJOwHzpJ9XiS2D6mkrhMRbrKqYs7NIXIX8ANvypqBmcU5PMontj1J+8tYrs0df+bwiA5j7TmP05fWiPsBs/HcrjqBxOzKBHbUehO6j9MVTE2S7cLvImPEqcfdU4r4k5rRVmZXoj9nJyZ/ZyZQ4Uk7Hjc6/IZoKk+ZZk9BI1+t9xgnHvqtQftIImJVlhvvWWB04UjGfnvVyRwrgJPSs4aEfDHajanCdi4Uk/FJrSaFJHEkeVWo2c/OdrOcmOUqBQ4D1TmoW8HEaK40QChwrWPNIG9SKHAFgqOxBFC+pm3ZNjcitLKFupW2kjmMirVHEk54yYTW0s+yFloAhtYdTjqk75FTi2kOtp8GTnb0qo+zG/KctKbdMURIt6jHXxcy2TgfQ1bcZZU0N8kbGq16AiTQ5GRG7sdbaOJScp6KHKmuXGSVoGSnJA8wdjU0hYCilfI+fWm77TKXkFAxxHGPWrN3GDJ5zIpSircmumyorASCSdsCvpdueL5ejLIJ95s+6r+hoy09DtMSKzLbS5JlcPiWr7CuoA6fHrXHuCLnGZEDiGVgcuD1hix5rgt7LTYQpa/fVjyT/AFqp+1KLa7JruCqAqStm6MrcW86nKS+g7jPmU7/KrNZTOlp422eFHLPP8aDu1SwiToVuQ7LbEmLKQ82kDJGfCfwNJ9OANQDnGew+M9guQDKjv9tVebE9GS2Ar+0aWfsrG4VT+zQ4sK2MW5lQUlhpKfD6jOfmc16puTOa7ptai0kYWoDAP9aYWF9BuDbZV/EQ2tl5PXKDsfpWhFSL6u8KqoKnmF0GKHXAlIAHVVT/AIEx+EYAT0qLjO+zt8TmONXJKegpQrcePDj/AAj9aEcFmz2lNvqPHAnq31qJS2spSdiR19KhmHX3dcO24MJEdmImQXeqlqXwgfIAmphbXcNl5w+6KjLE2tzUc+Y8fEoNtY8hucflXS+F9M6bf8VhlaYQZZ71SRxL3zU2u5KatRh8COEqyDjfPlmmyOEIAG21Nie+k8WfCnYeppc30hy0tWOmUYRkjeoa9uFSwyncq2Aqcb2GM1Fln2q8LeI8Dew+NcrODuMiwzxO4THs0NDSRyG9IymwuSnI5in5wmmUk/xkkGuqcnM4RxiWhofgZl2mJxEIeirBT55cA/WsN3hPsmo7jDIwWJTzR/wuFP6VtCwuuRtR2FGSOCAp1XzJxWMe0goidterYLSiFM3iSFpxjZThUMemFV3wWzy9W+f8h+RMuL7DJrRt0wmfbHN0PNh1GeikH+h/Cm2tNTW6yWqLbJzan2rg9/nCEHCgyBgn6/lUPpic1C1LBlSU8bAdCXU+aFeE/nn5V12yWSFHjwJ7i3ESUZaIABQW+Pr6im/iB2gkd5wsQnmL1EFO0HT7do0na2Le6qQ0qU86H1Dh8Kgkpz8sVWvcL/1rP+1Vj6kuhvnZVBQllSGoKSkOffUABv5ZHIelVbxL+6r6VnPEFUOCO4gGp2l8qOJtcq4lrc8zwihjtJkrToO592op4WAgYPmQDROggcO3IFVCfaGgq7Pbr590Cf8AbFaRvqn5SpTKO0ja03XV8Vh1P8FCu9d8uFO5/pV19uN3TH0VprT6CltwNKlONp81YA+gz9arPs+hrkX1DDWQZDrbKlDnw54lD6Cl+1q7KuPadMbC+NuIlMdPpgb0DXiurPf+CSQ7aifeD+n3ixq60yQcBMhIJ+f/ADrTrZO6t+VZYtoWp5a291sj2hI8+E5P4Z+lags8tqfY2JaFZS60lYPxFd054MhTHO/dK8wc1G3RAc7kgcl8X4VKhPiPwppKjqWkEdDii61ycS8ruGJVXGbD2oyVDwsvqHEBywsf1q2NP3hLnHGfWe8aA4vNSeix+tCOodIv3BKpjbLgcAwHMHBx0zStsD6LYxPJLUmKkhRPXA3B+NXf0xCmXV6WxE5HEtMDjaG4I5pUPwNJOqKwleMFCgSD+NCOi9dxb64u3yWUw5aMlLfF4VjzTnr6UYuAK3S4DjpQPKnBlYyDPXXmhJUOJtCc7ZVk06jTIrDocaltpXyUOih5GoOYSGF5TvjbaopTqkDxOgeg3qJrLCQJIPEsdq7u7IRMUy2rZR4tgPPaonVDkF2E7AiSzLLiDxPb8OeYxQW1d3WHODKy167Y+FSEm4sMW5Ul5SlAJylKBus+QFeWnYwbM4ckgiQkWRIVH4E94ofc4cJSfMGmMS1sxL45LRnvlOBQQfdRkbknrmp23sF9pEghLaFgL4EHY5/Snaocb94ImLTxFCOEJ+yfUiiHuyYYdQeQIvFjuLQCMjPNZ/SpZhtmO3nbbck0xRKUtBUSlIqNekyJ8kxmFlaPtEbJFUkF+vAlORH86V7U6EsAH7nl/eNN7FFLEKY73hWVyVHiPM4AH9acKaREjcR98jnXdh7tenUZPiUpSj81GuMQFwJDvJ43BJjAI2IHiPlS0RZfS2cY4aimGS46mP095Zqba4GUcKRihLAF4EvUkxy4sIZUeuNqQaQGmAOp3NeLWVED514STVOOJMzlaz5ZFNFpU6+lI6nFOnDhGBzNL2qMHrxGaxkqcSMfOphgoLT2IfQbepWsnFAeGNDaZHxIzWOv2hGYVs/aG1dHVb2xJkuxpTcsKIUjLKSoY5EH1rctrZ4bpPlKGA7I4U+qUpCf61i39rxkRu3z2hCMGVbI6yfMjKf/APmk+ivLagA//H9pG9sGVXCkhURJK98YPocVMdrl6RdNHWXuyVOLaS44fIDY/U5+lQTlsci2xmVH4ipCEh9HmPvD4UnLbeulschcHEtmKpCMb5PEVgfTNbHVA20EY5kNx2FPeDCZMhrQrcdGShUpXF5HCR/WhrD3kan33y3phlrixiUs/wC6moXv0/dFZa9uQCeggW6bGUSGyR5Yoc1y2p3Ql0QBnMZX4EH9KJinOE5xmmV3h+2acnR8ZK47iQPXhNarqCJxOsrLsgTH/wAq0POJ4WYEd2Y8o9cDAqu71JM/UU2YoKCnX1rIVzySaOdJLVbuz3VNzSeFamW4iT6qXvVf3In99y8/61X50tsOKlMk39tY4sroi36M6rdHHwrHmk7H8DV8dnkgjTK7epXEuA8uOQfug5T+BFZ7aXwrB61c2iLomNrCOpZAjXmIhQ8g8jwn8qnpCMGeqODLPAIAVzHWl2kpU5hXI12lpJynoaWRFUpG3vCmFeMw6keoS5ezDT5utskRpbDTlpKRlLiAcr9Khe0DsZhMMSZunwSlSSXYvM480+dGnZ/PVC7MA86puP3RI41nCfiag9T62cEyMtg91KbHEFpOUn+qTWXru1h8QsNJ9OcEdjj3/eaIrdbew/wHGPsmMtS6fmWK6F1jvG1NqyhadiPKpqwdpLyWUxr6FFSdhKbGc/3hWldQ6Xsus7E7qK1Q2xLZGZ0EDOP/ABEjqDVL3TTWjitZkRmWyn3lZKcVpar01IyBhhwR7GKdVosHcklIM9q5REvRpzTrahkcJyfmKWcbhMoLsqW2hKd1HZOPiTyqj9ZXHS9nZLemO/VLzu+06tKUfX3qry8atvF2iRY0uS6puOjgAKyeM594+Zoa+9KjiLHKr1mm5+odIt215xrUlrjFII79TocKD5hJ51Urd2hTLvJuELUcydKjnDL7rgbC1K28LflvVPvTHXeAOOcQQMJGPd+FT/Z9ZZN+7RbbHjtqUlt4PPLAyEITuSTQDasuwVRIrcM9Jpu2PGHCTEK1FDOEcR3I26/jUgienJ4wO6HJXUmkfZDHMha+Du3k4wr3gc5yKShW6TNdwgEIHNZ5CmWFncxRCH7jJDEdKggn3c/iaL4NtjwYiW0gE81K8zSUCIxb2OBoeL7SjzNez5yWI5OfGeQqhyznA6SWJB6jmJYZkOjkhJwBXlmkKj28Mr5oQMj18vxpjLjuTZEdt0+F19OR6A5P4CpS3wlPXlzb+GFcRNXFQo5kccwht6FNRu8c/tHNzT9sKUMmkkIzgHYDpS4OBgUvc55hCiegetepAKq4UsJFfcXC1nzqGMyc5UeJ0nompXSDapGr4o5hKir6DNQ6zhr1NFXZ3H7zUhXj3GlH9P1qvUtsoc/CTTrLHcSWWo4Gx4wD86yb+1xakntF0xcHG0q7+EpgE88pdJz9FVrqakBtrHRxNZ2/a3gIXZ9HXPh3amvME+ikpV+lJfCXA1SZ75lNhyAZndKW1FxpYGOoPUUydszdu9nkWx7u25JU2As57p0JPCCfI5/GnjjDnAZY2SVYx1x51ylXexHYizuSHEZ6LTuP6Vu7GyPTOZAaVXqe2Kt0JDQXxEPrO/kQP1oU4XPWrH1a131mjrI3RKea38tlD86CPZx61mdfp8W8QWwDdxNiIcCm0rxnPWlm8FZSo+E8/gag9ISXrho+OuUlSX28tOBQwcp2z9KmEoyU8SiNik1pUIOCJUvDYMqW9GPb+zi42hhvu3WrtwvfzYJKfwqubijjukhwD3lk1Z/ahEft/E4hhQiznkyC70LgTwlP6/OqvfeL0hTi1ZUrnQWqA4WStPAEbpR6UZ2F56ZptTEdZE62Oe2RwOakfbA+Gx+tCSBvUtaZj1tuTE6MoB1pXEM8j5g+h5VXSu05lSNgzRunb61e9Pxri0RlacLH3VDmKKoLrayk9aqnRLrLc5562b22X/ELQOTGc6pI8vI1ZMNlanQpJKT+BpqqBlyY10q5YS87HbheOx56MFJbUh8qa4jgLI6VXlwj+1siJjglxspCFbFxPl8R+VHBFtb7KrR+8npMfh4i2Y4ySv1FBb1pmTbgh9l/2pLq8d+DuD/N1BpBoGKvYxOBuOPy695qqgQDk8ZP7Rnp++T7FeW5sbKuA8K0dFpPNJoY7atLpZjI1PYUYt1wTxKbHJtZ5irDlzG4JTEtSGkNtjDjimwpTyupOenpT63oi6i0xP0tPbQUSElbGBshz08s0W+o2ONQFwOh+I/11kb1Wxekw9O07MlKJJQn1UcCo282exQLZALWX5yV5lIyS2pPxq0NQaZ/d1/kRZiloQ0ogpHOgu72lEl1DcKOvxKCUpJyVE0fZo127sTO2aUpniDtm7P42rdTsNWuQuDEcUVO8Q4+BI3PD+QzWjdL6Vt+mrUm3WK2txGgBxurPE46fvLPMn8KHtNaIumlosGa2ph1W/etk4KeLn8aOLXJWHXI7xyc8bavNPl8qHGmVF3KOYI1QzkR6zaYyvHKWXl+XIU8DaW0hLaQlI5AVwlQ86UC+I4TyHM+VVBTmdWs9pw6tLTRWo7CotEZ2XJ9of8Ad+yKlhHMlzvFjDaeQ/Wlu6SE4FWj09JPyzIMMhy+DG/cN/irb8gaIIcZMdnOPErcmmNniKdL8tQ/tHSQfQbD9amVNKFVag87ZzyyOZygZOa7OTXwGE4pN50Nt896DIPSdxiJ8XE/gnwppVRCuEcvOm6U5Rk9dzXYO2c1IzuZ04oFYAo10IfZolznjbgaCQfUmgbGV0bW5wW/szkPclyHgkfKhNaM17PciXUAEkmHoliVa2XQd+9QD9arL9oe2i5dlUVa0BYi3Rl05+yClaSfxFEenLqZVuDKleJLiPzFIdrzBkdkF7SkZLbIeA/uKBpLXX5OpT5zmpQLwvQzI77HdLKeYHKhq6/5vJSpHgCh9DREJCZCSQcnmRQ7elhU5tstd5wjPdj7RNbKrO7Bi9esHdWoS1Z4ctaQWpUtayPIhtAI+tCPcwvM/Wj3WdudkaNt4bVu3LdVwn1Qg1WvcPfcXQOtOLSJ2765xNN2e/l68tW5bYLTrPE26nnxDmDRKeHGRtv1qjdJarfj31qNNWlgOfw0PEZ7pR6/A1dLK++ayHA6oeFSh502QhukHfkgiIXVNkvJOjbw8hCprXfRyeYVkjKfUH8Kz/qfSV20pfnLfcmSNyWnk+46nzB/SrZ7TbQ/J0sxd44UmRb3OLjRsoIVz39Dg1D2zXNv1NYRprXbQV0YuSR4kK6E+R9evWqbAHO1usvO2wbW4MqdKDyNPGmyAKL7noVu2SFceoLWWeaFKWeJQ6HhANRDsGKw4kNTUSR1KEFIH1515KGzKPJYdY90/Pm2yeiVFeU0oc8cj6EdavLSGtxLfbZuENIUogcbZx+FUbBbV7YsY8CMYxyo40253Vyac6BQ3pnRpty4MceHphwDNhajtq3NC2dpDzLSA3xAOL4ck+VC6W5lksLssIKHlLDaHEnIxzyDRPPhN6o0rZJ8WUO5DARnmArG+aHp8NVvQm3ty1PBQ43mlDwpV0/9ayejfC+Wx5ycjHxmmoOU2k9z+ciCTdAqQlIRIG7iEjAX6gefmKc25L7Mxt9kkKQQoU8jW8KCXo2UrTuUeXw9KmEW5IKJLaMIc5jyV1FFW6hV9PaXZUSte1/TrS7rGuzLYCZzYWcfe5GmFh0TYbLp6eu+ND99cKXormcpaI5JHTJqzdfW9EzsrU8U5cgP8QP8qudU/aWbhdI78KK4tzK0YRnPizgUfobG1GkALYCnB+w8fhAdobqIu8ZDkggpV3aDwjbYHypZUcJhJeGzjagrP5081BfWbdJiach8DsWCcSXBzdePvKz5DkKmoGnJN6jqVE4URsArkuHhbQPU0U7hKw9npB/L/cBfSAt6ZFNx1uJyORqftOk7xdVpTDgOraG5WRhPxJO1SbUrT+nmkpiRjeZif9K6CGkn0T1pjdNT6murRS+5IQwOTLI4G0j4CgC91n9oAD3P7dfvxCE0G3+fz9JLHSlvgtn98ajgRSn/AETSu9V+FO7TpvSd2kGNBmXae5jxdywEAD4nlVeNyHFPgONrAzvsc1deh9R6cRCZtcCO7GdVjJX7zqviKB8RW/TVb1YsfhgAfr+Mvto8qssikn7P/Ysrs+0tDsCVMGY3w4RkqBIJ8xVcXCK1FuD0ZLgc7tZRxDkcUd6s1XLgPvQBwGQvBSke60nofjVbuuKKitSiSTkmhfDV1BQvc2c9IBblKSLDlj0+AibuE75wKi3lKdfCRyzS8l8nbNNmDlwrJ5UxxjmJ2POI4UPEED5/ClMYFcIP2jzNd86qJnhPM+MURXeWGdGWqGCBxFTqh+VDTquFNLXeQXVx2wfC00EgVW6bmX4S5SApEktMz1NXxtrPhWtP5irG1ZE/eGkrpB4eLv4rrePMlBxVP2x4tXqMsHk4Pzq6pLnE2gqxhWM0r8STZYrCRc5UfCYTmNqbShTCAFoGCB1xUZGQ8qeuU+jCnd08RydqK71CVB1FcoSh4mJTrf0WahXwA2lY95JzWjWzoYGThoyvqBJ0wwEkgmQtQ9DwJoE9nc/1B+lHlzVw2dgY8PtC8ny8CaheJP3mvrQer/uTlgy2YMOlEh1SknhWk1a/ZvqtmRINunucL7gCQpR95Q5fOgG+aWutgvqm5sfhbcJU24ndKh8aPdNdkd81LpRu7WRpSpne4SgbZGeeaOVtvqY4l9WhtsdkA6S1Vx4023SIEpALTyFNrHoRis33O2qsuopNmnJ4VMrKQo8lJ6H4Gtiw+yPUdv0Y1LnXBt+a00C63jngefnVN660Sxq2H7Xb3W03SNlISTjvB90+vlXK767stSwOJ23RugzKqNgelRQ/CfbUMbJUrf617F0vcVKSp11sDmpKckj58qjls3S0TlR5CH4zyTgpXlP/AK0s/crlJwH5LqkgYAB4R+FGJqaepU5ge18wlTNt8WIqElKXT5JPXzJqSt05lPCpLSAo9ByoRgRVrSCEnflVgaT0lPudzZjR2VOPuHCW086Mote31NwBGuirZmGJcnZf2mKsCDbLo2X7e6fEnqg+Yq4n7FB1G1++tPTkSkLGVNA+JPyoJsHYvabVZxP1ZOcCuSY8c438s9aKLdZ9KWshdmNzhOD/AErb+/zBrKeI3aWy026Qnd3IHpP89xHw2g7qyc/LI/nyikaCuI+CWylaTuCMUQw4bT7KwhOEOdPuKp0xNhzI6W5ijIWBjvlICVn4450/gwAhZXGc7xB5pOxpBqNUSPVwYNqNUccjBgnqC3d9oC/xVpx/mylY9RvVNWeNJ0n2Zm/OsFMi5OFuFnmo4xxAeQ6etaWuVo9us8uEjKTKbLRV5A7H8KHrlpSCzfoEuU0h6Na46WLfFIylKgN3COp8qP8ADPGUqrNTjIJyR74HT7Tj7Mzul1yHIPU/t+/4ZlS6S7OI0GGnUGsUKUpzxswCfEvrlfl8Kn7nNlXAJYaaSzFb2bjMpwlI+A50WXBovvKfcj985955WAPlUFIMvdAfZYT91G35Uf8A1z6l/Nt5Pb2HyH69YwpwRnvBd22zigltlaB8OH86Zt6fvUh7DTDrhPRKwf1qefgvPZKZTTh8isj86e2GzTf3kH5CFsMNjiU5nH0o06s1oWyJYTgZM7iQ37FZvZOAKmunic4kcXd+nxqbguM6b06u+3VlsTlgpioKQFf3jTnT06RJuMtEl4qt7LanFOOAEoxywarrUd3fuFyW46+t1GSEFXRI5UurrfVWGt+BwSff4fD9pTc+AUs4AwT8c9v3+EQfnOzp70t9ZW4s5UTTSS8EoOTimzDpIJzz3ptKeKl46CmxUA4HSZ3V3b3LRNx0qNLMDwAdOdMgcuAU+RskVB+ICIvnArpJOKR4ia7BqjEmJy8ocSRSL7hcdKq6eUO8+VInPWpATzNFYgJnNY5hQNXEt/vLO2vOcoH5VTbXgC1j7KTVk2WYZWlGFk5KU8J+VLfEk3BTLQMpM5dpLIjdqF6QE8KXHg8P8aQf1oJcwpCwD0zVj9szKmdftStgmRDQfmklJ/IVWzS098OP3T4T8DR9LZqU/CAW/WkZdwV2Vjc7yVbf4E0PcB8hRXdI6k2lhtQ3Elfz8KahO4qOqBLg/ATrdpeUmBbr3EES4thSQcpPVJ860Z2T6eiWXQMZDaBle4JHSqmvfZ7erKyqY3GW9HRuopG6RVyaMubaezy3vbf2YGPXlQfjVy20KaTkEzZ61c1EV9TjpCa8yo8LT8p94gIS2rP0rHi+zrX9/vE28WS2SG2FuKWhRVwcQz0rT85Uq83xuE+ALehIWsffPlRK0ENtJabSEISMBI5Ur0Wtfw5TsGWaLyi01hWGSeZieVD1dHYXE1Fpz2ttO3HJjcXD/ixTBrTNlmtKL1qYiY/0rL3Dj4pNbrWlDrfAtpC0HmFJBFY8/aGtUSx9pqVW1sMNyWQ4ptvYBXXatD4Z4wNZb5TpgwNqUYMy8YgMu32y2zQ3Ff8AaiOWBgCr47BNPiVeX728g/5snCR5E1nW0vpEgKcO/rWnuwO9xWnpVtcWkd+nKc+flTjxUuvh9nljt+HeEaPOxyo5xLL1UJLqYz7QyyQfCeQNQ0Vsqx3jRHqmjSTbnZkKQ064e4QMtJSN+KoNtIhICUN8Lp94ndWf0+FYnT6gCrYOohunuHl7B1EfQIJS0FK/hp81nH4UQwkNt44VrWfQYFQ0RpYUlSyVrVv4ulDut9eC0Ot6dsSkvXeSQ3xDfueI4+tDDT26u3y6+T+A+Jgb1vqH2L3lnsOpdQpxKgpIPCCPPrUPOQmU+ol7u1DbcbVCt3hu2atsmjWHSt1qKp6Uc5OcbZ+JyalniFPqCvdVQXkNSwPuMj5Z/WBrQam3e/I+UhZlkmLy41wPJ/lVmoCVbZaFfxI6wPPGRRc4HIzvElRHUEdRUfMj3FQXLsM1TEkDiXFXu25/dzyPpTHT6hhwSI10+oYdSMfzrBFUHJypP1ol03Hfkj92PsKdhrBzn7HqDUENfSWXC3cbLDdcScKPDwnPrSNy7SbjJhqiwGGoKSMFTY8WPSmdum1Vq7Ng+eenxl97WsNhAHxz0+PvHGs7pCtUM6btKhw8XFJdB3Ueic1V02QClw5pxOmqIWpxZUonJJOSagnXitSEZ95VPNHphRXtzk9z7mLtZqBgVoc/H3PvJNshLXwFMnV7kml+LhbUKYuK8WTXupihzF4wKl58qd52pvHHC2M8zvSpO1VtyZxYoFV2k786QCh1pRPu5qBkhE3VZWa4zvXij4q44t+dSxIGKrXiOUg7qIo10hIC7E4yT7hoBdXuAKJdJSi2+6yTspNDauvdUZdWc8QI7c43/uaaB9pxkn6KH61TyWwHApQKh92ry7aG1P8AZ+iUgAmLLbcJ8kkFJ/MVRjchLxxjB6H71c0nNYEDccxS6vpMOO2MKAWoj18IqF7wfcNc3t6a0hHCAEh0kDHMcIqF/eb3/wAufrU9S2Hx8BOuwzP1HUGnGyhxKVJIxgigybEj2EqhR/BFcUXWkdE5O6fhmid6GH08QddbX0Uk1XWtl3W3S45lKLsbi8DwHI+RrKaUZbbma/wmgW2hA3XtJhM9aZQSlWDzNEsKcmY3jdJTzqtYMhckOShISNtknrjpRLZbgy0nvZLyW04yrJqPnV3FkU8rGOv0AC8DkQzcmsxYi33lBKEAlRPpWIO13VKNW9pUyUyoKZaPdNkcsCre7aO1J5NqcsGnmXsuDhckBJAA8gazKlp8OkrSsqJySRWn8D8PNWbnHJ6TN6keUmwD1Hr8B7R3DYX3oq6bde9MaeiWZWnVSXZ6QHJj7hwOL7oFCuh+z9+/RE3G5XBi2wCSA66RlWOeKsuFG7JdH8cly5Ju05pJUlKjxpKh0AG1aWzUoF8sgsfYd/n2hPhwer1EcS9dPX2HqGxRrnGdWFJGVsg8JzjlUo9CZD7clUclTgyEdEn1rHK+1W+K1i7dGHzHSpfhab8KUgchgVYr/wC0Tcl6bMVuEyiXw8PtBPL1x51l9T/xnUhwaMEHtnp+8jYiFiam47/zvD7tL7Ro2kLQuFbnEOXV4YGDnuh94+tVF2b3NtzW69R3l5TjMIKlOrWcla/sj4k1Wl8v0y7z1vOSO9kPK99xW2T51O2SMuNam2pJUXFeJwA+Eq+HWtFpfDKtNpzplPqYcn+fhJ1aipT5a/8Asvrsrly9Tdq9y1BNJLrqFKx90E4A+lW5KaWlOUJPElyqi7B32xqScjke4GPrVwS5Smrs4APARvWJ8fyNeUUYAAAHwg2rdm1GAOgEbrQ2pspXnwnB9M1GvOojPhKQ4HAflTptapK32kAkqTkUsUNRY6HpCBJcQccKNygetLV9BwZ5fQcHn4QA7Rra1Gmxrm2kI9qR4wPvDrVbTHVJUhbZ64V8KsDtKvMa4TI8OM5xiOCVkfePSqzlOYGCdq2fhYf+mTzOv6dp7V7lqQN1x/5+Eby3uNYTn1pi2rvLggdBXLzhSk+ZryBkywT5Gj2OBFLMTJJRwCc01wXHU5GBz+NLSVhOEjmaSSTxg/KqB0kTHQPKveLflSQPrXSSCc1CeEWTzpUnDeaboPi2rtxfhqHeSHESUd64zXhO/KuSeeKlIxNav4hNS2nXwi5I9SR+FQylc6dWl0IlIOcYWDXrFyhElWcMI/7R2BO7M70yBuIxcH+FQV+hrNBUqOoBIJBwUkdK0/fgZVnnQxv30Z1sfEoIFZdgviTb2jxJUtKeBeDnBGxFA6f0ym4YMTu0gvwWXMEfxFJwfQCoXJ8hU9cmR+7GSf8AXr/4RUN3KPvVK8ktzKSSTP03ts5qbDS42oHIppqK2sXWzPQ305StJ38qzPbu3KBpKKPaL7FeA+wFgn8Kko37R/8Aldd41ms7jCQ8sJcUjdXDnekDaF63ypE2q6Tyrg1dg+/mEzgm6QfMdLBfQ7kodPMVK2mQ84UPusr4FH3ynIqyZOnLbedOx232wTwApWOYOKjLTp1VknrbUAuOrkrofQig0WkO1qjDHr8Y3/7qq6psj19/jH1vttnucIIkxYsnI3CkA1w/2eaOdSeLT0HJ5nuhT9y0NJPtNsc7l0b8PQ06iXJaiWJzYadT16GveZYOa2P3zN2szEvUx+XeVJr7sRhXSxuK04+7BeaBWlgKPdq9MdKyfeDLs8x+FKCkPtKKFA9CK/Q+TOhNRVrW8jYHO9fn/wBrkpu5dqNyVbk8aVOkeDqa1v8Ax/X6i5WqsOQOkp1LvZQXfqCB88wYRdFcyd6dM3MupKCvc15bdHz5UdT8uXBhN+ch9Ix8QKkrbE0nar4zxXYXJTeStzuyGUnyHVR9eVaOhnLYEWLVYMMeB8YSaetERMMT54Ly+YbxkNj19aLhIjJZSpsNrChsRQ7A1A2/KXEDDCGHcltxtPCpX96o1E9395LtxTwPNrIKRyI5hQ+NTapktBYys7lsDZl2dlF+Fr1+wgDKZP8ABI+PKtIzLla2CgvONrClcJUDkA+tYfh3CTBkofadUhxBylaTgg0S2/Wt2jL4/bHF5OSFnIJpN4x4CNbcLkbBxj5xyPIv2mxsETVU2+wYV0Zhxm0q79JPeo5ctqry56jk6biyX/ake2vL7ppviyTn7RFVhd9X3qXpFeoI00odjOhhxpAwEpUNlUP2aRLlINzuLjjjzpyguHJAoTR+ALUpaxsjoR7kQwHT6RD/AJZA+2F8iWtfE46sqWokqJ6k86hpbvF1rh6SVDANMH3FFfCelM9uIi1OpNzFzPpKkYylRO3WnERSUJW4rkhO9RT6+EZJ2yK5dkqdb9laJBcVv8K4wyMQTOZJRHlylqfXyzhPwp8ABg0wYbQ22gJz4RinaVCq2nsxbO2a+Ctq5OelehJxnpUMToiiFb144vwk1yM7nypF1e+K8FyZKd5yM14o+GuEq2514tWE17HMjEXFYSaVguYcJ9M03eJ4a7iqAc+RrpHE8pwYSvL7yWgHkSPxrLt7s69P3B2bEH8JTyuNA5e91rTXeZdYVnbAP61S+qYaF3S6290eBby+EkcjnNBqgnL4ETLnHlWBktcJIkrB33B4E7EVDd8mvLjFbZsrbawUrE1wEp2PuJqH9lP/AM9J+tU3Md0okxbNHPPX+PDIStD2xUtPLzq4bZpyHp0xXLXGQlbTgUtYGCqmxtDreoIc1kJQwylQI6kmiQJUtO/WunRCo5m48PoQZIHM1VoS+M3jTMcBwFaUAEZollNj2Rwr2SAST5VlfSOprrpqaDHcK2c+4Tyq5Iuv7pqCyusRrclSikpKs4xSHU6FhZuXpIanw1zZ5lfTv8IS2e8MTHFsNvJUpBxzqSuMBVwtjqGVcL4SShXkayvqzVt/7NNWofeYeMST4krSfdV5UY6X/aKhzYmH5DLSxsoOHBHrU30L53VGet0oNn0DjcOx4kJre69rrrUu1WjTz/CklCnmRxEj0rNl2YvNnmuNXmBLjylEkiSgpJP61+gen77Hu7XtLDzbgd8XEggg1Ddq2ltK37s3uKtRssoDTKnGpGAFtrA2wf0pvpfFv6ZhUawM+3WVeJI17BG4P4T89nJjsqR3fGdtz5D5U4RKMZ5Cxvw9D1pdOnbgu6vN26I4+hSsIUMDIqWgdnWq7hMDX7qdQOq3CMCtOuoAGc8zMnSahm4Qn7I+sN3aXdY6HHxGYcJ4V4+0Onpmie6OR4Wp4VxQctyEGI4fJXNJ/SoTUOhU6X0v3k65RDLUf4UJs8bjnnxHknHnQzbrzMvFgftYKXJLS0qaUo+R2yfSimtW1Ac8yVtb1HZYOZZy5QJ8NcJlkpzxYqGhS1SWiCQlxB4HEg54VdRSrrojsuOOHCEpKia8CAMyAaWf2dw4eoY1+tEqalCzEDyGCR4ik9aUUUJSlCQAEjGBQlo2E5BtInvcSZMs96roQk8k/SiMucThI5HpQVjZZiDwZdZqd9QU9RFOI8YJ5VyvBOfzrgOAkgcxzrwkmhicmCExlOUODHrSdu4Vy3FH3gMUhfJKGg0hpJ7xQwATnJ86f2+KIsRKCfGd1H1qR4WSBwJIpJxSiFb0gk9KcNYNVgTw5kjBZDqvHnFSsu1SYrSEuR3G0qAUCtJGRXek/ZxqOF7UkFnvk8YPUZq2NTT2dTok21uK0lTKsQ3BsVY5pPxqjU6o02qm3Kkcn2mk0mnU1qNmc9T7Sjnmyn0pgs4X61Oz47jLy2nUFC0nBSoYINQbycLxRe3uIt1mmNTYnKVYGa8UqviCK4VucVWV5gBETdOcCuo5/jCknM8WK+ZVwuCvEcSHeTwWe8jp/kzQLqeIJKro2hALiXy6k43zijFLmZrQ8magZyM3+cMbFST9UihCuJO0ZlCaraDdvjPoGypRKvQ8AFDn/XKrK1haECyqZCf/AIx3B/wpIqufZ5H3DQOo+tBzNDu5bCOFAVxKwc9BUs1HCgAnnQtHvDE2U9EypZQf4ZSNlfGiW3OtxWEd8rAHMnfemxItGczXaPUsbT7Sch2hami4d8chVjaQU20hLTDagcePaoPTaGJbjaStJQat/TdstzSD3QQSdif0pBrrVqByI41OqSqgkjMrzXGhIPaHY1WqS6WV5yh9AypJrHHaj2dXrs41I5AfccfjkcTUkJwFj1rZ2qdQXXS/aM4zBt4lwOBLh4TuCeeKq/t51jadXaeiQmbY6y+0CVqeTgj0HnVmlW0lSo9JH3RLqrK7lz8PtEobs+7W9S6LmNmFLLjfIsvHiQaLO0Xtj1XrKGIM4oiReHiLLGwX8T1qhboHbfJdRghKDkH0pWDqR15gRpILgGySeYplXfR5mLVG4dDEf9bYV2FpKuzHi6Sl5xOD0URRZo3Xc6zzXUP+1TlONltj+KctqPoeYqL0xoPU+tbkIunLeuWFe86Twoa/vq6VE6hsV80dqmRZbvH9nnRVYUEqyPMEHqKPSwZ5kazfp8XLkD8IU9oFwl3DgmTWwzOaR3Lwb5eaTt1qtLbcJUG4B6I6UPbhJG+c1OLnPyLS6iSSpx1zi41nnt1qLagpQpCu7AcWvHGVbD4VK7dYylZRqbTbYbD3hdoi5SGrm/ClBeZGVJUvqscxnrRzHjru98jWvBDWe+f9EDp8zVOOz5UF1mS04cMuhxKPIjnj41obR0Jxqz/vaYyWpU9KXC2rm2jHhT+tSW0oprPWU7sCEOTslKeEAYAHQUokEUmFjOa8VISnrVfMgAYnLnswSjvQtSnDgJQMmngUA0FnYEUwSwlyQmQolShsCaePJWWQhI3rxA4lgEg+6E3VReXu017oPnU8DvtSDMQNqUvqacJGDyrxMkYomnLB8W9N0janDA8VSQZllQy0J9ONKevcVtA8SnUgfWrNXBZhzJLlxQ+2llS3OEDHH4tuE0GdmkZt/WjCnRlLKVO48yBRtEXKusuXAdLi2HQpSOLfuyDkH0HTFKfFLD520dABn7TNdpmKpjoAOYM6qQzd7Ii7NtcEhhQafH30n3VH16VXj7XpV0TbdEiWB+3hhTzsphXE6OSVAZAqnpQ8RFGeF2ixGVegPHylWrrWxMqOkjlJpFeAaed0aTXH4uY5Ux8qJf6ZjI9aTxV8lChg4qVj2uXKc4Y8Z10/yIJqTRpK9KTkWuSfgjP4VU+xOGIkx4c55xIaKSqenI/0eKjpiSdSTAfJv/honcsk+2TUidEejrUgFKXUlJI86G56SNRSlYO6UY+lCOuRkdIPfpLE5IgRrxkN26PgDC5S1f8A8aKrnuG/T6VaWvWu8skDCTxe1OdP5E1X3sbv3FfSg7am3dII1DZhFpi52g21vu5LYkL99JO+aLHJBMcKO6RuR6VnQCTHdCmVqSob7Gimx6znsPoanOKcaG2T0FWVakAbCI0r1CMctxLojXyXFAER1YTzBSelGemte36Gy6yl3i7xBSkqO6SevxqqrZJakudwh3DD3jQoHceYFXFZYOgbRaWJ9xmvy3ccXclWBnywKsL1X1/Uyen2whXvqY1k5H5iT890u6ejyWZSnJ7CypCeEqKkHchR+OTS4haL1rbERLy1HZlrGOFZ4DnzSr9KWY7VNOt2p5iBbG0kApA4RsKqDWOrGYd5bct0ZK48xJUtC/dDg6g9Krp0lzgjaVI6GX3LU53vxGXa7+zZIt+nZWoNNv8AtsdhJcdjkfxUI6qHmBWaP8mZrKG324zjiF7JUlJO/l8a1FpLtvnQpv7sn949BJKCxJVxYHI8Kv0NfdoSLzpns4fuOhVwntNTHCtae4Sp2ItXMZ5gZNRFJ3fT8nsemf8AcWDTUNli3HwgJ2PXPVWmdWItNuaLTk4BL7Dw8OBuFEeYp124aT1JK185epLLcsutpCjFSfCEjqP1pDsku7LmqocqY6RMYXnKznvU9R8avbtWmQrXpS93WAsLkOQ0NpWD7oX5fKotYUuVaxyY4rqpu0mxido5+WJimZGUd30EITsMDak0JZbgqCG+NR+z/wBcqcSu/bdUplxQyc4O4qNemr71PGyltY5lPJQpt5prfLD7ZlmVccGTuiLErUus48Z5vihxcPyT0IB2T8zWhVFROOHAHIDpQh2TWJELTbMh5GJE9ffOHrw8kj6VfV87PkwbIxc4SlOtqSCtJ5iqbLlq2+YeWllGje5Sy9pWgChXCWiVAYxvk+tXVors2hT7G/PuSCVupKWh931qsdQ2OVYtQP291J8CvCfMdDUaNbVda1SHkS6zQFE3Z57j2iMGGXlBKd6s/THZS/drQ5LuDq43EP4IxufU0H9niGnNaw2ZiQW1L68s1ptKuFAQMBI2AFJ/G9fbp2FdffnMvorFdQbGSZmi66Quluu7lvUwStOSCOSh50NOtKbWUkYIODV/do7zLT0dacBwtqyRzxVGy0gvKVjmTR3h2pbUVB2Eu1mkrWpLUGC0ZJ4uVPYqCTk01Rw8VS0JKCRk00r4gelry0KdF3B606jZlMsl04KS2BniB5irnbjR3IaptvbU0t4DvGlDCkjrUHoW1QNPWyDLcY7643EcQcIyGUdB8aJxfmXrkuM5G40pVw96nY5rH+Larz7yal6d/fHw+cc3uxO2tenU+/2fORc6AtxxlxGODjAdHoOv0qg3uB64OIZJV41BOOozWlp8GS7ZJiYCw4660pLPFsQojAzQxY9EWnStvDa0plXJYy7JUnOD5IzyHrU/C/FU0qOW5JwAP3ktPrE2EPyewlSRNPPrbD0xaYjP33RufgOZp6yi1w1YiQ0yHB/ppIz9E8qsK621oNqdbioW55ub4oXdHehyHIZaDih/DcSgJKVDkPgacV686gbj09o0pWtxlRFbJc7kt11K5PBDQ0ouIQkJG4wBtXdlt0yLIVflznYkGOeIvlZ3PkkdTXlhYW3ZJku7MoTbm8HCjwqWsdB5ihe/6rlXYJYKksxGz/Djt7JT/U+tcWlrrHSsADoT/O87Ywr3AYx3/nvJDXWun9USY0dthLUeNnhKt1rJ2yT5elVjc5hbuxQtX+jSalC8lV0SnO2KEtWulvUqUJOEqjgj1wTR6JVp6xVUMATParWrsFdQwBI3VN9P7rYbbCDiQsBRHLwpoO/eL/8Arj9Ke6h4jaYx/wDMr/4E0PZV60Dfa4bAMTtqHJ6wQVLb/eSojwDbg5E8lVIPaanvWZdyglLhQfG0D4sedQV5tN3XMIlRVRnUDIK9sj0NOLLqC4WzAVIO2x4jQH9SoO2wQs1eo+0lNLamkwp7USQpXAF+EK+yfKrckuutd2S4S06kLbV5iqXuM+BPfTJQ0hmRnKig7Kq19B3RrUemV2V5QVLjDjjqPM+aa5pNaNNecHKmG1o19Xl/5Dp+0esyX0ry0tQzsT50QwmIdxiIi3EYb4woOdUHzqFStTR4FIwUnCkn8qVVLQk/wVHh+6eYrSi126RbXYVYZ+6c640mrT9mmPtREzEOqStmS1zbHXI+FSHZfqhh6O7py8nvrfcGyw82s7b7BQ8vjUtCuTl1saIhc/iMngPFvlB/SrJ0/wBl+ivaI0lyUmXMGFpDGEDPy6fGhdVbXSmLu/tHa6NT9LUfTMo6ssU/RGt5UJhTq22V8bchsHwpPu5PQ1ZttvU7tE7Fr1GKk/vKDFHeJJx3qUHIUPM46VavbF2eO3TScnUOnHf84hJ4LhFTzdaHUjzTWadLxbhE1s21HK+5kIW042k4GCM+dJ0taxhbUekF0ziiw0v9VuPv6GBT7S84wR55pSzadVfdTxbcgbOKys+SRuam71JZgXZyLMZS+2DlLidlY9fOpvRcm0xpr06I4oOKTw4d5gelPP6hHbyn4J+6BLpNzek5x980LprSdkNojqafUl9lKRwdNvSrejT4TllbhvAjCQkhY2qjOzHVDK9aRUvqSthR4cnlWkrhEiS7coJZQMjYgVnvGN9Nq1uSV6j4TRjUVbVBTHxHERt7rUKzp4SAgcsVU/actmZeYz7LeVFBCiKJ5EuVHYVCUolGdielDV2jGWsce/CNqr8OrFV3mEy9vDQ6OSesFLF/m16juhQSpKwQfKrihandeWkF3iQDg71SPeljUKGgFBIVuojaiiFcG2H+JMjAVzBonxZBYyk+0t8M0CWUMCOhlqyrJb9RQy9LkHvF7JUD7g8qB9a9nlutWm1T4EpxbyFeILxgj9K5tmoA/LVHQ6+oN+LDSSc1Aaz1ncLq1+62mlMRkHcK95Xxobw2rU+aFrb0jrBdbpTpyPNOR7QGTxd4R5Gpi0RJU64Nxo6eJaunoOdRLXhV4ql4FwXDkIkR1lt1BylSTuK2XIB29Yn0RVbMnpLksmvbVCsjUOd3xW0kI2Tzx+VTTGubRLbQ1YoCnpah7zwwlseZqkZd7euUrv5S0FZABKUhP5UqzcloYXHjuraQ4ML4TgrHkfSkVngVT+o53H48Ru1elsJbHPz4lz6T1ROvup57Xfh2FCRu6BgOOE9P5Rg4ovdVxkA8JB6KG1AvZPCSnRd0kIA4lu8P0T/zo171p2Ey6pYQl1IGSeSqy3iSImpZKxgLx+EVa0IbyEGAMD8JFSpFnNzXbn5YiSU/6N8EJVnyV1ponSsEXETrhJZ9kQOPiQ4MbfeOeVJ67gom6LkSVBBmQAFpcTzKfKqRXcni2QVqx5Z2pp4boG1NW+uwr2Pf7ukMoTNO9XI7Hv8AceISa+1E3dbiYltUUW5k4bSNgrHWq7lulPI06lTeeTQ3eLxGgmP37mC+6GkDzJrWaetdPWKk6CBavWZArXoI571f7xCgTsKHtWOKN8iLPLu1JJ+eaII445JJ8qgtXNeJp0fYUn8QaHuOYmsPpJg1f+D9xxT/AOZX/wACaHPB6VK6hfKbLDT/AOac/wCBND3fK9KV3HDQcwZ1S/cHrw4/IeW8xnhTvngHlUbIsxn6cXMg8SZLSvEkclJPWiKTbblGvTr0hCVxH1+4eaaK7TZmWo6ghk8K04ISKlVpfO3CwQ7ad+JTjFkujLRecZePrip/R+opVj1Iy+VlspUM+oq1E20MNd243lPqKFdR6QjTkF+AkNSBvt1qq/wPCbqTkiEU2NS4MvS1r0lrV2M43cPZZigC8hvfjHw86nJOnezeOSld0lqdTsQNjn6c6yDaLretM6jBLjrLqDkEEj5ir9sl5b7RrUUAoj3xlGeP3UyEjz8jQVGsurxWWIxHeKtSC6IN/t7w6hwNLpcUu1yLnn3CrwEH0NHWjnoFoC0Qp78d5z7UlnOfQKHKqct1k1BaZSWpcV9CXVABWCUq9cirjgaC1E3AbkxbrCXxJ4ihTmPkc1XrNTqR1OQZRptW4BQpgd4YacnQEX6ZGlv96uYgtuoVkBYOxGD13NZf11o+4aa7RZkGOtxkNvExnUA5UlW4H0NXpON4gMt/vi3rBZOW5jI4gn04h0r2RcYVx7TbVNksNvoXFSV8ScgHlmo06izmwL8/snrqFvtXt/qZZl6E1PcbxFR+5Zbx7wcZSjOU561Mai7PLtY744UQ1IjOpC0ADYbbj0rX+stKl20G9aZUGZqE8RQjYOj+tV5pKyXXUesXY18YW2hHC48Fnp0AppR4ktqGxwMDr7zlPh9LA2hyPeU3piNLsrTSlBSVJPF8K0VpPtWtsqMxbLmru3yAgLPI0Uaj0FpR6wud1BQ0tKMhSdqyDrfU1o0fqNTDs4J4VcSUblQA64qu3U6fxFMMCMQjT+UayXPp+PE1HepMdEhSu9SUncKzQfD1DAl31+1LmpW4kBa0ggKSnNCNm1G/qPT8Saw8pTTrYUlZyMj50radPwGb+9PjxgJEgjvXsniXjp6Uut09npNTcDr8Zq6dPsrUg5BluQbRpR5CVriMuuH7ThJNc6i0db12Rcm3sojuNji8OwUKd6XgQX0IbdWA6kbDPOiTUMZhWlJkZxwNhbRTxZxjaqXsxYFyYiv1b0XAVscygrfqiPZ9WQ2g6RxOhC1o5JHrV9O6WsV9jtzZ9tjuuKA8aeSx55FZDvFyg2+ZIS682EtKIKuLbbrUr2V9urlqud2tLs9bsJ1AVH74khKhttTLxPRHShbKX5/GB6jxB/ErRXgK3b/cMtc6cFk1q/BtjanIygHGgDkpB6GhX2ktTPZF8QdxkjBx9eVTLsi9ar1LFlJmdxAe8Tjquvpz8+VfXe3ybbKSzNfS6vGxQABj0x8qP8P8Qvt2oQBjqT1M5rfD6tJWW3Et8OkYtOHrnNSUVY5k71EcY4qctPYVzp9u3RRTfg8y8+ym893Y5cBtCnHA8FhCdyQRijeTCkyIvsbSOBpauLKjjujz3/Gs8ac1Pc9N3Bcy1vpbcW2W1cSeIEH406VrC+OlRVcnjxHiOVHc1m9Z4JZbqGtrYAHB+2MhWljeaGA6fHmWZrq+2yzaaXp22Pd8++AHnSc+HyqnJfCnbltS9ykvOpbmSJQfcfTxK33GDjBqEellStzTLRaRdLVtU5J5J+Mq1t1dSCpDnuT7mJyU5B3qqr4W9SaqxGkL9nYRwoeScBChuT9dqtIuYOVfKq51dcnLJf8Aht8NsIkoStWEnClZ3Ax59aMqtIbJEUUspsG/pCTTF0VPgB5aSleACDzyK91F/GgPnGeFsL+h/wCdL2NjvI4kgFPeJB4FDBTtypxOjKeYmNBOcxF/1qq7DMSJS4DKcSstQ4Nmgk8zKcH+4ioLCfu1J6qe7ixW9Sj/APGOf/60UOfvNj/WUlvB3wE5MuO86YhXC2LZbHC8kZQfWneg7Y6m3KQ+yC4o8O4zyp+nIkJB61ZGi7ChQEpTew3AxTPU2ipN03NFCeb5oHSQH+QEi4WmQwqNwcZyhYTuKGr12RXm2Wv29lJktJGVgDxJ9a0iw2gMgBIxTxtLSmyhaQUkYIPI0kXxi2s5A4ndSUt+uswTrfTLSrUmYlod82dzjfFDem76/p25IlxlkLAxsa1R2wdnyWrc/c7S3/AVu42B7p86yhebW5BuRSAe7X4k+lWa3Zeg1FffrF9Vb6f1L07S9NJ9pE+5xhF9sS2+PdS4Moc/oaMbdqq8vTFR58T2dI91Y5KrOumItwlXBpq3x3XXcgAIBOa01pnRmsp1mQzPt3C2pOy3VYIrlThEzZiO9PYHAd+IWWPVkpt8W+THAZUMBSRlJ+IpDVdlkxW/8odNtoVwIIfip6p55TRFYtFTLdDS1JloWR1KckVPN6faLK0uyVlJG4Ttmg31VavlP/ZXdbQtm6swU0L2j2u5wkwJkgNvJ8JSs4NTsm23FetoNz08+yuM6nupiCdwkbhVUj2iabhWy+ImWd0xFd541Z2HrRH2edqS7XITCkFEptfgDufEalbpTg209+xkLNJYxLVjn295oF5tlmIQ+AoEbg9azv2sdlnZ7q2/sXOdZsS2DxcTKygOfyq8xV+oU5coiH3vClYyEihjUenhJjLLaADg7mk1eTlc4JgvhwpFm2/n8pm/VGpX9Lt26FZrOiW7KUW0sJ8CW0JHTGwqdauF2m6fUYIbt9wW34FLHepaV+tSs7Q7qZDcpyap5hZI7tQG3900SWnR7j0HENtSijmKI8MVqQUvbImy1D1+WW3Y7fKU9+9+3DT9zbkoft93b6FCO7x8RURqfWfbpqRsQ5LDEaKo4UhtwAEetaQtWmXETeCayQgcwaEe0ewQ7I8zJhqAbeJBbP2T6U5oFFloQdfcTGeIi1ATW+R/O8zqdA6hubf/AHzdW0J590wM5+dWDbrDo+26UZh2u0oYlKwlbzoy7xdSpVKKkknApBwpcIKuIEclJOCKYW6BgwtqPI9+cxRpdWiZFq5z37j5R7Feet7HcR5DgR8adKurjsP2eQkuBPuHO4qKCycbk7cz1pVO/Oi2qFiguMH4e84Na9TFUbK+x9o8SkrZDqOXUHoa6QrHxpKO84wviaUBnYgjINdBRJ5c6nWXXhjmD3WISGQY+EdpeIHOlEu5+1TMHGx510FYqw2GV+a0crcJTgU3UDzr3vAQPSvFupS0pSjgAE1XuMizExmy4+46+h1A4GzlOBzFVzddYxp19iLYZW2iM4oL73fI5E4o+sTzSFvgSFvFR4vEOVAmpdNLTqx16HGUpmUCrCdglXUH0NHUIvmFXk613HBh5pi6xLzAEmGolGeHcYogixw7OeaPVgp+tBGiYr9qhtxnODChnhHNPofM0c25eLuonqhP50NqqwjEL0kwvOJQvaG0pqywUYPhmuj/AHE1XuT5mrd7UoyW7G3lOCm6Oj/cFVN3Z9PrSy8YcwBhg4mqGUBcpsAZJNXxp2G3GsbIAwSnJqiYLiBIafQoKTkEEcjWgLK8mTZI7reMFA5UH4q52qJ9At9Nfpj1CSFcHQ8jSzaDvnpXOCBnnivS5w+PGUnypEcmBnJic+3t3C3PRXk8SHElJBrGWqtLSl9pLuk2oxcdMjDWB9kmtuNuILaTxDfkKAbdpWHI7bpd/caSostAJJHImi9HqvKVw3TElUQVYN0HMcdmnZfZ9F2FlbkZt24LSCtxSc4PpVhkbbbV6EjNJSuPg4W8ZVtS6y1rX3MYCzmxuZ4kh5PhO5r6UkMwlnPQ0nFWG1FpKVKUOZA2p2UBW7iAr41E+kzjelvhKN1RaG7y8/FfOQsnI5bUGxuz6z6UUm7MSHyptYXwrV4efLFGPb/cP3CzBnwV+zOKyCpG1Zq1BrzXl9jewx5DamTsXEjBA9a0NWoQVgscZjuy9HVLCOcTcWne0vRcyxNKfvDEdxCAFodVjFA+t+3bSi7/AG/R2nZap0y4vBlbzKcoaT1JNZS0np64ync3Ke9JbJyRxYTVksWuBBkR5ESO2hxhQUlQTvkVVV4QGPmgfKJPP09dwZMk579BNNydLtTbfDUl1SAyOLhA97apG229VsWlMYqS2vmFdTTjRt6gai0tGksOJLgQA4jO4IG9TkphHsSyCAUjiB8jSOxyrFGEtt11uTTZ0zIC8xrkq1vP25CFyUpJQlfIms2aolagnXxwXwONvIOA2oYA+FX/AG3tIskqau3SF+zyEEpyo+FRHrVZdr12gzrjFMPgWtAIUtPWn3g3m1XeW6de8jdTd5TIy9JWHdgc6TUkg4xRZa9DXu6WRVza7oN8JUEFWVEUMPsONuKQVA8JxWjS5LCVVs46xHZprEG5hgRIHhroLpsFKCiFA0qg8Sc4xVpWD8iOm3MnBp0kHhChUd7pyDThuVwo3TkVBl9pyOq+HLemxnxjITHKwHCM4rye4tNudLLgS5w+EnzrgrOQDJbZ2ZjHflhLgLn3fOoKPdParpIhPKcaUte3Edh6V3ZrS1LjKfmKd4uLw4Vgg+dczrM1DkplCStaysEBXNWOuaLrWsMUzz+skAM4k/DiNM8iVKOxJr6RHTJXwMrQpTZBWgHJx8KctqaXETJZWMKRkH5VXFoucmLqMtBa1OOqPEoHmDzNV0UvcWbPIkkGWh8whDdzQ2G88WMHy5b1NtNhu6KB/wBUD+NDkWZxzW+IYUnY560XMIjPGXJkPFBaioU2B9pWfKh78pgtCseoSoO2Vkt25gAEcdwW5/8Axiqfx6Gr27ZksSLDa1R+IgPLCioYyeEVSfs58qBv9TZi7UgLYRDfs77QQ2RaLu6QRs04o/hWuOzK/MXC1+wl1JWjdO/MViO66PkSrih2ytqcWs+4jmDV29mOi+1+1tsTIsXLadwHVY2oPVVEoUt49jNVoLrWTyLl47Ga07jKDTRkhrKHNsHfPlUfYbvfRBSjUNoXHdA3cbPEk08uMiPJhLXHdR3gHLODSDawO0wha3DbT09xGMm4CLfvZ1bpKcpPlTGPdER3n5QUONxeKgrld2JCktuOpbkt7DJ5imgdaduPsTLynH+Di4SMZJ8qp1Osr05CMOSM/YI9p0AK+sfOWPGvgXECyMrOwA6mn0aalxfAsd47jcJ3AoKhNPtPJblYQtOwbJo0t8BzukurdCU8wltOBXBZVYm9ehibW0VUj5yVQgcGQnhz0rsMhQrptJIAqG1Tqe36ZtK3pT6A6R4EZ3JqlFaxgq8kxGoZ22r1lC/tFQJl8fZiw1pWmMklTY51llarnZHlBtLisHdAByPlWkrze3rlc3pbpJU4oq+VBtxgNSLsmYUIHCOWNya158KLVIveE26tQdmcbRwZXunu0m3tSBHnNiKvkpWPCr4jofUUdovKJTIejupcbVuFJVkGhXU3Z/a7+VPtI9kl9HWxsT6igRg6o7PbsBOjd/EJwF7ltY/Q1DdqvDj6xur/ACgi6iq84sGG9/3mhdK63vOmbmmRCeVwE+No+6qrbf7bI8vTrrTMJ1M1aCnf3QT1rNFn1npq4W4yHH/ZHk+8yvfP909aLIshmRCbkxlcTbgyk8qKUaDxBtwHqH2S+7UWUqN4DAdD/P1j5x91yQp5ayVKJUTmuVELPiJPxNM1Oq510lwkUzIPWK31LsSSesn7VqK42ZCkQZS20K2KDuk/KmM24KmOcbiGwo9UJxmmABNKNs94sDNVLUisXxzOG+x12E8T4Mqc90UktpxJwBWgeznszht21F7uCmpJdaPA0RkJyPzqsNbadXYLm4tQQGnXVcCQdxvQun8SruualOohDaIeWWB5XqIDnJGDmuA54uA8qeLAUNhSIaW6eAJGcU1AyIIle7iINwEuTUygcKBzmu7tLjNW4SZDaXGELByFbk+lcuR5S7e+wwopdWMJPlQDdGJURSojz/FjcpSolINX1V+a3J6T20kyxmb9aBZBce/CGRsU48WfLHnULL1dbJhSgwnVISfCScGq7/jKTwcSuEHOOnxp0u4JTCSyUDjAxnHL1q5dCqHPWdWrBzLNiSWRavamJREYgqUlXTH60Dh3933diTw5Q8ooSPJR3A+BqNE9arK/bA4sOup4ykHHXY1F6dtk2De0OSpj0lvBU2lxRPCep361JEKMfaWBeeJbdjakOuJdkElxRyaPIbGX5A3JbiJJ9N6D7A6JKGFNp8JAP5VcNhsqJ8G6rbaBUWMFzHQJO1KPFbQFyf5yJa9RIxKL7Vy2/peG/Hz3aZKgM7fZqmeKrp7RmFDQzKSMH2o/8NUrwK8qGvXBGIDqkww+U2J2TdntsaZbnymkuLwD4hmr0bDbDYbZQEIAwABVGdlGtodwgNIbeSQAARnlV2MOh5pK0EEGsx4qbGuJc8TW61CCCOkcEcWx3FRd1hwVMHvWU5I8t6lkDPOulRkOnxhPzFLEs2nMCru8tgcyjdS2FiJOF3id6ksnjxuRS0bUkVcKLcQg964SkuBvxIFWLrSC27aE26M2FPyTwJAHTqa8tmhYUSxtsvISVtgECua2ijV7bLOo4+yaivxeryFa4fKDOnpk2fdlLiMJkkHPE7so0fNzbwnCF2rB8+LakHdOxUtolWweyyUjIUnkfQ09t91ffWYsxHA+jYjz9RXkRVTCDgRRrdSmp9dajA7HqIyur2ql29SbUzEaeI2U4onFZ+1robtRm3dM+4rE5gK4iGVE4HwrUKWkE5610WAeYozReJnSNlUB+yLV1gVSm0YP3zG7xfZkFmQ2tpadilQwRSLg4k/GtF9pGhLfdrM5cYzKW5rI4uJIxxDyNUjDsM2e4Wo8Zayk4O2wrX6PxGvU1bxxjrA79MXIesZBg+hsDpSj8OJNhLiTGEPMrGFIWMg0Wv6IvjUYueyBQAz4TvQs+HYrymXGyhQ2II5UQtiXcA5glulsrGWGJSWtdFr0xL/edqC3LcVZUjmWT5eoq0dJ6jsOptKINvUmPcIjQ7+N0WkDdSfX0qRkQ0zGFMPthbbgwpKhkEVUOoNPXHs91SxfrI6tERS8pUn/AEZ+6fSkOt0b6N/6jTHHuP52hOk1KnNV4yp+/wCz4y247rctsOR1pdQeqDmnsaOp6Qhkkt8X2ykkD41CWnTiNX6Ze1hAuMhp0FK5UKMrgQ2MYK0AdM8xXIt0hhJDN4uTZxjKXz+tFafV6nUpurUff/qTv02nosCuTj5Dp98njHlpDqkslaWlcLikbhJ9a+LoDKFtZzyUDUTp2/z9Az/aHUC7wZKu6dElOSnP3iOnrRkiZYpM4SVWQsZIUWUPcTR/XHzqen1lpc1X14Ye3SGtoNKUFtL+k+/UGWN2dal1NE006wIrj8YpPcrI90/0oJ1d7ZcLiXH3HHVAkqUQcZqyLX2o2C3WVLcWNHYd4QkpA5D0oIvN2k6tvKoVibW4lXiDacD45oTRJYNQ1pr2j3ht21qWrUAZxyCCTiAvdELCPOp2yaZk3Wc0xEQVLV5DlTS42e7WWRw3KA8wfNSdj86uHscbjmzSbgpILvHwAnpTbW6s6fTm5OYt0un8rc7jpB/UHY7NbsCF2uQVTV/2iTsMelUBqTT67dc3YM1styGzhVbncdK985rNP7QVp9kvzFxZax7Q3gkDmRQf/H/FrLbvJuPWWFEtRiVAI54mfnXFw3XGG0Nni248Zx8Kj1Nr4wUpyRuNs1MNQHn3cuDCSfnUw1DabSkBtPh5bVsbblrPAzmB16ctAJ592NqKEt1BT3iShWR5n/0osQ2y9IYYcKklYPiTzBxS94s0S6SYCmgA8l8ZbA8WMZOPMbU7ZjOTrj+7LbGDY2755Y8WNvoKqzuz2lqUEeqHGl3W/wB0xxwDLY4eIfaxtV29nAfnypEEKV7KW+N1I5KPIZ+tU9ZYMaLbwjJSWvCQfMVbHZ5fRao8paEtBT3Ajjc5Jwf+YrPeJ+upxWMmFf0zrgY5IlSdqMMNafbjnpMcR9E1RXsL33DWge2VxSISFLQELNyfBA6EAf1qmfah90UQqixATFGqrBsMd6Kux0xdkS40pSmVkcaM7VsTQeqo12tDSw8lQI86wM4zeNPvkSmFLa+8NxRjpjtbnWEJERwJSPsE1mrCLU8uzgx/VqEKeXZ07T9B2iFAFO4r2XNi26GuVMeQ02gZJUcVkW1/tN3JDBaLTZWBzJqvdfdvmpdSFcBMlTbJ2UUmlx8PIOWYYgz1VDkuCPh1mwdHa1tmtO0KaYiw43EHA3/WrIU0SokGsBfs/wDaIjT3aIhMt/DMk8KyTW+IsluXFRIZWFIWMgiqNbUFIdPqzms9QSxOmMfLEUSgAAHnTWfCTgSmwA43vt1FPgADvXjqh3Ss8sGgFYgwFLGVsiM4dxt8lv8AhPI4xsUk7g09CgsbEVne/TZcDX8l2LLcQ0snwpVtmnzGt7yy3wpmKx8abN4WSAyN1jx/BQw3Vt195ceoX2Y1pd7xadxgDzqt43DHHDHbShJOTgc6HpWpp84gSJClgdM08gTe9UN1E0XRpWpTBhmm0ZoTaTmF0FS3FYUc0JdpGm4IhoubbSUOZwogc6KbavxAk4oS7UL4gW9q3tKCnCckCrdGXGoULBdUMowbpgyqXFpDmEnONqjL1Ej3eyv22WjLbySMn7J6GnpBKQFAA+fnSa0Z2rUFVYYaYwnmV52S6of0T2iTNOXeY2xGKVJUXzhCh0+RFWbKm6YuLDlzslzYVGSvhdQVgd0o/pVX9pmj3rnAbvluaBlxRh1IG7jf9RTjTulLRddOx5VqnPwZoaClKbVkKPXIPrWZWjUaXVMtJ4PIz0MeV6hNRpfLtXO3v3EsB1pBbKSkEEbg8jXjKyyz3SNkDkPKgB24680e9xzI7d6twOVFKeIgfLcfKpm0a601qWT7PCfXbpXCP82mLASpXkhf/wDamVXiC79moQofc9Pvgf8ATkj6Js/DofuhKMvPpQDuo4q+NBaPhWdpqc2tTkpxscaj6+VZ+ZcWxIy4kpUORP5irf7KdUSZV8FrnS+NJR/Cz6dKu8WWw6fNZ47/ABjDw8KgO760tyVbmZjCmZTLbzShgoWMiojTVnj6fmS7dFyhlxXeoQfs+YonwQKh50hpuQmRkBbKt/PhPOselrlTXngwul2fKe8mWgVqwRt51UH7QaUf5PW1hKAp1bpCRjc0av3983HMdwpbScAdDXK4sO86hZvdzQh0x08EVlYyEHqvHn0ojQk6W5b26DtLBo3rO9+mJnq0dlerbxDTJjWd1LZGQpzCM/Wmt87PNT2NrvJ9peQ2Oa0jiT9RWsUPuYAGw6ClVpRIjqZfSlaFDBChkGmv/wCSX79zKMSkOFOCOJgq5tvQrpGlgqSpBKSR5EUTaYDj+JjgCUoR3Q23WOeTTnX1vZ/y6kwo7Y7pElWEjkN9hTyBbU2+Js4VKUBt0FbE2LYgOOolLs6sUXpmSCnUiQpxJ3Vj6jrRtpGQj2Rp5UdMgJeJLSjgK2HP4c/lVcOqf4glsEqUQkDzJOBR5pYRoNskszkRXY6VlCn3yQeIYz3YG5NCamkCo4kFsYtIPt2Rx21DyBsbu+RjyLaKof8AietXz2rSmJ2iWX2TxNm5OFBPMjukVRuE+QqnToRUoPaAasEWQodbQ+0W3WwtJ5hQoL1BoaO8y7Mt5LK0gqKRyNWuI7CkFJbH0qJnQ+6KmzuhYIoG2pL1IIjSzSNX16TN5ecjS1NuLIwcZp9b3Wn7ihh5QS2tWCsj3alrtp0x9biA8glt1zKT5g0rqnRsixSUyYyVGOoZB+6azx01q5YDIXrAD6DzCJ7R6rMGbtbnO+QCFFaDWkOxztyXEjtWO+K7xtIAQsnfFZr0TrHucWy5+Ng7YVRXebImIym82VziYO+EHdNNvJ0+oq9A4Pb2hofAyoyp6ibyhax0/PZC25zaSRyUcVDaq1vbrfbHG4khLryhgcJziso6Tm6skQ23X5Hcx+nEMqUKM+/eeSO9cKvU0uTwmtH3Z4jLT+HUki3nHsZ5e7qpT3tiySeLJ+dexluPRy8ohKSMgHmaj7lCeksYQ9wAbkY51HW991c7vm2XW1p8J3yk+tS1bWqQKhxH9QUjJhcyoKSOE/Wpi2F4uhLec1ARy+cEhO9EdquEeHISmR/DKuRVyPzovcdmccylzjIEIFqvLMXggwlvOK5HoKrvUlj1LGlKuF5jqCV8lDcJq89PXOG4zw8SSalrxFhXSzOx5jaFMqSeY5etBU686ezlOIg1rmz6JhgTJbjni865SSVb1I3uHFhXqW0w4FNNuEA+lRbTzbzfG2sEVq1YMoImUtrKMVPaPEBtxlTawClQINU0zOl6N1+5bypQiuulTGOW5934VbCnVAEA4oXvdmjXCW066VB5pQcQrhyCAdx8aC12la1QU+sDxLtHZssz27wmRNblRUOoOyxn/lUBddG2S+pV7RCQh1XJ5ocKgfPaurOy6L8iG1xlqSrDTYGTxnpVtyOze+wLOJvdIeATlTaPeTXjfVsCX4BPYwo6Nyc1jI7TPdw0trewwwbNepEqK2chAPjSPgac6R1Prp7VltiQJDCpapCUpUU8CgcjOa1lo7sktt2081cbrLeDjoyGmtgn40Law7JrNpvVke6xEcUhB71p8eFQI88c6UeZpzYa6XIPtziMNHS72hC3Il6RGZb1gZEp4Nyi2njUjlxY3oPvy5sB/MxHGhQ4e+QNiPWnmidZRL3AEGS8lu4MjhW2o44/UURXCMzMiLjvIStKhgjFJ0BpsIcQylm0txFg4/nSU/EvbipLkNADj6Fcs/Z86JoE9ZbbVkp4hsc86gbro1+Dd1ybelD/ABHgWhYz8sinVpt11kTcBhtTqMJKVK4MDyAocJeNTuDfRmay7+nuq3qRLAtClOoIUoqB8zT+4ut2+1vS3lhDbaCok/CoJKtSWy3KXFsKJLiRskPjeqp1hrbUlyWu33ZlUFIO8cJKf/Wmmk8PfWW4QjHfn9JkrKw1hcEbZWt7eVJ1M/MwTxuqVk+pp/GcdlutsMILjijgJFSVs00/e5jYGGGlq4e9c2z8B1NOEWRq2392M1P/AIeVMGQjbIIwf6Vv/NrA2DqBAtU5VXsAnUdm1h6ChB7yS28FOOj3VdQB8DTixwJ15xAhMs54itTrigjhyrqT6+VQ0e23Fu5pCX1OFC0ngR7pAIwfSpBDSosmQtTzeGnikIScqAz7222B+dV8EEI3PaLNDqcn4xLX9uUzoFmKFJX3VxcSVpOQSG07iqa9jNXlrx6PB0VarYtQMtzinPIH+jCwAhJ9eEA/Oqg7xHlUKSWTJ9z+cI1eC+TDruSk1zKjpeiEBOVAZFPuD0pdhLOfHzpS2U5E0LNuXBlKXdbdx7RrXGZHE80olwD7IHnR7dba1crQuHIbBSRjOOVPndD2+yaqevTS+JyWOPB5o9KcPZIICiPhUNHcuGLj60UvorL/AFdMTOep7DNsVzUEIUU5ylSR0ol7O71dbpcBZnSssHdWRtijPVECaqEtbD5zvjwg0D6Z1NOs2sGmrtwhkqxxBsJz8xQdumGltDofSZTTtruCucTREZkNsIbSkBKRgCnSWjScCRHlwm5LCwpChkEU74xjNXE56TUbs9IitslpQPLFew2ECMA2gAUnNmtRYLj7h2SM4pTT01q4NJIwAvkK4VOMyS2DO0nmSUeKpagBtRFB0+m4R1R3gFIUPp6inFtsyVpC1JJonisJjN8KE4oG2/HCyqy3H1Zmq89rN27NNeyLBdYinWmlfw3QrBUnpUzd/wBpiJcdN+xW5DqJCxgkjl86FP2s7EHp8K6MJw5wYUoDesusy7rFGWHnCB1Sc1xiVKu6ZB5iHW+JvXaUIzNIKvypr6ZTMlK1OjK0KPOmwXcI0rvI/EEq6A5HwqmbL2h6rt0hDaH+JvO4Wyk7fMVb9o1VMuUNEliWoHHiBbRkH6VoNFr6b/SRg/GJxhwWU5hJBefkpw42UrAzjzpRxp1x9sBBKMHiVjlTFvUt1aOROUP8CP6Ut/lZdUo/9uVj+6n+lHH4SobQZIwEv225sXCKvgfYWHEK4c4I/qNq0tovVLGqbIlaY62nEjhcbUk4z6HqKzz2f3ebfu0OBbJs5ZjuK8SMJHFjpyrWUWKxEipZjsIabSNkoSAKznj7orKrL6vePdJZikfOMrNJ/dVzetqzwtr/AIjX6igzXdwXOuK0K5I8IosvRjPRilcSQ64jdCmk4KT6Gqnu024qmLS48WwlWVF4AnHlnzrOtqE0/wBOwmh8L0i22G7ocSIKFsPh5gFDgOQtJwRVcdoPb1q/Tt1/cVj1EptaU/x1lHEpBPIBR61ZjwdfbSUHCVD51DXfSMa7WiU09BYdUtpQCy0kkHHPOKarcNRUGUffDdfQ71YQgH5Zln9h92/yh7IIUmW8uRMUS4844cqUonPEaPv3eHJ3fMpCHkjc+fxrMfYPrVzS8BiBM8TKCWlJ6kA4+orVlsvNpu8ZMi3SG1gjcA7j0IoLXUvQ+ccGZzUO4+mTkH8D3BikRa1oKHUFKxsaiNU6OgaitqlPNI9obHEhzG/wogcKGWVvrUAhA4lHyFdRpLEuEmTHdStpYyFA7EUDTc9Liys4Ii/zGB3rM5XJsMPJQ02ErZ8AccV4h6JHT40gqGy0ptpcttx9eMobHElvkck9T6VL9od/k27V70e2XBJbzxFPAhQSeo3FCiNW3pQUTPGcbfwkf0r6Fp7GsrD8DI9/9RjqX424khARJudxDVrjOPFCipEZoEkgbcShzNLu2U2qM3L1CyqCErKu5V4XpY2PdhH2QSN1HpQ4Nf6mtau9ZuTrJUMd6yhCVfDIGaHLhqR+4TTIlynH3VnK3HFlRPxJ51MB1zggD4Zz+kShK6jkDmLamlybpNk3B0lS3SVHHIDyHp0oI4j5iieZcS3EW6E8eB7o60He3r/1aKlTcxyCOk5qLFcgy422ys8IxvXkiC82krQtKsdBSyAE8zXbjnA3kn0oBiegjW251YbZCPOPuJSt3i4uW9JBCiD50/np/hg9Saap8JzVYGIfU5dQxkNcZVtY4m5buFY9zzqur5bYt1YcCUhK8ktqHMUdavtrb1u9sSnDjZ3NBiTlIJoqpVdCjRB4s7CwAiNNBdokuwXM6fvBJZSrhSpR5VcjmsNPMMB166MJBGferO+s7ahDrV0ZGFZwrFBF1flEDDqlIxkDNJLXbTOazyO0uo8VaqrBGZorUXaBa7pNatNukBSVHK1A1O2i5G3oQWlkAb1la1XdbUpC+LCknnV86Sv0W9WxCO8AfSMFPnTHw/U13go3Bgl+ssssFynBmhtNdoMYtJYk4zyyaPY98tkhgOh5IHPnWamEKQcgkVLM3GS23wJfWB5ZqN/haMcqcQ1fFlI+kXn4Sd7X/wB3X6cy34XW0pKSOdZu1P2aOsJcuGnVErGVKjq6/CrzKPbF4cJJPWmD0MtrUkpoxNNWahU3aKtYTcxtxwZlprUU22yCxMigLScKSpOCKONMatjSwqNEeajSVjYOIyKK+0LQUe/2ZyTCYQi4tjiQsDHH6Gs8KM21XMocQtiQyrBSdiDSa82aRwLfUkGpuahvTLXu+uZViuxh3GGhxeAoKQcBY869h9pltkuobehutZ5qznFDlmu9t1E61C1GgLPuokDZTZ/pUrdezK6RkqkQUJlxwOJK2/exRIv1DgvQ+V9u8ltZvUoyJY2m9QNN3aNdLTLT3zKwtJBwRWvtFdrenrzZ20XiU1BmpSAsLOAr1FfnHAZmw3guOtwlJ3A94UVx71LfjhIfcKuXDneqNUV1ijzhgjuIx0+oVU2MJ+hE7XOmpMlu22y5sy5j54W2WFcR+JxyFCOodOvJl+0KSVcHiUemT1oN/Z70u1Elsz5Y45S0cZUrnv0rQF0hNP5bcbylzwmk9gSh/LxkfGaXTao6JlXGMjJlYWjTomMcTR2B3z0ozgadjR4nCptJONyRT6NBjWqSlpKeFtfX1p7PlxLdAckyXkNtoGSSag1rE7VnNZrnubC9JkjtMtbeldXz2dOsIdT3vfKZSrhKVK3OP6Uz0X2hXZDiihbiHG8BbZPC4n5dafawuMe8a1uM2Oribdd4kn0oPvNt76MZMPKJje6FoOCodUmtd5RWhdwzxyIoGsem4hDj8pbt27azD0jMROuTqFLaKEoVzJI6V1oXtGv1w7M0R4ktDR4lJClqwojO2PKqjRp6JedHMtyJClvqHEsqPiQry+VRumb7dNHzXbHNR38dKsoUOaQeo8xS+3TooDBODDhr2RguoUBT7DvLEuyLoJC5EhtxzJyXEniB+YqJRPwrGTU5ZJzV0WpXf8AUM5TsfpXckQy5wPRESFA7LKeE/WmS6lk9LL90rfS13A2pZ98j221PR+NScg8gRzpP/J1uWCtSOE9ODajr95w7la0QXY8eOkABKmUYKaNrDoG33DS5UxcUOScZ4hsPpVNuv8tc2DEkNJUBljkTO9xjOW9RYPiykgH0qA9iHmmrH15ZpNtfKXUeJteCRyIoC4nPvJpppyrpuES6mvy3K44ltFIG9JubqGelfV9S1ekbGNZ27Sc+dNMDA+FfV9VY6w2n6ojK6pS5ZpCVDI4DVZNnKa+r6iKOpiLxr6ySI1OkL04/xb43FVqoBbCOLfbFfV9SnxH++PlFR+oZCSEJak/w8iibTFylw7k05HdKVZFfV9SqkkXjE5T0mjrJKdm2Vp9/BWRuRT8bcq+r6tovSSbrJCF/aJNOJ6E95xY3xX1fVA/Wha/2jIpxIPOqb7aNOWpu2M3ppgtyyrgUpJwFD1FfV9VGvANDZiy7tKViLU26FJOCK0j2SXOXcdNFqWsOBo8KSeePKvq+pT4TwzQvw765gtrCIzZtfOLgAt8ZCyOmTzpzJgReKFcEN92844kKCNkn5V9X1HkdYegHPzmsuy9xbMqN3ZxlIH4VeqsLZSVAZr6vqy/if96OvF/7i/KRN6AMY+g2rPGuNQXaa+uG/MWWEKICAcCvq+o/wYAvzI0f2CZWzm0hRFeLJCM19X1a6ztM7b1iFtSBeO83yeYzsaj9dtpYet0toYdUstk+Y519X1Dan+2Yzu50Yz7x9YHnG+7WhRScZ2NH8NxU62FcgBSkKwFDY19X1Qfqsq0RPl2Cce4rw7UQ6du0+FPbEeQpIUcEZ2r6vqr1QyhzD/Dycyf1jHZuOk5jspsKWloqChzBqp/3bD/1Ir6vqj4cTsPzhdyjIn//2Q==');
    background-size:cover;background-position:center 24%;opacity:.9;
    mask-image:linear-gradient(90deg,transparent 0%,#000 28%)
  }
  .grid{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:12px!important;margin:14px 0!important}
  .stat,.panel{background:linear-gradient(145deg,rgba(29,23,59,.96),rgba(15,15,39,.98))!important;
    border:1px solid rgba(157,103,220,.68)!important;border-radius:17px!important;
    box-shadow:0 8px 26px rgba(0,0,0,.22),inset 0 1px rgba(255,255,255,.025)!important}
  .stat{min-width:0;padding:15px!important}.stat .ico{font-size:27px!important;filter:drop-shadow(0 0 9px #a855f7)}
  .stat small{color:#c2b3e0!important}.stat strong{font-size:15px!important;overflow-wrap:anywhere}
  .columns{display:grid!important;grid-template-columns:minmax(0,1.2fr) minmax(290px,.9fr)!important;gap:13px!important}
  .panel{padding:17px!important;margin-bottom:13px!important}.panel h3{font-size:16px!important;color:#f6eaff!important}
  .actions{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:9px!important}
  .action,button.submit{min-height:43px;border-radius:12px!important;font-size:13px!important}
  .feature-grid{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(145px,1fr))!important;gap:10px!important}
  .feature{min-width:0;background:#171332!important;border:1px solid #63478d!important;border-radius:12px!important;color:#fff!important}
  .feature.active{background:linear-gradient(125deg,#42216b,#39235d)!important;border-color:#d39aff!important}
  input{min-width:0;background:#0d0b23!important;border:1px solid #674b91!important;color:#fff!important}
  input:focus{border-color:#d29aff!important;box-shadow:0 0 0 3px #ad6cff25!important}
  .logs{background:#0b0a20!important;border:1px solid #4e3976!important;color:#e4d7ff!important}
  .advanced{background:#13102d!important;border-color:#684a91!important}
  .toast{z-index:100;background:#2a1850!important;border-color:#c18aff!important}
  @media(max-width:1100px){
    .grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
    .columns{grid-template-columns:1fr!important}
  }
  @media(max-width:760px){
    .sidebar{position:sticky!important;inset:auto!important;width:100%!important;height:auto!important;min-height:0;
      padding:9px 10px!important;display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;
      justify-content:center;gap:5px!important;border-right:0!important;border-bottom:1px solid #9a65d866!important}
    .brand{width:100%!important;padding:3px 4px 9px!important;margin:0!important;border:0!important;text-align:center!important}
    .brand .mascot{display:none!important}.brand h1{font-size:20px!important;margin:0!important}.brand p{display:none!important}
    .sidebar .nav{width:auto!important;flex:1 1 17%!important;justify-content:center!important;flex-direction:column!important;
      gap:3px!important;padding:9px 4px!important;font-size:10px!important}
    .sidebar .nav span:first-child{font-size:16px!important}
    .side-foot{display:none!important}
    main{margin:0!important;padding:13px!important}
    .topbar{justify-content:space-between!important;margin-bottom:12px!important}
    .hero{min-height:185px;padding:20px!important}
    .hero-copy{max-width:75%}.hero-art{width:48%;opacity:.55}
    .hero h2{font-size:23px!important}
    .grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important}
    .stat{padding:11px!important;gap:8px!important}.stat .ico{font-size:21px!important}.stat strong{font-size:12px!important}
    .columns{grid-template-columns:1fr!important}.form-grid{grid-template-columns:1fr!important}
    .slot-grid{grid-template-columns:repeat(5,minmax(0,1fr))!important}
  }
  @media(max-width:420px){
    .sidebar .nav{font-size:9px!important}.grid{grid-template-columns:1fr!important}
    .hero-copy{max-width:100%}.hero-art{opacity:.22;width:65%}
    .actions{grid-template-columns:1fr 1fr!important}
    .topbar .pill{font-size:10px!important;padding:8px 10px!important}
  }

  
  /* ===== SAKURA REWORK — CONSISTENT DESKTOP + MOBILE ===== */
  body{background:
    radial-gradient(ellipse at 88% 8%,rgba(145,70,220,.24),transparent 34%),
    radial-gradient(ellipse at 10% 90%,rgba(91,45,156,.2),transparent 35%),
    linear-gradient(135deg,#080719,#100b28 55%,#090719)!important}
  .sidebar{
    background:linear-gradient(180deg,rgba(20,12,43,.98),rgba(10,8,29,.99))!important;
    border-right:1px solid rgba(191,123,255,.48)!important;
    box-shadow:10px 0 35px rgba(0,0,0,.28)!important
  }
  .brand{padding:10px 8px 22px!important;text-align:center!important}
  .brand .mascot{
    width:112px!important;height:112px!important;margin:0 auto 13px!important;
    display:block!important;border-radius:50%!important;overflow:hidden!important;
    border:2px solid #d9a1ff!important;background:#24133f!important;
    box-shadow:0 0 0 5px rgba(176,102,255,.13),0 0 30px rgba(178,92,255,.58)!important;
    font-size:0!important
  }
  .brand .mascot img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important;object-position:50% 17%!important}
  .brand h1{font-size:24px!important;color:#f7dcff!important}
  .brand p{color:#c5aee9!important;letter-spacing:1px!important}
  .sidebar .nav{border-radius:14px!important;padding:13px 14px!important}
  .sidebar .nav.selected{background:linear-gradient(105deg,#7b32dc,#ad45e9)!important;box-shadow:0 8px 23px #9d43ed55!important}
  .side-foot{color:#bba3df!important}
  main{padding-top:28px!important}
  .topbar{margin-bottom:22px!important}
  .hero{
    min-height:220px!important;position:relative!important;isolation:isolate!important;
    background:linear-gradient(90deg,rgba(28,13,57,.98),rgba(48,19,83,.84) 62%,rgba(42,18,69,.4))!important;
    border:1px solid #b66dff!important;box-shadow:0 12px 38px #7132a933!important
  }
  .hero-art{opacity:.94!important;width:46%!important;background-position:50% 20%!important}
  .hero h2{color:#fff!important;text-shadow:0 0 22px #d18aff88!important}
  .stat,.panel{border-color:#8054b5!important;background:linear-gradient(145deg,rgba(30,22,59,.97),rgba(15,13,39,.98))!important}
  .stat{min-height:92px!important}
  .panel{padding:20px!important}
  .section-title{font-size:26px!important;margin:8px 0 20px!important}
  #page-settings .panel{
    max-width:1120px!important;margin:0 auto!important;padding:24px!important;
    border-radius:20px!important;box-shadow:0 16px 42px #0004,0 0 28px #9b55e522!important
  }
  #page-settings .panel h3{font-size:18px!important;margin-bottom:20px!important}
  #page-settings .form-grid{gap:16px!important}
  #page-settings label{font-size:12px!important;color:#d9c8f1!important;margin:12px 0 8px!important}
  #page-settings input{height:46px!important;font-size:13px!important}
  #page-settings .advanced{margin-top:15px!important;background:#100d2a!important}
  #page-settings button.submit{height:48px!important;font-size:13px!important}
  #page-settings .panel:after{content:"YUNO BABYBU  •  MINECRAFT BOT";display:block;margin-top:17px;padding-top:14px;
    border-top:1px solid #ffffff14;color:#9883bd;font-size:10px;letter-spacing:1.3px;text-align:center}
  .action,button.submit{font-weight:700!important}
  .feature{min-height:72px!important}
  @media(max-width:760px){
    .brand{padding:4px!important}.brand .mascot{width:66px!important;height:66px!important;margin-bottom:7px!important}
    .brand p{display:block!important;font-size:9px!important}
    main{padding:15px!important}
    #page-settings .panel{padding:17px!important}
    #page-settings .form-grid{grid-template-columns:1fr!important}
    .hero{min-height:180px!important}
    .hero-art{width:60%!important;opacity:.45!important}
  }

  .location-panel{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:0 0 16px!important;padding:16px 20px!important;min-height:100px;border-radius:17px!important}
  .location-copy{min-width:190px}.location-copy h3{margin:0 0 6px!important;font-size:15px!important;color:#f4eaff}.location-copy p{margin:0;color:#b9add8;font-size:11px}
  .coordinate-values{display:grid;grid-template-columns:repeat(3,minmax(88px,1fr));gap:10px;width:min(56%,560px)}
  .coordinate-value{padding:10px 14px;border:1px solid #7655a5;border-radius:12px;background:linear-gradient(145deg,#17122f,#0c1024);min-width:0}
  .coordinate-value small{display:block;color:#a99acb;font-size:10px;font-weight:700;letter-spacing:1px;margin-bottom:5px}
  .coordinate-value strong{display:block;color:#ead5ff;font-size:19px;line-height:1.2;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  @media(max-width:760px){.location-panel{align-items:stretch;flex-direction:column;gap:12px}.location-copy{min-width:0}.coordinate-values{width:100%}}
  @media(max-width:420px){.coordinate-values{gap:6px}.coordinate-value{padding:9px 8px}.coordinate-value strong{font-size:15px}}
  </style></head><body><div class="layout"><aside class="sidebar"><div class="brand"><div class="mascot"><img src="data:image/jpeg;base64,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" alt="Yuno mascot"></div><h1>Yuno Babybu</h1><p>MINECRAFT BOT DASHBOARD</p></div>
  <button class="nav selected" data-page="home"><span>⌂</span>Trang Chủ</button><button class="nav" data-page="control"><span>🎮</span>Điều Khiển Bot</button><button class="nav" data-page="settings"><span>⚙</span>Cài Đặt</button><button class="nav" data-page="logs"><span>▤</span>Nhật Ký</button><div class="side-foot">Powered by Yuno Babybu ♡<br>Bot Minecraft Thế Hệ Mới</div></aside>
  <main><div class="topbar"><div class="pill"><span class="online-dot" id="top-status">● ${online?'Bot: Đang Online':'Bot: Đang Offline'}</span></div><div><span class="pill">🕒 Giờ Việt Nam</span></div></div>
  <section class="page" id="page-home"><div class="hero"><div class="hero-copy"><h2>Chào mừng trở lại! 👋</h2><p>Yuno Babybu – Minecraft Bot Dashboard</p><p class="statusline">“Bot luôn bên bạn, chinh phục mọi thế giới!” ♡</p></div><div class="hero-art" aria-hidden="true"></div></div>
  <div class="grid"><div class="stat"><div class="ico">🟩</div><div><small>Trạng Thái Bot</small><strong id="s-status">${online?'Đang Online':'Đang Offline'}</strong><small id="s-uptime">Hoạt động: ${uptimeMinutes} phút</small></div></div><div class="stat"><div class="ico">📶</div><div><small>Máy Chủ</small><strong id="s-server">${escapeHtml(BOT_HOST)}:${BOT_PORT}</strong><small>Ping: <b id="s-ping">${escapeHtml(currentPing)}ms</b></small></div></div><div class="stat"><div class="ico">👤</div><div><small>Nhân Vật</small><strong id="s-user">${escapeHtml(BOT_USERNAME)}</strong><small>Tài khoản Minecraft</small></div></div><div class="stat"><div class="ico">⚡</div><div><small>RAM</small><strong id="s-ram">${memoryUsage} MB</strong><small id="s-held">${escapeHtml(getHeldItemName())}</small></div></div></div>
  <div class="location-panel panel"><div class="location-copy"><h3>📍 Vị Trí Trong Game</h3><p id="coords-state">Bot sẽ hiển thị tọa độ khi đã vào game</p></div><div class="coordinate-values"><div class="coordinate-value"><small>TRỤC X</small><strong id="coord-x">—</strong></div><div class="coordinate-value"><small>TRỤC Y</small><strong id="coord-y">—</strong></div><div class="coordinate-value"><small>TRỤC Z</small><strong id="coord-z">—</strong></div></div></div>
  <div class="columns"><div><div class="panel"><h3>📢 Thông Báo Hệ Thống</h3><p class="muted" id="home-message">${online?'Bot đang hoạt động bình thường!':'Bot đang chờ kết nối tới máy chủ.'}</p></div><div class="panel"><h3>📈 Lịch Sử Ping</h3><div class="logs" id="ping-log">Đang thu thập dữ liệu...</div></div></div><div class="panel"><h3>🚀 Điều Khiển Nhanh</h3><div class="actions"><button class="action green" id="start-bot">▶ Bật Bot</button><button class="action red" id="stop-bot">■ Tắt Bot</button><button class="action" id="restart-bot">⟳ Kết Nối Lại</button><button class="action gold" id="clear-errors">✦ Xóa Nhật Ký Lỗi</button><button class="action red" id="quick-tusat">☠ Tự Sát (/tusat)</button><button class="action" id="quick-inventory">🎒 Túi Đồ [inv]</button><button class="action" id="clear-mentions">🏷 Xóa Log Mention</button></div></div></div></section>
   <section class="page hidden" id="page-control">
     <h2 class="section-title">🎮 Điều Khiển Bot</h2>
     <div class="panel">
       <h3>⌨️ Lệnh Chat / Command</h3>
       <form id="command-form"><div class="form-grid"><input name="command" placeholder="Nhập lệnh hoặc tin nhắn..." required><button class="submit">Gửi Lệnh</button></div></form>
     </div>
     <div class="panel">
       <h3>🤖 Tự Động &amp; Hoạt Động</h3>
       <div class="feature-grid">${toggleButton('afkmode','AFK Mode')}${toggleButton('thien','Thiền')}${toggleButton('quylay','Quỳ Lạy')}${toggleButton('dinhthan','Định Thân')}${toggleButton('quanghao','Quang Hào')}${toggleButton('ngoi','Ngồi / Rón Rén')}${toggleButton('attackLeft','Đánh Trái')}${toggleButton('attackRight','Đánh Phải')}</div>
     </div>
     <div class="panel">
       <h3>✨ Công Pháp &amp; Kỹ Năng</h3>
       <div class="feature-grid">
         ${toggleButton('fightingSkill1','Công Pháp 1')}
         ${toggleButton('fightingSkill2','Công Pháp 2')}
         ${toggleButton('fightingSkill3','Công Pháp 3')}
         ${toggleButton('skill1','Kỹ Năng 1')}
         ${toggleButton('skill2','Kỹ Năng 2')}
         ${toggleButton('skill3','Kỹ Năng 3')}
       </div>
     </div>
     <div class="panel">
       <h3>🎛 Thanh Công Cụ (Ô 1 – 9)</h3>
       <form action="/api/update-hotbar" method="POST">
         <label>Thời gian giữ mỗi ô (giây)</label>
         <input type="number" min="1" name="duration" value="${hotbarHoldDurationSec}">
         <label>Chọn các ô cần luân chuyển</label>
         <div class="slot-grid">${[1,2,3,4,5,6,7,8,9].map((n,i)=>`<label class="slot">Ô ${n}<br><input type="checkbox" name="slot_${i}" ${hotbarEnabled[i]?'checked':''}></label>`).join('')}</div>
         <button class="submit" style="width:100%;margin-top:14px">Lưu Thiết Lập Ô Cầm</button>
       </form>
     </div>
     <div class="panel">
       <h3>⚔️ Tốc Độ Đánh</h3>
       <form action="/api/update-click-speed" method="POST" class="form-grid">
         <div><label>Tốc độ trái (giây)</label><input type="number" min="0.1" step="0.1" name="leftSpeed" value="${(attackLeftIntervalMs/1000).toFixed(1)}"></div>
         <div><label>Tốc độ phải (giây)</label><input type="number" min="0.1" step="0.1" name="rightSpeed" value="${(attackRightIntervalMs/1000).toFixed(1)}"></div>
         <button class="submit" style="grid-column:1/-1">Lưu Tốc Độ</button>
       </form>
     </div>
   </section>
  <!-- CẤU HÌNH ĐĂNG NHẬP & SERVER -->
  <section class="page hidden" id="page-settings">
    <h2 class="section-title">⚙️ Cấu Hình Đăng Nhập & Server</h2>
    <form action="/api/update-config" method="POST" class="panel" autocomplete="on">
      <h3>🔐 Thông Tin Tài Khoản Minecraft</h3>
      <div class="form-grid">
        <div>
          <label for="server-username">Tên nhân vật</label>
          <input id="server-username" name="username" type="text" value="${escapeHtml(BOT_USERNAME)}" placeholder="Nhập tên nhân vật" autocomplete="username" required>
        </div>
        <div>
          <label for="server-password">Mật khẩu Minecraft</label>
          <input id="server-password" name="password" type="password" value="" placeholder="Nhập mật khẩu nếu cần đổi" autocomplete="new-password">
          <small style="display:block;opacity:.7;margin-top:6px">Để trống nếu muốn giữ mật khẩu đã lưu.</small>
        </div>
      </div>
      <h3 style="margin-top:22px">🌐 Máy Chủ Minecraft</h3>
      <label for="server-host">Địa chỉ IP Server</label>
      <input id="server-host" name="host" type="text" value="${escapeHtml(BOT_HOST)}${BOT_PORT!==25565?':'+BOT_PORT:''}" placeholder="vd: play.example.net hoặc play.example.net:25565" required>
      <details class="advanced" style="margin-top:16px">
        <summary>⚙️ Cấu hình nâng cao · SOCKS5 Proxy</summary>
        <label for="server-proxy">Địa chỉ SOCKS5 Proxy</label>
        <input id="server-proxy" name="proxy" type="text" value="${escapeHtml(BOT_PROXY)}" placeholder="ip:port hoặc user:pass@ip:port">
        <small style="display:block;opacity:.7;margin-top:6px">Để trống nếu kết nối trực tiếp, không dùng proxy.</small>
      </details>
      <button class="submit" type="submit" style="width:100%;margin-top:20px">✦ Lưu Cấu Hình & Kết Nối Lại</button>
      <p style="opacity:.72;font-size:12px;margin:12px 0 0">Bot chỉ cập nhật cấu hình và bắt đầu kết nối sau khi bạn nhấn nút lưu.</p>
    </form>
  </section>
  <section class="page hidden" id="page-logs"><h2 class="section-title">▤ Nhật Ký Hoạt Động</h2><div class="panel"><h3>💬 Chat Server Realtime</h3><div class="logs" id="chat-log">${serverChatLogs.length?serverChatLogs.map(x=>escapeHtml(x)).join('\n'):'Chưa có nhật ký...'}</div></div><div class="panel"><h3>⚠ Nhật Ký Lỗi Phát Sinh</h3><div class="logs" id="error-log">${errorLogs.length?errorLogs.map(e=>`[${escapeHtml(e.time)}] [${escapeHtml(e.type)}] ${escapeHtml(e.details)}`).join('\n'):'Không có lỗi!'}</div></div><div class="panel"><h3>🏷 Nhật Ký Mention</h3><div class="logs" id="mention-log">${botMentionLogs.length?botMentionLogs.map(e=>`[${escapeHtml(e.time)}] ${escapeHtml(e.text)}`).join('\n'):'Chưa có mention...'}</div></div></section>
  <div class="toast" id="toast"></div></main></div>
  <script>
  const toast=(m)=>{const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2600)};
  document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.nav').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden'));document.getElementById('page-'+b.dataset.page).classList.remove('hidden')}));
  async function call(url,method='GET',body){try{const r=await fetch(url,{method,headers:body?{'Content-Type':'application/x-www-form-urlencoded'}:{},body});if(!r.ok)throw Error('HTTP '+r.status);toast('Đã gửi thao tác');await refresh()}catch(e){toast('Lỗi: '+e.message)}}
  document.querySelectorAll('[data-toggle]').forEach(b=>b.addEventListener('click',()=>call('/api/toggle/'+b.dataset.toggle)));
  document.getElementById('start-bot').onclick=()=>call('/api/toggle-bot?state=start');document.getElementById('stop-bot').onclick=()=>call('/api/toggle-bot?state=stop');document.getElementById('restart-bot').onclick=()=>{if(confirm('Kết nối lại bot?'))call('/api/reconnect')};document.getElementById('clear-errors').onclick=()=>call('/api/clear-error-log');document.getElementById('quick-tusat').onclick=()=>call('/api/tusat');document.getElementById('quick-inventory').onclick=()=>call('/api/inventory','POST');document.getElementById('clear-mentions').onclick=()=>call('/api/clear-mention-log');
  document.getElementById('command-form').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);await call('/api/command','POST',new URLSearchParams(fd));e.target.reset()};
  async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)return;const d=await r.json();document.getElementById('top-status').textContent=d.online?'● Bot: Đang Online':(d.manualStopped?'● Bot: Đã Tắt':'● Bot: Đang Kết Nối');document.getElementById('s-status').textContent=d.online?'Đang Online':(d.manualStopped?'Đã Tắt':'Đang Kết Nối');document.getElementById('s-uptime').textContent='Hoạt động: '+d.uptimeMinutes+' phút';document.getElementById('s-server').textContent=d.host+':'+d.port;document.getElementById('s-ping').textContent=d.ping+'ms';document.getElementById('s-user').textContent=d.username;const p=d.position;document.getElementById('coord-x').textContent=p?Number(p.x).toFixed(1):'—';document.getElementById('coord-y').textContent=p?Number(p.y).toFixed(1):'—';document.getElementById('coord-z').textContent=p?Number(p.z).toFixed(1):'—';document.getElementById('coords-state').textContent=d.online&&p?'Tọa độ nhân vật trong thế giới Minecraft':'Bot chưa vào game — bật Bot để xem tọa độ';document.getElementById('s-ram').textContent=d.ramMb+' MB';document.getElementById('s-held').textContent=d.heldItem;document.getElementById('chat-log').textContent=d.chat.join('\\n')||'Chưa có nhật ký...';document.getElementById('error-log').textContent=d.errors.map(x=>'['+x.time+'] ['+x.type+'] '+x.details).join('\\n')||'Không có lỗi!';document.getElementById('mention-log').textContent=(d.mentions||[]).map(x=>'['+x.time+'] '+x.text).join('\\n')||'Chưa có mention...';document.getElementById('ping-log').textContent=(d.pingLogs||[]).map(x=>'['+x.time+'] '+x.ping+' ms').join('\\n')||'Đang thu thập dữ liệu...';document.querySelectorAll('[data-toggle]').forEach(b=>{const on=!!d.toggles[b.dataset.toggle];b.classList.toggle('active',on);b.querySelector('b').textContent=on?'ĐANG BẬT':'ĐANG TẮT'})}catch(e){}}
  refresh();setInterval(refresh,3000);
  </script></body></html>`);
});

app.listen(port, () => console.log(`[HTTP SERVER] Running on port ${port}`));

function stopFeatureLoops() {
  if (quylayInterval) { clearInterval(quylayInterval); quylayInterval = null; }
  if (ngoiInterval) { clearInterval(ngoiInterval); ngoiInterval = null; }
  if (thienInterval) { clearInterval(thienInterval); thienInterval = null; }
  if (attackLeftInterval) { clearInterval(attackLeftInterval); attackLeftInterval = null; }
  if (attackRightInterval) { clearInterval(attackRightInterval); attackRightInterval = null; }
  if (skillLoopInterval) { clearInterval(skillLoopInterval); skillLoopInterval = null; }
  if (fightingSkill1Interval) { clearInterval(fightingSkill1Interval); fightingSkill1Interval = null; }
  if (fightingSkill2Interval) { clearInterval(fightingSkill2Interval); fightingSkill2Interval = null; }
  if (fightingSkill3Interval) { clearInterval(fightingSkill3Interval); fightingSkill3Interval = null; }
  if (hotbarLoopInterval) { clearInterval(hotbarLoopInterval); hotbarLoopInterval = null; }
}

function restartLoops() {
  stopFeatureLoops();
  if (!bot || !bot.entity || !bot._client || bot._client.state !== 'play' || isManualStopped) return;

  if (toggles.quylay) {
    quylayInterval = setInterval(() => { if (toggles.quylay) safeChat('/quylay'); }, 15000);
  }
  // Duy trì Thiền: gửi lại lệnh mỗi 3 phút khi người dùng đã bật.
  if (toggles.thien) {
    thienInterval = setInterval(() => {
      if (toggles.thien && bot && bot.entity && bot._client &&
          bot._client.state === 'play' && !isManualStopped) {
        safeChat('/thien');
      }
    }, 180000);
  }
  if (toggles.ngoi) {
    ngoiInterval = setInterval(() => {
      if (bot && bot.entity && bot._client && bot._client.state === 'play' && !isManualStopped) {
        try {
          bot.setControlState('sneak', true);
          managedTimeout(() => { if (bot && bot.entity) bot.setControlState('sneak', false); }, 1200);
        } catch (e) {}
      }
    }, 5000);
  }
  if (toggles.attackLeft) {
    attackLeftInterval = setInterval(() => {
      if (bot && bot.entity && bot._client && bot._client.state === 'play' && !isManualStopped) {
        try {
          const target = bot.nearestEntity(entity =>
            entity && entity !== bot.entity &&
            (entity.type === 'mob' || entity.type === 'player') &&
            entity.position && bot.entity.position.distanceTo(entity.position) <= 4
          );
          if (target) bot.attack(target);
          else bot.swingArm('right');
        } catch (e) {}
      }
    }, attackLeftIntervalMs);
  }
  if (toggles.attackRight) {
    attackRightInterval = setInterval(() => {
      if (bot && bot.entity && bot._client && bot._client.state === 'play' && !isManualStopped) {
        try { bot.activateItem(); } catch (e) {}
      }
    }, attackRightIntervalMs);
  }
  if (toggles.skill1 || toggles.skill2 || toggles.skill3) {
    skillLoopInterval = setInterval(() => {
      if (bot && bot.entity && bot._client && !isManualStopped) {
        if (toggles.skill1) safeChat('/kinang_1');
        if (toggles.skill2) safeChat('/kinang_2');
        if (toggles.skill3) safeChat('/kinang_3');
      }
    }, 10000);
  }

  // Công pháp có chu kỳ riêng, không phụ thuộc vòng lặp kỹ năng thường.
  if (toggles.fightingSkill1) {
    fightingSkill1Interval = setInterval(() => {
      if (toggles.fightingSkill1) safeChat('/fightingskill_1');
    }, 5000);
  }
  if (toggles.fightingSkill2) {
    fightingSkill2Interval = setInterval(() => {
      if (toggles.fightingSkill2) safeChat('/fightingskill_2');
    }, 15000);
  }
  if (toggles.fightingSkill3) {
    fightingSkill3Interval = setInterval(() => {
      if (toggles.fightingSkill3) safeChat('/fightingskill_3');
    }, 40000);
  }

  const activeSlots = hotbarEnabled.map((enabled, idx) => enabled ? idx : -1).filter(idx => idx !== -1);
  currentHotbarCycleIndex = 0;
  if (activeSlots.length >= 1) {
    try { bot.setQuickBarSlot(activeSlots[0]); } catch (e) {}
    hotbarLoopInterval = setInterval(() => {
      if (bot && bot.entity && bot._client && bot._client.state === 'play' && !isManualStopped) {
        currentHotbarCycleIndex = (currentHotbarCycleIndex + 1) % activeSlots.length;
        try { bot.setQuickBarSlot(activeSlots[currentHotbarCycleIndex]); } catch (e) {}
      }
    }, hotbarHoldDurationSec * 1000);
  }
}

function cleanupBot() {
  isAutoActionRunning = false;
  currentCoords = 'Đang xác định...';
  currentPosition = null;
  currentPing = 0;

  stopFeatureLoops(); 

  if (actionTimeout) { clearTimeout(actionTimeout); actionTimeout = null; }
  if (antiAfkTimeout) { clearTimeout(antiAfkTimeout); antiAfkTimeout = null; }

  [ramGcInterval, posCheckInterval, watchdogInterval, pingInterval].forEach(i => i && clearInterval(i));
  ramGcInterval = posCheckInterval = watchdogInterval = pingInterval = null;
  [reconnectTimeout, loginTimer1, loginTimer2, respawnTimer, commandResponseTimer].forEach(t => t && clearTimeout(t));
  for (const timer of managedTimeouts) clearTimeout(timer);
  managedTimeouts.clear();
  reconnectTimeout = loginTimer1 = loginTimer2 = respawnTimer = commandResponseTimer = null;
  isAwaitingResponse = false;

  if (bot) {
    const oldBot = bot;
    bot = null;
    try {
      oldBot.removeAllListeners();
      // Keep a no-op error listener so late socket errors cannot become
      // unhandled EventEmitter errors while the old connection is closing.
      oldBot.on('error', () => {});
      if (oldBot._client) {
        oldBot._client.removeAllListeners();
        oldBot._client.on('error', () => {});
      }
      try { oldBot.clearControlStates(); } catch (e) {}
      try { oldBot.end(); } catch (e) {}
    } catch (e) {}
  }

  if (global.gc) {
    try { global.gc(); } catch (e) {}
  }
}

function scheduleNextAction() {
  if (actionTimeout) { clearTimeout(actionTimeout); actionTimeout = null; }
  if (isManualStopped || !bot || !bot.entity || !bot._client) {
    isAutoActionRunning = false;
    return;
  }
  isAutoActionRunning = true;
  lastActionTime = Date.now();
  const currentBot = bot;

  try {
    // Chống AFK không được tự bật sneak; sneak chỉ do nút Ngồi / Rón Rén điều khiển.
    const actionType = Math.floor(Math.random() * 2);
    if (actionType === 0) currentBot.swingArm('right');
    else currentBot.activateItem();
  } catch (err) {}

  actionTimeout = managedTimeout(scheduleNextAction, Math.floor(5000 + Math.random() * 5000));
}

function scheduleRandomRotation() {
  if (antiAfkTimeout) clearTimeout(antiAfkTimeout);
  if (isManualStopped) return;

  antiAfkTimeout = managedTimeout(() => {
    if (bot && bot.entity && bot.health > 0 && bot._client && bot._client.state === 'play') {
      try {
        bot.look(bot.entity.yaw + (Math.random() - 0.5) * 0.3, bot.entity.pitch + (Math.random() - 0.5) * 0.1, true);
      } catch (e) {}
    }
    scheduleRandomRotation();
  }, Math.floor(15000 + Math.random() * 20000));
}

function executeActiveFeaturesOnSpawn() {
  if (!bot || !bot.entity || !bot._client || isManualStopped) return;
  let delay = 1000;
  
  if (toggles.afkmode) { managedTimeout(() => safeChat('/afkmode vao'), delay); delay += 1200; }
  if (toggles.thien) { managedTimeout(() => safeChat('/thien'), delay); delay += 1200; }
  if (toggles.quylay) { managedTimeout(() => safeChat('/quylay'), delay); delay += 1200; }
  if (toggles.dinhthan) { managedTimeout(() => safeChat('/dinhthan'), delay); delay += 1200; }
  if (toggles.quanghao) { managedTimeout(() => safeChat('/quanghao'), delay); delay += 1200; }

  managedTimeout(() => { restartLoops(); }, delay + 500);
}

function createBot() {
  if (!connectionAuthorized || isManualStopped) return;
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  isReconnecting = false;
  cleanupBot();
  isFirstSpawn = true;
  lastTimeAge = 0;
  lastTimeAgeUpdate = Date.now();

  const currentOptions = {
    host: BOT_HOST,
    port: BOT_PORT,
    username: BOT_USERNAME,
    version: '1.21.4',
    hideErrors: false,
    // Tăng ngưỡng timeout để chịu được các đợt lag dài.
    checkTimeoutInterval: 300 * 1000, 
    keepAlive: true,
    physicsEnabled: true,
    viewDistance: 'tiny'
  };

  // NẾU CÓ CẤU HÌNH PROXY SOCKS5 -> SỬ DỤNG PROXY ĐỂ TRÁNH LỖI TRÙNG IP TRÊN RENDER
  if (BOT_PROXY && BOT_PROXY.trim() !== '') {
    currentOptions.connect = (client) => {
      let proxyHost = BOT_PROXY;
      let proxyPort = 1080;
      let proxyUser = undefined;
      let proxyPass = undefined;

      try {
        if (BOT_PROXY.includes('@')) {
          const parts = BOT_PROXY.split('@');
          const auth = parts[0].split(':');
          proxyUser = auth[0];
          proxyPass = auth[1];
          const serverParts = parts[1].split(':');
          proxyHost = serverParts[0];
          proxyPort = parseInt(serverParts[1]) || 1080;
        } else if (BOT_PROXY.includes(':')) {
          const parts = BOT_PROXY.split(':');
          proxyHost = parts[0];
          proxyPort = parseInt(parts[1]) || 1080;
        }

        SocksClient.createConnection({
          proxy: {
            host: proxyHost,
            port: proxyPort,
            type: 5,
            userId: proxyUser,
            password: proxyPass
          },
          command: 'connect',
          destination: {
            host: BOT_HOST,
            port: BOT_PORT
          }
        }, (err, info) => {
          if (err) {
            addErrorLog('Proxy Error', err.message);
            client.emit('error', err);
            return;
          }
          client.setSocket(info.socket);
          client.emit('connect');
        });
      } catch (proxyErr) {
        addErrorLog('Proxy Parse Error', proxyErr.message);
        client.emit('error', proxyErr);
      }
    };
  }

  console.log(`
[HỆ THỐNG] Kết nối đến ${escapeHtml(BOT_HOST)}:${escapeHtml(BOT_PORT)} (Proxy: ${BOT_PROXY || 'Không'}) với tên [${escapeHtml(BOT_USERNAME)}]...`);

  try {
    bot = mineflayer.createBot(currentOptions);
    bot.setMaxListeners(0);

    if (bot._client) {
      bot._client.setMaxListeners(0);
      bot._client.on('error', (err) => {
        addErrorLog('Socket Error', err.message || err.code || 'Lỗi TCP Socket');
      });
    }
  } catch (err) {
    addErrorLog('Init Failed', err.message);
    handleReconnect();
    return;
  }

  bot.on('spawn', () => {
    console.log('[LOG] Bot đã vào game!');
    addChatLog('Kết nối ổn định thành công!');
    triggerChatWindow(12000);
    consecutiveFailures = 0;
    currentReconnectDelay = 10000;
    updateCurrentPosition();

    if (isFirstSpawn) {
      isFirstSpawn = false;

      loginTimer1 = managedTimeout(() => {
        if (bot && bot._client && !isManualStopped) {
          bot.chat(`/l ${BOT_PASSWORD}`);
          triggerChatWindow(4000);
        }
      }, 3500);

      loginTimer2 = managedTimeout(() => {
        if (bot && bot.entity && bot._client && !isManualStopped) {
          executeActiveFeaturesOnSpawn();
          scheduleNextAction();
          scheduleRandomRotation();
        }
      }, 7000);

      // Mineflayer owns bot.entities. Do not delete live entities manually:
      // doing so breaks player/mob tracking and can destabilize combat/pathfinding.
      ramGcInterval = setInterval(() => {
        if (global.gc) { try { global.gc(); } catch (e) {} }
      }, 30000);

      pingInterval = setInterval(() => {
        if (bot && bot.player) {
          currentPing = bot.player.ping || 0;
          addPingLog(currentPing);
        }
      }, 10000);

      updateCurrentPosition();
      posCheckInterval = setInterval(updateCurrentPosition, 1000);

      watchdogInterval = setInterval(() => {
        if (!bot || isManualStopped) return;
        if (!isAutoActionRunning || Date.now() - lastActionTime > 20000) scheduleNextAction();

        if (bot.time) {
          if (bot.time.age === lastTimeAge) {
            if (Date.now() - lastTimeAgeUpdate > 45000) {
              addErrorLog('Watchdog', 'Kẹt Packet thế giới > 45s. Tiến hành Reconnect...');
              handleReconnect();
            }
          } else {
            lastTimeAge = bot.time.age;
            lastTimeAgeUpdate = Date.now();
          }
        }
      }, 15000);
    }
  });

  bot.on('death', () => {
    addChatLog('Bot tử vong! Chờ hồi sinh...');
    addErrorLog('Event Chết', 'Bot tử vong');

    respawnTimer = managedTimeout(() => {
      if (bot && bot._client && !isManualStopped) {
        try { bot.respawn(); } catch (e) {}
      }
      managedTimeout(() => {
        if (bot && bot.entity && bot._client && !isManualStopped) {
          executeActiveFeaturesOnSpawn();
          scheduleNextAction();
          scheduleRandomRotation();
        }
      }, 4500);
    }, 4000);
  });

  bot.on('message', (message) => {
    try {
      const text = message.toString().trim();
      if (!text) return;
      const lowerText = text.toLowerCase();

      if (lowerText.includes(BOT_USERNAME.toLowerCase())) {
        addBotMentionLog(text);
      }

      if (text.includes('█') || lowerText.includes('hồi chiêu') || lowerText.includes('cooldown')) return;

      addChatLog(text);

      // Mineflayer không đọc trực tiếp biến trạng thái nội bộ của plugin server.
      // Vì vậy chỉ bật lại khi server gửi thông báo rõ ràng rằng Thiền đã kết thúc/bị hủy,
      // tránh gửi /thien theo chu kỳ (lệnh dạng toggle có thể vô tình tắt Thiền).
      const thienStoppedPatterns = [
        /thoát.{0,24}thiền/, /kết thúc.{0,24}thiền/, /hủy.{0,24}thiền/,
        /huỷ.{0,24}thiền/, /ngừng.{0,24}thiền/, /dừng.{0,24}thiền/,
        /thiền.{0,24}(đã bị hủy|đã bị huỷ|đã kết thúc|bị gián đoạn|không còn)/,
        /(không còn|không ở|đã rời).{0,24}trạng thái.{0,16}thiền/,
        /(meditation|meditating).{0,24}(ended|stopped|cancelled|canceled|interrupted)/i
      ];
      if (toggles.thien && thienStoppedPatterns.some(pattern => pattern.test(lowerText))) {
        const now = Date.now();
        if (now - lastThienReapplyAt >= 20000 && !thienReapplyTimer) {
          lastThienReapplyAt = now;
          addErrorLog('Tự Khôi Phục Thiền', 'Server thông báo trạng thái Thiền đã kết thúc. Bot sẽ bật lại /thien.');
          thienReapplyTimer = managedTimeout(() => {
            thienReapplyTimer = null;
            if (toggles.thien && bot && bot.entity && bot._client && bot._client.state === 'play' && !isManualStopped) {
              safeChat('/thien');
            }
          }, 1500);
        }
      }
    } catch (e) {}
  });

  bot.on('end', (reason) => {
    stopFeatureLoops();
    addErrorLog('Mất Kết Nối (End)', `Server ngắt socket: ${reason}`);
    handleReconnect();
  });

  bot.on('error', (err) => {
    stopFeatureLoops();
    addErrorLog('Mineflayer Error', err.message || err.toString());
  });

  bot.on('kicked', (reason) => {
    stopFeatureLoops();
    const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
    addErrorLog('Bị Server Kick', reasonStr);

    // Mọi loại kick đều thử kết nối lại. Nếu bị kick lặp lại, thời gian chờ tăng dần.
    if (/bị kick bởi|kick bởi|kicked by/i.test(reasonStr)) {
      currentReconnectDelay = Math.max(currentReconnectDelay, 20000);
      addErrorLog('TỰ KẾT NỐI LẠI', 'Bot bị kick trực tiếp; sẽ tự thử vào lại server.');
    }

    if (reasonStr.includes('IP') || reasonStr.includes('đã có người') || reasonStr.includes('LƯU DỮ LIỆU')) {
      currentReconnectDelay = Math.max(currentReconnectDelay, 25000);
    }
    handleReconnect();
  });
}

function handleReconnect() {
  if (!connectionAuthorized || isManualStopped || isReconnecting) return;
  isReconnecting = true;
  cleanupBot();

  consecutiveFailures++;

  if (consecutiveFailures >= 12) {
    // Không tự tắt tiến trình web khi Minecraft mất kết nối.
    // Giữ Express hoạt động để Dashboard không bị 502 và tiếp tục thử kết nối.
    addErrorLog('CẢNH BÁO NẶNG', `Mất kết nối liên tục ${consecutiveFailures} lần. Tiếp tục thử lại sau ${Math.round(currentReconnectDelay / 1000)} giây...`);
  }

  const jitter = Math.floor(Math.random() * 3000);
  const waitTime = currentReconnectDelay + jitter;

  console.log(`Chờ ${Math.round(waitTime / 1000)}s để tái kết nối...`);
  
  reconnectTimeout = managedTimeout(() => {
    isReconnecting = false;
    currentReconnectDelay = Math.min(currentReconnectDelay * 1.25, 30000);
    createBot();
  }, waitTime);
}

process.on('uncaughtException', (err) => {
  addErrorLog('Uncaught Exception', `${err.message} (${err.code || 'NO_CODE'})`);
  try { handleReconnect(); } catch(e) {}
});

process.on('unhandledRejection', (reason) => {
  addErrorLog('Unhandled Rejection', String(reason));
});

// Khởi động website; nếu đã có cấu hình và mật khẩu được lưu thì tự kết nối Minecraft.
// Nếu chưa có mật khẩu/cấu hình, chỉ mở Dashboard và chờ người dùng lưu cấu hình.
if (connectionAuthorized && !isManualStopped) {
  addErrorLog('TỰ KẾT NỐI', 'Đã khôi phục cấu hình. Đang tự kết nối Minecraft...');
  createBot();
} else {
  addErrorLog('CHƯA CÓ CẤU HÌNH', 'Website đã sẵn sàng. Nhập cấu hình và nhấn Lưu Cấu Hình & Tải Kết Nối Ngay.');
}



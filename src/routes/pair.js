'use strict';
const express = require('express');
const QRCode = require('qrcode');
const baileys = require('../services/baileys');
const config = require('../config');

const router = express.Router();

// Все маршруты под /pair требуют валидный token в query. Если PAIR_TOKEN не
// задан в env — страница полностью отключена (503), чтобы случайно поднятый
// туннель не дал привязать чужой WhatsApp к боту.
router.use((req, res, next) => {
  if (!config.PAIR_TOKEN) {
    return res.status(503).type('text/plain').send('Pair endpoint disabled: set PAIR_TOKEN in env.');
  }
  const token = req.query.token;
  if (!token || token !== config.PAIR_TOKEN) {
    return res.status(403).type('text/plain').send('Forbidden: invalid or missing token.');
  }
  next();
});

router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
  res.type('html').send(renderHtml(config.PAIR_TOKEN));
});

router.get('/qr.png', async (req, res) => {
  if (baileys.isConnected || !baileys.lastQR) {
    return res.status(204).end();
  }
  try {
    const buf = await QRCode.toBuffer(baileys.lastQR, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    console.error('[Pair] QR render error:', err.message);
    res.status(500).type('text/plain').send('QR render error');
  }
});

router.post('/code', express.json(), async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (phone.length < 10) {
      return res.status(400).json({ error: 'Введите корректный номер телефона (минимум 10 цифр).' });
    }
    const code = await baileys.requestPairing(phone);
    res.json({
      code,
      formatted: formatPairingCode(code),
      phone,
      expiresAt: baileys.pairingExpiresAt,
    });
  } catch (err) {
    console.error('[Pair] requestPairing error:', err.message);
    res.status(400).json({ error: err.message || 'Не удалось получить код' });
  }
});

router.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  res.json({
    connected: !!baileys.isConnected,
    savedPhone: baileys.savedPhone || null,
    hasQR: !!baileys.lastQR && !baileys.isConnected,
    pairingActive: !!baileys.lastPairingCode && baileys.pairingExpiresAt > now,
    pairingCode: baileys.lastPairingCode && baileys.pairingExpiresAt > now
      ? formatPairingCode(baileys.lastPairingCode)
      : null,
    pairingExpiresAt: baileys.pairingExpiresAt || 0,
  });
});

function formatPairingCode(code) {
  const s = String(code || '').replace(/\s+/g, '');
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4)}`;
  return s;
}

function renderHtml(token) {
  // Token идёт в data-атрибут, чтобы JS его подхватил из DOM (не нужно его
  // парсить из URL — он уже здесь, прошёл middleware).
  const safeToken = String(token).replace(/[<>"'&]/g, '');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Подключение WhatsApp</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 48px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0e0f12; color: #e7e9ee;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 460px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  .lead { color: #9aa0aa; font-size: 14px; margin: 0 0 20px; }
  .card {
    background: #16181d; border: 1px solid #242832; border-radius: 14px;
    padding: 18px; margin-bottom: 14px;
  }
  .card.hidden { display: none; }
  .card.connected { border-color: #1f6b3a; background: #102018; }
  .card h2 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
  .card .meta { color: #9aa0aa; font-size: 13px; }
  label { display: block; font-size: 13px; color: #b8bdc7; margin-bottom: 6px; }
  input[type="tel"] {
    width: 100%; padding: 12px 14px; font: inherit; color: #e7e9ee;
    background: #0e0f12; border: 1px solid #2a2f3a; border-radius: 10px;
    outline: none; transition: border-color .15s;
  }
  input[type="tel"]:focus { border-color: #4f6bff; }
  button {
    width: 100%; margin-top: 12px; padding: 12px 14px; font: inherit; font-weight: 600;
    color: #fff; background: #4f6bff; border: 0; border-radius: 10px; cursor: pointer;
    transition: background .15s;
  }
  button:hover:not(:disabled) { background: #6079ff; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .code {
    margin-top: 16px; padding: 18px; text-align: center;
    font: 700 30px/1.1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 4px;
    background: #0e0f12; border: 1px solid #2a2f3a; border-radius: 12px;
    color: #fff;
  }
  .timer { margin-top: 10px; text-align: center; color: #9aa0aa; font-size: 13px; }
  .steps { margin: 14px 0 0; padding-left: 18px; color: #b8bdc7; font-size: 14px; }
  .steps li { margin-bottom: 4px; }
  .qr { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .qr img { width: 260px; height: 260px; background: #fff; border-radius: 10px; padding: 6px; }
  .err { color: #ff7a7a; font-size: 13px; margin-top: 8px; min-height: 18px; }
  .sep { text-align: center; color: #6b7280; font-size: 12px; letter-spacing: .12em; margin: 6px 0 8px; }
</style>
</head>
<body>
<main data-token="${safeToken}">
  <h1>Подключение WhatsApp</h1>
  <p class="lead">Привяжите аккаунт WhatsApp к боту — кодом или QR.</p>

  <section id="connectedCard" class="card connected hidden">
    <h2>✓ Бот подключён</h2>
    <div class="meta" id="connectedPhone">—</div>
  </section>

  <section id="codeCard" class="card">
    <h2>Способ 1: код из 8 цифр</h2>
    <label for="phone">Номер телефона WhatsApp</label>
    <input type="tel" id="phone" inputmode="tel" autocomplete="tel" placeholder="+7 777 123 45 67">
    <button id="requestBtn">Получить код</button>
    <div class="err" id="err"></div>

    <div id="codeWrap" class="hidden">
      <div class="code" id="code">— — — — — — — —</div>
      <div class="timer" id="timer"></div>
      <ol class="steps">
        <li>WhatsApp → меню ⋮ → <b>Связанные устройства</b></li>
        <li><b>Привязать устройство</b> → <b>Привязать с помощью номера телефона</b></li>
        <li>Введите номер и затем код выше</li>
      </ol>
    </div>
  </section>

  <div class="sep">— ИЛИ —</div>

  <section id="qrCard" class="card">
    <h2>Способ 2: QR-код</h2>
    <div class="qr">
      <img id="qrImg" alt="QR" src="">
      <div class="meta">Код обновляется автоматически</div>
    </div>
    <ol class="steps">
      <li>WhatsApp → меню ⋮ → <b>Связанные устройства</b></li>
      <li><b>Привязать устройство</b> → отсканируйте QR выше</li>
    </ol>
  </section>
</main>

<script>
(function () {
  var token = document.querySelector('main').dataset.token;
  var q = function (s) { return document.querySelector(s); };
  var connectedCard = q('#connectedCard');
  var connectedPhone = q('#connectedPhone');
  var codeCard = q('#codeCard');
  var qrCard = q('#qrCard');
  var phoneInput = q('#phone');
  var requestBtn = q('#requestBtn');
  var codeWrap = q('#codeWrap');
  var codeEl = q('#code');
  var timerEl = q('#timer');
  var errEl = q('#err');
  var qrImg = q('#qrImg');
  var separators = document.querySelectorAll('.sep');

  var statusTimer = null;
  var qrTimer = null;
  var countdownTimer = null;
  var pairingExpiresAt = 0;

  function url(path) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }

  function refreshQR() {
    qrImg.src = url('/pair/qr.png') + '&_=' + Date.now();
  }

  function setError(msg) { errEl.textContent = msg || ''; }

  function showConnected(phone) {
    connectedPhone.textContent = phone ? ('Аккаунт +' + phone) : 'Аккаунт активен';
    connectedCard.classList.remove('hidden');
    codeCard.classList.add('hidden');
    qrCard.classList.add('hidden');
    separators.forEach(function (s) { s.style.display = 'none'; });
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function startCountdown(expiresAt, code) {
    pairingExpiresAt = expiresAt;
    codeEl.textContent = code;
    codeWrap.classList.remove('hidden');
    if (countdownTimer) clearInterval(countdownTimer);
    var tick = function () {
      var left = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000));
      timerEl.textContent = left > 0 ? ('Действует ещё ' + left + ' сек') : 'Код истёк — запросите новый';
      if (left <= 0) { clearInterval(countdownTimer); countdownTimer = null; }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  requestBtn.addEventListener('click', function () {
    setError('');
    var phone = (phoneInput.value || '').replace(/\\D/g, '');
    if (phone.length < 10) { setError('Введите корректный номер (минимум 10 цифр).'); return; }
    requestBtn.disabled = true;
    requestBtn.textContent = 'Получаем код…';
    fetch(url('/pair/code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'Ошибка');
        startCountdown(res.body.expiresAt, res.body.formatted || res.body.code);
      })
      .catch(function (e) { setError(e.message); })
      .finally(function () {
        requestBtn.disabled = false;
        requestBtn.textContent = 'Получить новый код';
      });
  });

  function pollStatus() {
    fetch(url('/pair/status'))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.connected) { showConnected(s.savedPhone); return; }
        if (s.pairingActive && s.pairingCode && !countdownTimer) {
          startCountdown(s.pairingExpiresAt, s.pairingCode);
        }
      })
      .catch(function () {});
  }

  refreshQR();
  qrTimer = setInterval(refreshQR, 10_000);
  pollStatus();
  statusTimer = setInterval(pollStatus, 3000);
})();
</script>
</body>
</html>`;
}

module.exports = router;

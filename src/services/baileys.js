'use strict';
const EventEmitter = require('events');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const config = require('../config');

class BaileysService extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isConnected = false;
    // Public state for the /pair web page.
    this.savedPhone = null;          // E.164 digits without '+' once registered
    this.lastQR = null;              // raw QR string from connection.update; consumed by /pair/qr.png
    this.lastPairingCode = null;     // 8-char human code from requestPairingCode
    this.pairingExpiresAt = 0;       // epoch ms; codes are valid ~60s on WA side
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(config.WA_AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Baileys] WhatsApp v${version.join('.')}, актуальная: ${isLatest}`);
    const savedPhone = (state.creds?.me?.id || '').split(':')[0].split('@')[0];
    if (savedPhone) {
      console.log(`[Baileys] Сессия для номера: +${savedPhone}`);
      this.savedPhone = savedPhone;
    }

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      // CRITICAL: Browsers.macOS('Chrome'), не 'Desktop' / 'Safari'.
      // В Baileys 7.x WA-сервер валидирует browser identifier — с другими
      // значениями pairing code генерируется локально, но pending pairing на
      // стороне WA не создаётся, и клиент видит «Не удалось связать устройство».
      browser: Browsers.macOS('Chrome'),
      qrTimeout: 180_000,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg || !msg.message) return;
      if (msg.key.remoteJid === 'status@broadcast') return;
      if (msg.key.fromMe) return;
      if (msg.key.remoteJid.endsWith('@g.us')) {
        console.log(`[Baileys] Группа: ${msg.key.remoteJid} | ${msg.pushName}: ${msg.message?.conversation || ''}`);
      }
      this.emit('message', msg);
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        // Без guard `!state.creds.registered` — иначе после logout-цикла QR
        // не попадёт на /pair-страницу, хотя Baileys его эмитит.
        // Web page consumes raw QR via /pair/qr.png (re-rendered every 10s).
        this.lastQR = qr;
        console.log('[Baileys] Новый QR (также доступен на /pair). Локально:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[Baileys] Соединение закрыто (код: ${statusCode}). Переподключение: ${shouldReconnect}`);
        if (shouldReconnect) {
          setTimeout(() => this.connect(), 3000);
        } else {
          console.log('[Baileys] Выход из аккаунта. Удаляю сессию и перезапускаю...');
          this.savedPhone = null;
          this.lastQR = null;
          this.lastPairingCode = null;
          this.pairingExpiresAt = 0;
          try {
            fs.rmSync(config.WA_AUTH_DIR, { recursive: true, force: true });
          } catch (_) {}
          setTimeout(() => this.connect(), 1000);
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.lastQR = null;
        this.lastPairingCode = null;
        this.pairingExpiresAt = 0;
        const jid = this.sock.user?.id || savedPhone || '';
        const phone = jid.split(':')[0].split('@')[0];
        if (phone) this.savedPhone = phone;
        console.log(`[Baileys] ✅ Подключено к WhatsApp! Номер: +${phone ? phone.slice(0, 3) + '****' + phone.slice(-2) : 'неизвестен'}`);
        this.sock.groupFetchAllParticipating()
          .then(groups => {
            const ids = Object.keys(groups);
            console.log(`[Baileys] Групп загружено: ${ids.length}`);
            ids.forEach(id => console.log(`[Baileys] Группа: ${id} — ${groups[id].subject}`));
          })
          .catch(e => console.warn('[Baileys] Не удалось загрузить группы:', e.message));
      }
    });
  }

  // Request an 8-character pairing code for the given phone number.
  // Caller is responsible for token-checking.
  async requestPairing(rawPhone) {
    const phone = String(rawPhone || '').replace(/\D/g, '');
    if (phone.length < 10) throw new Error('Некорректный номер телефона');
    if (this.isConnected) throw new Error('Бот уже подключён к WhatsApp');
    if (!this.sock) throw new Error('Сокет ещё не инициализирован, попробуйте через несколько секунд');

    // В Baileys 7.x ws — обёртка WebSocketClient с геттером isOpen (нет
    // нативного readyState). Без поднятого WS код вернётся, но WA-сервер о
    // нём не узнает → "Connection Closed" в приложении при попытке привязки.
    // Ждём оптимистично, потом всегда зовём requestPairingCode — он сам
    // решит готов он или нет. Так работает NeoDrain reference.
    const isWsOpen = () => {
      const ws = this.sock?.ws;
      if (!ws) return false;
      if (typeof ws.isOpen === 'boolean') return ws.isOpen;
      if (typeof ws.readyState === 'number') return ws.readyState === 1;
      // ни одного из известных полей нет — не знаем, не блокируем
      return true;
    };

    if (!isWsOpen()) {
      await new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (isWsOpen() || Date.now() - start > 8_000) return resolve();
          setTimeout(tick, 200);
        };
        tick();
      });
    }

    // Retry: первая попытка иногда падает с Connection Closed если внутренние
    // очереди Baileys ещё не догнали handshake. Спокойный повтор через 1.5с
    // покрывает этот случай.
    let lastErr;
    for (const wait of [0, 1500]) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      try {
        const code = await this.sock.requestPairingCode(phone);
        this.lastPairingCode = code;
        this.pairingExpiresAt = Date.now() + 60_000;
        console.log(`[Baileys] Pairing code для +${phone}: ${code} (действует 60 сек)`);
        return code;
      } catch (err) {
        lastErr = err;
        console.warn(`[Baileys] requestPairingCode попытка ${wait ? 2 : 1}: ${err.message}`);
      }
    }
    throw new Error(`Не удалось получить код: ${lastErr?.message || 'unknown'}`);
  }

  async sendMessage(jid, text) {
    if (!this.sock) throw new Error('[Baileys] Сокет не инициализирован');
    await this.sock.sendMessage(jid, { text });
    return true;
  }

  async sendTyping(jid) {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
    } catch (_) {
      // presence errors are non-fatal
    }
  }

  async downloadMedia(baileysMediaObj, type) {
    const stream = await downloadContentFromMessage(baileysMediaObj, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
}

module.exports = new BaileysService();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { forFamily, listFamilies } = require('./database');

const DATA_DIR = path.join(__dirname, 'data');
const logger = pino({ level: 'silent' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// familyId → socket
const sockets = new Map();
// familyId → reconnect timer
const reconnectTimers = new Map();

async function connect(familyId, phoneNumber, broadcast) {
  // Tear down existing connection
  if (sockets.has(familyId)) {
    try { sockets.get(familyId).end(undefined); } catch (_) {}
    sockets.delete(familyId);
  }

  const authDir = path.join(DATA_DIR, familyId, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const db = forFamily(familyId);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
  });

  sockets.set(familyId, sock);
  _setupEvents(familyId, sock, saveCreds, broadcast);

  await delay(2000);

  if (!sock.authState.creds.registered) {
    const cleaned = String(phoneNumber).replace(/\D/g, '');
    const code = await sock.requestPairingCode(cleaned);
    db.setStatus('connecting', cleaned);
    return code?.match(/.{1,4}/g)?.join('-') || code;
  }

  return null; // already registered — connection.update 'open' fires shortly
}

function _setupEvents(familyId, sock, saveCreds, broadcast) {
  const db = forFamily(familyId);
  const emit = (data) => broadcast(familyId, data);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || '';
      db.setStatus('connected', phone);
      emit({ type: 'status', status: 'connected' });
      console.log(`[${familyId.slice(0, 8)}] WhatsApp connected as ${phone}`);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      db.setStatus('disconnected', null);
      emit({ type: 'status', status: 'disconnected' });
      sockets.delete(familyId);
      if (code !== DisconnectReason.loggedOut) {
        _scheduleReconnect(familyId, broadcast);
      } else {
        // Logged out — clear auth
        const authDir = path.join(DATA_DIR, familyId, 'auth');
        try { fs.rmSync(authDir, { recursive: true }); } catch (_) {}
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    const myPhone = db.getStatus()?.phone_number || '';

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid || '';
      if (!remoteJid.endsWith('@s.whatsapp.net')) continue; // skip groups

      const number = remoteJid.replace('@s.whatsapp.net', '');
      const isFromMe = !!msg.key.fromMe;
      const content =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '[media]';

      const isAllowed = db.isAllowedContact(number);

      db.saveMessage({
        messageId: msg.key.id,
        fromNumber: isFromMe ? myPhone : number,
        toNumber: isFromMe ? number : myPhone,
        content,
        timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        isFromMe,
        status: 'delivered',
        isAllowed,
      });

      if (!isFromMe && isAllowed) {
        emit({ type: 'notify', number });
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    const map = { 1: 'sent', 2: 'delivered', 3: 'read' };
    for (const { key, update } of updates) {
      if (update.status != null) {
        db.updateStatus(key.id, map[update.status] || 'sent');
      }
    }
  });
}

function _scheduleReconnect(familyId, broadcast) {
  if (reconnectTimers.has(familyId)) return;
  const timer = setTimeout(async () => {
    reconnectTimers.delete(familyId);
    const db = forFamily(familyId);
    const status = db.getStatus();
    if (status?.phone_number) {
      try {
        await connect(familyId, status.phone_number, broadcast);
      } catch (e) {
        console.error(`[${familyId.slice(0, 8)}] Reconnect failed:`, e.message);
        _scheduleReconnect(familyId, broadcast);
      }
    }
  }, 8000);
  reconnectTimers.set(familyId, timer);
}

async function tryAutoConnect(broadcast) {
  const families = listFamilies();
  console.log(`[AutoConnect] Found ${families.length} saved session(s)`);
  for (const familyId of families) {
    const db = forFamily(familyId);
    const status = db.getStatus();
    if (status?.phone_number) {
      try {
        await connect(familyId, status.phone_number, broadcast);
      } catch (e) {
        console.error(`[AutoConnect ${familyId.slice(0, 8)}] Failed:`, e.message);
      }
    }
  }
}

async function sendMessage(familyId, to, text) {
  const sock = sockets.get(familyId);
  if (!sock) throw new Error('WhatsApp not connected for this account');
  return sock.sendMessage(`${to}@s.whatsapp.net`, { text });
}

async function disconnect(familyId) {
  const sock = sockets.get(familyId);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    sockets.delete(familyId);
  }
  const db = forFamily(familyId);
  db.setStatus('disconnected', null);
  const authDir = path.join(DATA_DIR, familyId, 'auth');
  try { fs.rmSync(authDir, { recursive: true }); } catch (_) {}
}

module.exports = { connect, sendMessage, disconnect, tryAutoConnect };

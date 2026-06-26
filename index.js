const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { forFamily } = require('./database');
const baileys = require('./baileys');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());

// ── Per-family WebSocket clients ───────────────────────────────────────────────

// familyId → Set<WebSocket>
const familyClients = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const familyId = _sanitize(url.searchParams.get('token'));
  if (!familyId) { ws.close(); return; }

  if (!familyClients.has(familyId)) familyClients.set(familyId, new Set());
  familyClients.get(familyId).add(ws);

  const db = forFamily(familyId);
  ws.send(JSON.stringify({ type: 'status', status: db.getStatus()?.status || 'disconnected' }));

  ws.on('close', () => familyClients.get(familyId)?.delete(ws));
  ws.on('error', () => familyClients.get(familyId)?.delete(ws));
});

function broadcast(familyId, data) {
  const clients = familyClients.get(familyId);
  if (!clients) return;
  const payload = JSON.stringify(data);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch (_) {}
    }
  });
}

// ── Family token middleware ────────────────────────────────────────────────────

function _sanitize(token) {
  if (!token || token.length < 16 || token.length > 64) return null;
  return token.replace(/[^a-zA-Z0-9_-]/g, '');
}

// All routes except /ping require X-Family-Token header
app.use((req, res, next) => {
  if (req.path === '/ping') return next();
  const token = _sanitize(req.headers['x-family-token']);
  if (!token) return res.status(401).json({ error: 'Missing X-Family-Token header' });
  req.familyId = token;
  next();
});

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/ping', (_req, res) => {
  res.json({ ok: true });
});

// POST /connect
app.post('/connect', async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'phone_number required' });

  const db = forFamily(req.familyId);
  if (db.getStatus()?.status === 'connected') {
    return res.json({ already_connected: true, pairing_code: null });
  }

  try {
    const code = await baileys.connect(req.familyId, phone_number, broadcast);
    res.json({ already_connected: false, pairing_code: code });
  } catch (err) {
    console.error('[/connect]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /status
app.get('/status', (req, res) => {
  const db = forFamily(req.familyId);
  res.json(db.getStatus() || { status: 'disconnected' });
});

// GET /contacts
app.get('/contacts', (req, res) => {
  res.json(forFamily(req.familyId).getContacts());
});

// GET /chats
app.get('/chats', (req, res) => {
  res.json(forFamily(req.familyId).getChats());
});

// POST /contacts/add
app.post('/contacts/add', (req, res) => {
  const { phone_number, display_name } = req.body;
  if (!phone_number || !display_name)
    return res.status(400).json({ error: 'phone_number and display_name required' });
  forFamily(req.familyId).addContact(
    String(phone_number).replace(/\D/g, ''),
    String(display_name).trim()
  );
  res.json({ success: true });
});

// POST /contacts/remove
app.post('/contacts/remove', (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'phone_number required' });
  forFamily(req.familyId).removeContact(String(phone_number).replace(/\D/g, ''));
  res.json({ success: true });
});

// GET /messages/:number — child view (allowed only)
app.get('/messages/:number', (req, res) => {
  const num = req.params.number.replace(/\D/g, '');
  res.json(forFamily(req.familyId).getMessages(num));
});

// GET /monitor/messages/:number — parent view (all)
app.get('/monitor/messages/:number', (req, res) => {
  const num = req.params.number.replace(/\D/g, '');
  res.json(forFamily(req.familyId).getAllMessages(num));
});

// GET /monitor/blocked
app.get('/monitor/blocked', (req, res) => {
  res.json(forFamily(req.familyId).getBlockedSenders());
});

// POST /messages/:number/read
app.post('/messages/:number/read', (req, res) => {
  forFamily(req.familyId).markRead(req.params.number.replace(/\D/g, ''));
  res.json({ success: true });
});

// POST /send
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });

  const db = forFamily(req.familyId);
  const cleaned = String(to).replace(/\D/g, '');

  if (!db.isAllowedContact(cleaned))
    return res.status(403).json({ error: 'Contact not in allowed list' });

  try {
    const result = await baileys.sendMessage(req.familyId, cleaned, message);
    const myPhone = db.getStatus()?.phone_number || '';

    db.saveMessage({
      messageId: result?.key?.id || `local-${Date.now()}`,
      fromNumber: myPhone,
      toNumber: cleaned,
      content: message,
      timestamp: Math.floor(Date.now() / 1000),
      isFromMe: true,
      status: 'sent',
      isAllowed: true,
    });

    broadcast(req.familyId, {
      type: 'message',
      message: {
        message_id: result?.key?.id,
        from_number: myPhone,
        to_number: cleaned,
        content: message,
        timestamp: Math.floor(Date.now() / 1000),
        is_from_me: 1,
        status: 'sent',
        is_allowed: 1,
        is_read: 1,
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[/send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /disconnect
app.post('/disconnect', async (req, res) => {
  await baileys.disconnect(req.familyId);
  broadcast(req.familyId, { type: 'status', status: 'disconnected' });
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`[KidSafe] WhatsApp backend on :${PORT} — multi-tenant`);
  await baileys.tryAutoConnect(broadcast);
});

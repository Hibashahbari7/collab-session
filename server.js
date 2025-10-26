// server.js — Collab Session WebSocket backend (MVP)

const WebSocket = require('ws');

const PORT = Number(process.env.COLLAB_PORT || process.env.PORT || 3000);
const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`WS server listening on ws://localhost:${PORT}`);
});

// sid -> { host: ws, users: Map<name, ws>, question?: string }
const sessions = new Map();

// helpers
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
function safeParse(buf) { try { return JSON.parse(String(buf)); } catch { return null; } }
function setMeta(ws, meta) { ws.__meta = Object.assign(ws.__meta || {}, meta); }
function getMeta(ws) { return ws.__meta || {}; }

function broadcastSession(sid, payload, exclude = null) {
  const s = sessions.get(sid);
  if (!s) return;
  if (s.host && s.host.readyState === WebSocket.OPEN && s.host !== exclude) send(s.host, payload);
  for (const sock of s.users.values()) {
    if (sock.readyState === WebSocket.OPEN && sock !== exclude) send(sock, payload);
  }
}
function pushUsersList(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  const users = [...s.users.keys()].map(name => ({ name }));
  broadcastSession(sid, { type: 'users', sessionId: sid, users });
}

// create session (host)
function createSession(ws, proposed) {
  let sid = (proposed || '').toUpperCase().trim();
  if (!sid || sessions.has(sid)) {
    sid = Math.random().toString(36).slice(2, 8).toUpperCase();
    while (sessions.has(sid)) sid = Math.random().toString(36).slice(2, 8).toUpperCase();
  }
  sessions.set(sid, { host: ws, users: new Map(), question: '' });
  setMeta(ws, { role: 'host', sid });
  send(ws, { type: 'created', sessionId: sid });
  pushUsersList(sid);
  console.log(`[session ${sid}] created`);
}

// join session (student)
function joinSession(ws, sid, name) {
  sid = (sid || '').toUpperCase().trim();
  name = String(name || '').trim();
  const s = sessions.get(sid);
  if (!sid || !name || !s) return send(ws, { type: 'error', message: 'Invalid session or name' });

  // ensure unique name
  let final = name, i = 2;
  while (s.users.has(final)) final = `${name}-${i++}`;

  s.users.set(final, ws);
  setMeta(ws, { role: 'student', sid, name: final });

  send(ws, { type: 'joined', sessionId: sid, name: final, question: s.question || '' });
  broadcastSession(sid, { type: 'userJoined', sessionId: sid, name: final });
  pushUsersList(sid);
  console.log(`[session ${sid}] ${final} joined`);
}

// set question (host)
function setQuestion(ws, text) {
  const { role, sid } = getMeta(ws);
  if (role !== 'host' || !sid) return send(ws, { type: 'error', message: 'Only host can set question' });
  const s = sessions.get(sid); if (!s) return;
  s.question = String(text || '');
  broadcastSession(sid, { type: 'question', text: s.question });
  console.log(`[session ${sid}] question updated`);
}

// student answer -> deliver to host
function handleAnswer(ws, code) {
  const { role, sid, name } = getMeta(ws);
  if (role !== 'student' || !sid || !name) return;
  const s = sessions.get(sid); if (!s || !s.host) return;
  send(s.host, { type: 'answerReceived', name, code: String(code || '') });
  console.log(`[session ${sid}] answer from ${name}`);
}

// host feedback -> one student
function sendFeedback(ws, to, text) {
  const { role, sid } = getMeta(ws);
  if (role !== 'host' || !sid) return send(ws, { type: 'error', message: 'Only host can send feedback' });
  const s = sessions.get(sid); if (!s) return;
  const target = s.users.get(String(to || '').trim());
  if (!target) return send(ws, { type: 'error', message: 'Student not found' });
  send(target, { type: 'feedback', text: String(text || '') });
  console.log(`[session ${sid}] feedback -> ${to}`);
}

// host closes session
function closeSession(ws) {
  const { role, sid } = getMeta(ws);
  if (role !== 'host' || !sid) return;
  const s = sessions.get(sid); if (!s) return;
  broadcastSession(sid, { type: 'sessionClosed' });
  for (const sock of s.users.values()) setMeta(sock, { sid: undefined });
  sessions.delete(sid);
  setMeta(ws, { sid: undefined });
  console.log(`[session ${sid}] closed`);
}

// cleanup on socket close/error/leave
function cleanupSocket(ws) {
  const { role, sid, name } = getMeta(ws);
  if (!sid) return;
  const s = sessions.get(sid); if (!s) return;

  if (role === 'host') {
    broadcastSession(sid, { type: 'sessionClosed' }, ws);
    for (const sock of s.users.values()) setMeta(sock, { sid: undefined });
    sessions.delete(sid);
    console.log(`[session ${sid}] host disconnected -> closed`);
    return;
  }

  if (role === 'student' && name) {
    if (s.users.get(name) === ws) s.users.delete(name);
    broadcastSession(sid, { type: 'userLeft', sessionId: sid, name }, ws);
    pushUsersList(sid);
    console.log(`[session ${sid}] ${name} left`);
  }
}

// heartbeat
const HEARTBEAT_MS = 30000;
function heartbeat(ws) { ws.isAlive = true; }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => heartbeat(ws));

  ws.on('message', (buf) => {
    const msg = safeParse(buf);
    if (!msg || typeof msg.type !== 'string') return send(ws, { type: 'error', message: 'Bad message' });

    switch (msg.type) {
      case 'create': createSession(ws, msg.sessionId); break;
      case 'join': joinSession(ws, msg.sessionId, msg.name); break;
      case 'setQuestion': setQuestion(ws, msg.text); break;
      case 'answer': handleAnswer(ws, msg.code); break;
      case 'feedback': sendFeedback(ws, msg.to, msg.text); break;
      case 'close': closeSession(ws); break;
      case 'leave': cleanupSocket(ws); break;
      default: send(ws, { type: 'error', message: 'Unknown type' });
    }
  });

  ws.on('close', () => cleanupSocket(ws));
  ws.on('error', () => cleanupSocket(ws));
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(interval));

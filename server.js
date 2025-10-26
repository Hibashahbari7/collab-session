// server.js — Collab Session WebSocket backend (MVP)

const WebSocket = require('ws');

// --- SQLite setup (persistent storage) ---
const Database = require('better-sqlite3');

// create (or open) a local db file next to server.js
const db = new Database('collab.db');

// reasonable defaults for durability + concurrency
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// minimal schema to track sessions, members, questions, answers, feedback
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS members(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    UNIQUE(session_id, name, joined_at)
  );
  CREATE TABLE IF NOT EXISTS questions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    set_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS answers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    submitted_at INTEGER,
    filename TEXT
  );
  CREATE TABLE IF NOT EXISTS feedback(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    to_student TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_members_session ON members(session_id);
  CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
  CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);
`);

// tiny time helper
const now = () => Date.now();

// prepared statements (fast + safe)
const insSession       = db.prepare('INSERT OR IGNORE INTO sessions(id, created_at) VALUES(?, ?)');
const closeSessionStmt = db.prepare('UPDATE sessions SET closed_at=? WHERE id=?');

const insMember  = db.prepare('INSERT INTO members(session_id, name, joined_at) VALUES(?,?,?)');
const leaveMember= db.prepare('UPDATE members SET left_at=? WHERE session_id=? AND name=? AND left_at IS NULL');

const insQuestion= db.prepare('INSERT INTO questions(session_id, text, set_at) VALUES(?,?,?)');
const insAnswer = db.prepare('INSERT INTO answers(session_id, name, code, submitted_at, filename) VALUES (?, ?, ?, ?, ?)');
const insFeedback= db.prepare('INSERT INTO feedback(session_id, to_student, text, created_at) VALUES(?,?,?,?)');


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

  // persist session creation
  insSession.run(sid, now());

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

  // persist join
  insMember.run(sid, final, now());
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
  // persist question update
  insQuestion.run(sid, s.question, now());
}

// student answer -> deliver to host
function handleAnswer(ws, payload) {
  const { role, sid, name } = getMeta(ws);
  if (role !== 'student' || !sid || !name) return;

  const s = sessions.get(sid);
  if (!s || !s.host) return;

  // extract code + filename safely
  const code = typeof payload === 'object' ? String(payload.code || '') : String(payload || '');
  const filename = typeof payload === 'object' ? String(payload.filename || '') : 'answer.txt';

  // deliver to host with filename
  send(s.host, {
    type: 'answerReceived',
    name,
    code,
    filename, // 👈 send filename too
  });

  console.log(`[session ${sid}] answer from ${name} (${filename})`);

  // persist answer in DB if needed
  insAnswer.run(sid, name, code, now(), filename)
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
  // persist feedback
  insFeedback.run(sid, String(to || ''), String(text || ''), now());
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
  // persist closed_at
  closeSessionStmt.run(now(), sid);
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
    // persist leave
    leaveMember.run(now(), sid, name);
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
      case 'answer': handleAnswer(ws, msg); break;
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

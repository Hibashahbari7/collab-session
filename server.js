// server.js
// -----------------------------------------------------------------------------
// Collab Session - WebSocket server
// Host can create session, students join, host can set question, students send
// answers, notifications for join/leave/close.
// -----------------------------------------------------------------------------

const { WebSocketServer } = require('ws');

// --- Config ---
// host and port are taken from environment variables if available
// default host=0.0.0.0 (listen on all interfaces), default port=3000
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

// --- State ---
// sessions: sid -> {
//   sid,
//   owner,               // host socket
//   ownerMachineId,      // host machineId
//   users: Map<name, { socket, machineId }>, // students
//   question
// }
const sessions = new Map();
const socketMeta = new WeakMap();


// --- Helpers ---
function broadcast(session, payload) {
  // send JSON to all users + host
  const json = JSON.stringify(payload);
  session.users.forEach(({ socket }) => { try { socket.send(json); } catch {} });
  try { session.owner?.send(json); } catch {}
}

function getOrCreateSession(sid, ownerSocket, ownerMachineId) {
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      sid,
      owner: ownerSocket,
      ownerMachineId,
      users: new Map(),
      question: ''
    });
  }
  return sessions.get(sid);
}


function usersPayload(session) {
  // return list of {name}
  return [...session.users.keys()].map(n => ({ name: n }));
}

function safeSend(sock, payload) {
  try { sock.send(JSON.stringify(payload)); } catch {}
}

// --- Server ---
const wss = new WebSocketServer({ host: HOST, port: PORT }, () => {
  console.log(`Server running at ws://${HOST}:${PORT}`);
});

// log when the server is ready
wss.on('listening', () => {
  // note: host shown here is just for info; to connect from another machine use the actual ipv4 of the server
  console.log(`websocket server listening on ws://${HOST}:${PORT}`);
});

// --- Connection ---
wss.on('connection', (socket) => {
  socketMeta.set(socket, { isAlive: true });

  socket.on('pong', () => {
    const meta = socketMeta.get(socket);
    if (meta) meta.isAlive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    // --- CREATE (host) ---
    if (msg.type === 'create') {
      const sid = String(msg.sessionId || '').toUpperCase();
      const machineId = String(msg.machineId || '').trim();
      if (!sid) return safeSend(socket, { type: 'error', message: 'Bad session id' });

      // host can own only one active session (per MACHINE too)
      const alreadyOwnerBySocket = [...sessions.values()].some(s => s.owner === socket);
      const alreadyOwnerByMachine = [...sessions.values()].some(s => s.ownerMachineId === machineId);
      if (alreadyOwnerBySocket || alreadyOwnerByMachine) {
        return safeSend(socket, { type: 'error', message: 'You already own a session on this machine' });
      }

      const s = getOrCreateSession(sid, socket, machineId);
      socketMeta.set(socket, { sid, role: 'host', isAlive: true, machineId });

      safeSend(socket, { type: 'created', sessionId: sid });
      broadcast(s, { type: 'users', sessionId: sid, users: usersPayload(s) });
      if (s.question) broadcast(s, { type: 'question', text: s.question });
      return;
    }


    // --- JOIN (student) ---
    if (msg.type === 'join') {
      const sid = String(msg.sessionId || '').toUpperCase();
      const name = String(msg.name || '').trim();
      const machineId = String(msg.machineId || '').trim();
      const s = sessions.get(sid);
      if (!s) return safeSend(socket, { type: 'error', message: 'Invalid session' });
      if (!name) return safeSend(socket, { type: 'error', message: 'Name required' });

      // unique name (as before)
      if (s.users.has(name)) {
        return safeSend(socket, { type: 'error', message: 'Name already used' });
      }

      // NEW: block same machine from joining the same session twice
      const sameMachineAlreadyIn = [...s.users.values()].some(u => u.machineId === machineId) || s.ownerMachineId === machineId;
      if (sameMachineAlreadyIn) {
        return safeSend(socket, { type: 'error', message: 'This machine already participates in this session' });
      }

      s.users.set(name, { socket, machineId });
      socketMeta.set(socket, { sid, name, role: 'student', isAlive: true, machineId });

      safeSend(socket, { type: 'joined', sessionId: sid, name, question: s.question || '' });
      broadcast(s, { type: 'users', sessionId: sid, users: usersPayload(s) });
      broadcast(s, { type: 'userJoined', sessionId: sid, name });
      return;
    }



    // --- SET QUESTION (host) ---
    if (msg.type === 'setQuestion') {
      const s = [...sessions.values()].find(x => x.owner === socket);
      if (!s) return safeSend(socket, { type: 'error', message: 'Not a host' });
      s.question = String(msg.text || '');
      broadcast(s, { type: 'question', text: s.question });
      return;
    }

    // --- ANSWER (student manual) ---
    if (msg.type === 'answer') {
      const sid = String(msg.sessionId || '').toUpperCase();
      const name = String(msg.name || '').trim();
      const code = String(msg.code || '');
      const s = sessions.get(sid);
      if (!s) return;
      // send only to host
      safeSend(s.owner, { type: 'answerReceived', name, code });
      return;
    }

    // --- LEAVE (student) ---
    if (msg.type === 'leave') {
      const m = socketMeta.get(socket) || {};
      const sid = String(msg.sessionId || m.sid || '').toUpperCase();
      const name = String(msg.name || m.name || '').trim();
      const s = sessions.get(sid);
      if (s && name && s.users.delete(name)) {
        broadcast(s, { type: 'userLeft', sessionId: sid, name });
        broadcast(s, { type: 'users', sessionId: sid, users: usersPayload(s) });
      }
      socketMeta.set(socket, { isAlive: true });
      return;
    }


    // --- CLOSE (host) ---
    if (msg.type === 'close') {
      for (const [sid, s] of sessions) {
        if (s.owner === socket) {
          broadcast(s, { type: 'sessionClosed' });
          s.users.forEach(({ socket: ws }) => { try { ws.close(); } catch {} });
          sessions.delete(sid);
          socketMeta.set(socket, { isAlive: true });
          break;
        }
      }
      return;
    }

    // --- FEEDBACK (host -> one student) ---
    if (msg.type === 'feedback') {
      // host sends feedback to a single student by name
      const sid = String(msg.sessionId || '').toUpperCase();
      const to  = String(msg.to || '').trim();
      const text = String(msg.text || '');
      const s = sessions.get(sid);
      if (!s || !to || !text) return;
      const target = s.users.get(to);
      if (target?.socket) safeSend(target.socket, { type: 'feedback', from: 'host', text });
      return;
    }

  });

  // --- Disconnect cleanup ---
  socket.on('close', () => {
    const meta = socketMeta.get(socket) || {};
    const sid = meta.sid;
    const role = meta.role;
    const name = meta.name;
    if (!sid) return;
    const s = sessions.get(sid);
    if (!s) return;

    if (role === 'host') {
      broadcast(s, { type: 'sessionClosed' });
      s.users.forEach(({ socket: ws }) => { try { ws.close(); } catch {} });
      sessions.delete(sid);
    } else if (role === 'student' && name) {
      if (s.users.delete(name)) {
        broadcast(s, { type: 'userLeft', sessionId: sid, name });
        broadcast(s, { type: 'users', sessionId: sid, users: usersPayload(s) });
      }
    }
  });
});

// --- Heartbeat (ping/pong) ---
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    const meta = socketMeta.get(ws);
    if (!meta) return;
    if (meta.isAlive === false) { try { ws.terminate(); } catch {} }
    meta.isAlive = false;
    socketMeta.set(ws, meta);
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

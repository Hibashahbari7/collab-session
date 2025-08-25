// server.js
// Simple WebSocket server with sessions & nicknames
const { WebSocketServer } = require('ws');

const PORT = 3000;
const wss = new WebSocketServer({ port: PORT });

// Map<sessionId, { clients:Set<ws>, names: Map<ws,string> }>
const sessions = new Map();

function broadcast(sessionId, payload) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const data = JSON.stringify(payload);
  for (const client of s.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function pushUsers(sessionId) {
  const room = sessions.get(sessionId);
  if (!room) return;

  const users = Array.from(room).map(c => (c.__name || 'guest'));
  const payload = JSON.stringify({ type: 'users', sessionId, users });

  for (const c of room) {
    try { c.send(payload); } catch {}
  }
}

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore invalid JSON
    }

    switch (msg.type) {
      case 'create': {
        const id = typeof msg.sessionId === 'string'
          ? msg.sessionId
          : Math.random().toString(36).slice(2, 8).toUpperCase();

        if (!sessions.has(id)) {
          sessions.set(id, { clients: new Set(), names: new Map() });
        }
        const s = sessions.get(id);
        s.clients.add(socket);

        const name = (typeof msg.nickname === 'string' && msg.nickname.trim()) ? msg.nickname.trim() : 'host';
        s.names.set(socket, name);

        socket.send(JSON.stringify({ type: 'created', sessionId: id }));
        pushUsers(id);
        break;
      }

      case 'join': {
        // payload expected: { type:'join', sessionId, name }
        const sid = String(data.sessionId || '').toUpperCase();
        const nick = (typeof data.name === 'string' && data.name.trim())
          ? data.name.trim()
          : 'guest';

        const room = sessions.get(sid);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          break;
        }

        // store on the socket
        ws.__sid = sid;
        ws.__name = nick;

        room.add(ws);

        // acknowledge to the joiner with *their* name
        ws.send(JSON.stringify({ type: 'joined', sessionId: sid, name: nick }));

        // broadcast updated users list
        pushUsers(sid);
        break;
      }


      case 'code': {
        const id = typeof msg.sessionId === 'string' ? msg.sessionId : '';
        if (!sessions.has(id)) return;
        const s = sessions.get(id);
        const name = s.names.get(socket) || 'anon';
        const code = typeof msg.code === 'string' ? msg.code : '';
        broadcast(id, { type: 'code', sessionId: id, name, code });
        break;
      }

      default:
        // ignore unknown types
        break;
    }
  });

  socket.on('close', () => {
    // remove from whichever session this socket belonged to
    for (const [id, s] of sessions) {
      if (s.clients.delete(socket)) {
        s.names.delete(socket);
        if (s.clients.size === 0) {
          sessions.delete(id);
        } else {
          pushUsers(id);
        }
        break;
      }
    }
  });
});

console.log(`WebSocket server running on ws://localhost:${PORT}`);

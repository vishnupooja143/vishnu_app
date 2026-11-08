import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

const PORT = process.env.PORT || 3001;
const RING_SECONDS = 30;

const USERS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'users.json');
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) : {};
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const hashPassword = (password, salt) =>
  crypto.scryptSync(password, salt, 32).toString('hex');

const sessions = new Map();

function newSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, username);
  return token;
}

const app = express();
app.use(cors());
app.use(express.json());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '../client/dist')));


app.post('/register', (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{2,20}$/.test(username))
    return res.status(400).json({ error: 'Username: 2-20 letters, numbers or _' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (users[username])
    return res.status(409).json({ error: 'This username is already taken' });

  const salt = crypto.randomBytes(16).toString('hex');
  users[username] = { salt, hash: hashPassword(password, salt) };
  saveUsers();
  broadcastUsers();
  res.json({ session: newSession(username), username });
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const u = users[username];
  if (!u) return res.status(401).json({ error: 'Wrong username or password' });

  const a = Buffer.from(hashPassword(password, u.salt), 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (!crypto.timingSafeEqual(a, b))
    return res.status(401).json({ error: 'Wrong username or password' });

  res.json({ session: newSession(username), username });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

const online = new Map();
const calls = new Map();
const busy = new Set();

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

const userList = () =>
  Object.keys(users)
    .sort()
    .map((u) => ({ username: u, online: online.has(u), busy: busy.has(u) }));

function broadcastUsers() {
  const list = userList();
  for (const ws of online.values()) send(ws, { type: 'users', users: list });
}

async function makeToken(identity, room) {
  const at = new AccessToken(API_KEY, API_SECRET, { identity });
  at.addGrant({ roomJoin: true, room });
  return at.toJwt();
}

function dropCall(call) {
  clearTimeout(call.timer);
  calls.delete(call.id);
  busy.delete(call.from);
  busy.delete(call.to);
  broadcastUsers();
}

const callOf = (user) =>
  [...calls.values()].find((c) => c.from === user || c.to === user);

wss.on('connection', (ws) => {
  ws.user = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      const u = sessions.get(msg.session);
      if (!u) return send(ws, { type: 'auth_error' });
      const old = online.get(u);
      if (old && old !== ws) {
        old.user = null;
        send(old, { type: 'replaced' });
        old.close();
      }
      ws.user = u;
      online.set(u, ws);
      send(ws, { type: 'ready', username: u });
      broadcastUsers();
      return;
    }

    const me = ws.user;
    if (!me) return;

    if (msg.type === 'call') {
      const to = String(msg.to || '');
      if (!users[to] || to === me)
        return send(ws, { type: 'call_failed', reason: 'User not found' });
      if (!online.has(to))
        return send(ws, { type: 'call_failed', reason: `${to} is offline` });
      if (busy.has(to) || busy.has(me))
        return send(ws, { type: 'call_failed', reason: busy.has(me) ? 'You are already in a call' : `${to} is busy` });

      const id = crypto.randomUUID();
      const call = { id, from: me, to, room: 'call-' + id, status: 'ringing' };
      call.timer = setTimeout(() => {
        send(online.get(call.from), { type: 'call_missed', to: call.to });
        send(online.get(call.to), { type: 'call_cancelled', from: call.from });
        dropCall(call);
      }, RING_SECONDS * 1000);
      calls.set(id, call);
      busy.add(me);
      busy.add(to);

      send(ws, { type: 'calling', callId: id, to });
      send(online.get(to), { type: 'incoming', callId: id, from: me });
      broadcastUsers();
      return;
    }

    const call = calls.get(msg.callId);

    if (msg.type === 'accept') {
      if (!call || call.to !== me || call.status !== 'ringing') return;
      clearTimeout(call.timer);
      call.status = 'active';
      send(online.get(call.from), {
        type: 'call_accepted', room: call.room, with: call.to, url: LIVEKIT_URL,
        token: await makeToken(call.from, call.room),
      });
      send(online.get(call.to), {
        type: 'call_accepted', room: call.room, with: call.from, url: LIVEKIT_URL,
        token: await makeToken(call.to, call.room),
      });
      return;
    }

    if (msg.type === 'decline') {
      if (!call || call.to !== me || call.status !== 'ringing') return;
      send(online.get(call.from), { type: 'call_declined', by: me });
      dropCall(call);
      return;
    }

    if (msg.type === 'cancel') {
      if (!call || call.from !== me || call.status !== 'ringing') return;
      send(online.get(call.to), { type: 'call_cancelled', from: me });
      dropCall(call);
      return;
    }

    if (msg.type === 'end') {
      const c = callOf(me);
      if (!c || c.status !== 'active') return;
      const other = c.from === me ? c.to : c.from;
      send(online.get(other), { type: 'call_ended' });
      dropCall(c);
      return;
    }
  });

  ws.on('close', () => {
    const me = ws.user;
    if (!me) return;
    if (online.get(me) === ws) online.delete(me);
    const c = callOf(me);
    if (c) {
      const other = c.from === me ? c.to : c.from;
      send(online.get(other), { type: c.status === 'active' ? 'call_ended' : 'call_cancelled' });
      dropCall(c);
    }
    broadcastUsers();
  });
});

server.listen(PORT, () => console.log(`App server running on port ${PORT}`));


import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';
import '@livekit/components-styles';
import './App.css';

const isDev = window.location.port === '5173';
const API = isDev ? `http://${window.location.hostname}:3001` : window.location.origin;
const WS_URL = API.replace(/^http/, 'ws');

const COLORS = ['#3b4cca', '#b5476b', '#2c7a7b', '#9c5a1a', '#6b46c1', '#2b6cb0', '#a0522d', '#3d7a3d'];
const colorFor = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

function Avatar({ name, size = 44 }) {
  return (
    <div className="avatar" style={{ background: colorFor(name), width: size, height: size, fontSize: size * 0.42 }}>
      {name[0].toUpperCase()}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(sessionStorage.getItem('session') || '');
  const [me, setMe] = useState('');
  const [users, setUsers] = useState([]);
  const [connected, setConnected] = useState(false);

  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [camOn, setCamOn] = useState(true);

  const [incoming, setIncoming] = useState(null);
  const [outgoing, setOutgoing] = useState(null);
  const [call, setCall] = useState(null);

  const wsRef = useRef(null);
  const send = (obj) => {
    if (wsRef.current && wsRef.current.readyState === 1) wsRef.current.send(JSON.stringify(obj));
  };

  const logout = () => {
    sessionStorage.removeItem('session');
    setSession('');
    setMe('');
    setUsers([]);
    setIncoming(null);
    setOutgoing(null);
    setCall(null);
  };

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let retry;

    const handle = (msg) => {
      switch (msg.type) {
        case 'ready': setMe(msg.username); setConnected(true); break;
        case 'users': setUsers(msg.users); break;
        case 'auth_error': logout(); setError('Session expired. Please log in again.'); break;
        case 'replaced': stopped = true; logout(); setError('You logged in somewhere else.'); break;
        case 'incoming': setIncoming({ callId: msg.callId, from: msg.from }); break;
        case 'calling': setOutgoing({ callId: msg.callId, to: msg.to }); break;
        case 'call_accepted':
          setIncoming(null); setOutgoing(null);
          setCall({ token: msg.token, url: msg.url, with: msg.with });
          break;
        case 'call_declined': setOutgoing(null); setNotice(`${msg.by} declined your call`); break;
        case 'call_missed': setOutgoing(null); setNotice(`${msg.to} did not answer`); break;
        case 'call_cancelled': setIncoming(null); setNotice(`Missed call from ${msg.from}`); break;
        case 'call_failed': setOutgoing(null); setNotice(msg.reason); break;
        case 'call_ended': setCall(null); setNotice('Call ended'); break;
        default: break;
      }
    };

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', session }));
      ws.onmessage = (e) => handle(JSON.parse(e.data));
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      const ws = wsRef.current;
      if (ws) { ws.onmessage = null; ws.onclose = null; ws.close(); }
    };
  }, [session]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const submit = async () => {
    setError('');
    try {
      const r = await fetch(`${API}/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) return setError(data.error || 'Something went wrong');
      sessionStorage.setItem('session', data.session);
      setForm({ username: '', password: '' });
      setSession(data.session);
    } catch {
      setError('Cannot reach the app server. Is "node server.js" running?');
    }
  };

  const visibleUsers = useMemo(() => {
    const q = search.toLowerCase().trim();
    return users
      .filter((u) => u.username !== me && u.username.includes(q))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  }, [users, me, search]);

  const onlineCount = users.filter((u) => u.online && u.username !== me).length;

  if (call) {
    return (
      <LiveKitRoom
        data-lk-theme="default"
        serverUrl={call.url}
        token={call.token}
        connect={true}
        video={camOn}
        audio={true}
        onDisconnected={() => { send({ type: 'end' }); setCall(null); }}
        style={{ height: '100vh' }}
      >
        <VideoConference />
      </LiveKitRoom>
    );
  }

  if (!session) {
    return (
      <div className="center">
        <div className="card">
          <h1>{mode === 'login' ? 'Log in' : 'Create account'}</h1>
          <input
            placeholder="Username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
          <input
            type="password"
            placeholder="Password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {error && <p className="error">{error}</p>}
          <button className="primary" onClick={submit}>
            {mode === 'login' ? 'Log in' : 'Create account'}
          </button>
          <button className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header>
        <div className="me">
          {me && <Avatar name={me} size={38} />}
          <div>
            <strong>{me || '...'}</strong>
            <span className={connected ? 'status on' : 'status off'}>
              {connected ? `${onlineCount} online` : 'Reconnecting...'}
            </span>
          </div>
        </div>
        <button className="link" onClick={logout}>Log out</button>
      </header>

      <div className="tools">
        <input placeholder="Search people" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={camOn} onChange={(e) => setCamOn(e.target.checked)} />
          Camera on
        </label>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <ul className="people">
        {visibleUsers.length === 0 && (
          <li className="empty">
            {users.length <= 1 ? 'No one else has an account yet. Ask a friend to sign up.' : 'No one matches your search.'}
          </li>
        )}
        {visibleUsers.map((u) => (
          <li key={u.username} className={u.online ? '' : 'offline'}>
            <div className="who">
              <div className="avwrap">
                <Avatar name={u.username} />
                <span className={'dot ' + (u.online ? 'on' : 'off')} />
              </div>
              <div>
                <div className="uname">{u.username}</div>
                <div className="sub">{u.busy ? 'In a call' : u.online ? 'Online' : 'Offline'}</div>
              </div>
            </div>
            <button
              className="primary small"
              disabled={!u.online || u.busy || !!outgoing || !!incoming}
              onClick={() => send({ type: 'call', to: u.username })}
            >
              Call
            </button>
          </li>
        ))}
      </ul>

      {outgoing && (
        <div className="overlay">
          <div className="card ring">
            <Avatar name={outgoing.to} size={72} />
            <h2>Calling {outgoing.to}...</h2>
            <button className="danger" onClick={() => { send({ type: 'cancel', callId: outgoing.callId }); setOutgoing(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {incoming && (
        <div className="overlay">
          <div className="card ring">
            <Avatar name={incoming.from} size={72} />
            <h2>{incoming.from} is calling you</h2>
            <div className="row">
              <button className="danger" onClick={() => { send({ type: 'decline', callId: incoming.callId }); setIncoming(null); }}>
                Decline
              </button>
              <button className="primary" onClick={() => send({ type: 'accept', callId: incoming.callId })}>
                Answer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
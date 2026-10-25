'use strict';
/* خادم مافيا: بلا مكتبات خارجية وبلا ذكاء اصطناعي. الحالة في الذاكرة.
   الخادم هو الراوي والحَكَم: يوزّع الأدوار سرًّا، يدير المؤقت والمراحل، ويرسل لكل لاعب ما يخصه فقط. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./engine.js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20, MIN_PLAYERS = 6;
const NIGHT_SECS = 84, DAY_SECS = 80, SHORT_SECS = 8, REVEAL_SECS = 8;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ===== الراوي الآلي: جمل معرّفة مسبقًا ===== */
const NARR = {
  night: [['حلّ الليل...', 'أغلقت المدينة أبوابها، وبدأت الأسرار تتحرك في الظلام.'], ['سقط الظلام على المدينة...', 'ومن وراء النوافذ المغلقة، تُحاك المؤامرات.'], ['خيّم الصمت على الشوارع...', 'وفي الظلال، عيونٌ لا تنام.']],
  night2: [['حلّ الليل من جديد...', 'والمدينة لم تعد كما كانت.'], ['عاد الظلام...', 'وعاد معه الخوف من الغد.'], ['ليلة أخرى تبدأ...', 'ومن بقي حيًّا يعلم أن الدور قد يصله.']],
  dayKill: [['أشرقت الشمس...', 'لكن المدينة فقدت أحد أبنائها.'], ['طلع الصباح بوجهٍ شاحب...', 'فالمدينة تبكي أحد أهلها.'], ['انكشف الفجر على خبرٍ ثقيل...', 'لقد فقدنا أحدًا الليلة.']],
  dayCalm: [['أشرقت الشمس...', 'ومرّت الليلة دون ضحايا.'], ['طلع الصباح هادئًا...', 'لكن الهدوء قد يخفي ما هو أسوأ.'], ['نجت المدينة الليلة...', 'ولا يزال بينكم من يتربّص.']],
  vote: [['أُغلقت صناديق الاقتراع...', 'وقررت المدينة مصيرها.'], ['انتهى التصويت...', 'وحان وقت إعلان القرار.'], ['صمت الجميع...', 'والأصوات تُحصى الآن.']],
  winMafia: ['«سقطت المدينة في قبضة الظلام.»', '«صمتت المدينة، وبقيت المافيا وحدها.»'],
  winCit: ['«استعادت المدينة أمنها... ولو إلى حين.»', '«انكشف القناع، ونام الناس مطمئنين.»']
};
const nar = k => { const a = NARR[k]; const l = a[Math.floor(Math.random() * a.length)]; return Array.isArray(l) ? l.join('\n') : l; };

/* ===== الغرف ===== */
const rooms = new Map();
const now = () => Date.now();
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const rid = () => crypto.randomBytes(8).toString('hex');

function normCode(c) {
  c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.startsWith('MFA')) c = c.slice(3);
  return 'MFA-' + c;
}
function newCode() {
  for (let k = 0; k < 200; k++) {
    let c = 'MFA-';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no code');
}
function addPlayer(room, name) {
  const p = { id: rid(), token: crypto.randomBytes(16).toString('hex'), name, connected: false, res: null, alive: true, used: false, spent: false, vote: null, lastChat: 0 };
  room.players.push(p);
  return p;
}
function createRoom(name, max) {
  const room = {
    code: newCode(), max: Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, parseInt(max, 10) || 12)),
    status: 'lobby', hostId: null, players: [], log: [], seq: 0, touched: now(),
    phase: null, round: 0, phaseId: 0, time: 0, total: 0, hold: false, locked: false,
    roles: {}, mafiaVotes: {}, protect: null, shoot: null, muteT: null, muted: null, votes: {},
    lastDead: 0, reveal: null, winner: null, earlyDone: false
  };
  const p = addPlayer(room, name);
  room.hostId = p.id;
  rooms.set(room.code, room);
  return { room, p };
}
const byId = (room, id) => room.players.find(p => p.id === id);
const byName = (room, n) => room.players.find(p => p.name === n);
const alivePlayers = room => room.players.filter(p => p.alive);
const roleOf = (room, p) => room.roles[p.name];

/* ===== ما يراه كل لاعب: لا يُرسل دور أحد إلى غيره ===== */
function viewFor(room, p) {
  const ended = room.status === 'ended';
  const playing = room.status !== 'lobby';
  const role = playing ? room.roles[p.name] : null;
  return {
    code: room.code, status: room.status, max: room.max, round: room.round,
    phase: room.phase, phaseId: room.phaseId, time: room.time, total: room.total, hold: room.hold,
    reveal: room.reveal ? { id: room.reveal.id, k: room.reveal.k, n: room.reveal.n, l: room.reveal.l, x: room.reveal.x } : null,
    winner: room.winner, minPlayers: MIN_PLAYERS,
    me: {
      id: p.id, name: p.name, host: p.id === room.hostId, alive: p.alive, role,
      used: p.used, spent: p.spent, voted: !!p.vote,
      muted: room.phase === 'day' && room.muted === p.name,
      mates: role === 'mafia' ? room.players.filter(q => q !== p && room.roles[q.name] === 'mafia').map(q => q.name) : []
    },
    players: room.players.map(q => ({ name: q.name, alive: q.alive, online: q.connected, host: q.id === room.hostId, role: ended ? room.roles[q.name] : undefined }))
  };
}
function send(p, event, data) {
  if (!p.res) return;
  try { p.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (_) { /* انقطع الاتصال */ }
}
function broadcast(room) { room.touched = now(); room.players.forEach(p => { if (p.res) send(p, 'state', viewFor(room, p)); }); }
function pushMsg(room, m) {
  m.id = ++room.seq; room.log.push(m); if (room.log.length > 300) room.log.shift();
  room.players.forEach(p => { if (!m.to || m.to === p.id) send(p, 'msg', m); });
}
const visibleLog = (room, p) => room.log.filter(m => !m.to || m.to === p.id).slice(-150);

/* ===== مسار اللعبة ===== */
function startGame(room) {
  room.status = 'playing'; room.winner = null; room.round = 0; room.log = []; room.seq = 0;
  room.players.forEach(p => { p.alive = true; p.used = false; p.spent = false; p.vote = null; });
  room.roles = Engine.assign(room.players.map(p => p.name));
  room.players.forEach(p => send(p, 'init', { state: viewFor(room, p), log: [] }));
  startNight(room);
}
function resetRoom(room) {
  room.status = 'lobby'; room.phase = null; room.round = 0; room.roles = {}; room.winner = null; room.reveal = null; room.locked = false; room.hold = false;
  room.phaseId++; room.log = []; room.seq = 0; room.muted = null;
  room.players.forEach(p => { p.alive = true; p.used = false; p.spent = false; p.vote = null; });
  room.players.forEach(p => send(p, 'init', { state: viewFor(room, p), log: [] }));
}
function startNight(room) {
  room.round++; room.phase = 'night'; room.phaseId++; room.locked = false; room.hold = false; room.earlyDone = false;
  room.time = room.total = NIGHT_SECS; room.mafiaVotes = {}; room.protect = null; room.shoot = null; room.muteT = null; room.muted = null; room.votes = {};
  room.players.forEach(p => { p.used = false; p.vote = null; });
  pushMsg(room, { kind: 'nar', text: nar(room.round === 1 ? 'night' : 'night2') });
  alivePlayers(room).filter(p => roleOf(room, p) === 'mafia').forEach(p => {
    const mates = alivePlayers(room).filter(q => q !== p && roleOf(room, q) === 'mafia').map(q => q.name);
    if (mates.length) pushMsg(room, { kind: 'priv', text: '🔪 شركاؤك في المافيا\n' + mates.join('، '), to: p.id });
  });
  broadcast(room);
}
function startDay(room) {
  room.phase = 'day'; room.phaseId++; room.locked = false; room.hold = false; room.earlyDone = false;
  room.time = room.total = DAY_SECS; room.votes = {};
  room.players.forEach(p => { p.vote = null; });
  pushMsg(room, { kind: 'nar', text: nar(room.lastDead ? 'dayKill' : 'dayCalm') });
  const m = room.muted && byName(room, room.muted);
  if (m && m.alive) pushMsg(room, { kind: 'priv', text: '🤐 أُسكتّ طوال هذا النهار.', to: m.id });
  broadcast(room);
}
function showReveal(room, k, n, l, x, next) {
  room.revSeq = (room.revSeq || 0) + 1;
  room.reveal = { id: room.revSeq, k, n, l, x, left: REVEAL_SECS, next };
  broadcast(room);
}
function afterReveal(room) {
  const next = room.reveal && room.reveal.next; room.reveal = null;
  if (next) next();
}
function checkEnd(room) {
  const names = alivePlayers(room).map(p => p.name);
  const w = Engine.checkWin(names, room.roles);
  if (!w) return false;
  room.status = 'ended'; room.winner = w; room.phase = 'ended'; room.phaseId++; room.locked = true;
  pushMsg(room, { kind: 'sys', text: nar(w === 'mafia' ? 'winMafia' : 'winCit') });
  broadcast(room);
  return true;
}
function doNight(room) {
  if (room.locked || room.phase !== 'night' || room.status !== 'playing') return;
  room.locked = true;
  const al = alivePlayers(room).map(p => p.name);
  const res = Engine.resolveNight({ alive: al, mafiaVotes: Object.values(room.mafiaVotes), protect: room.protect, shoot: room.shoot, rnd: Math.random });
  res.dead.forEach(n => { const p = byName(room, n); if (p) p.alive = false; });
  room.lastDead = res.dead.length;
  room.muted = (room.muteT && byName(room, room.muteT) && byName(room, room.muteT).alive) ? room.muteT : null;
  const x = [];
  if (res.victim && res.dead.includes(res.victim)) x.push('🔪 المافيا ضربت من جديد.');
  if (res.shot) x.push('🔫 وأُطلقت رصاصة القناص.');
  if (!res.dead.length) x.push(res.saved ? '🩺 يدٌ خفية أنقذت الضحية.' : 'مرّت الليلة بسلام.');
  const d = res.dead;
  showReveal(room, '☀️ حلّ الصباح', d.length ? d.join(' و ') : 'لا أحد',
    d.length ? (d.length === 1 ? 'خرج من اللعبة.' : d.length === 2 ? 'خرجا من اللعبة.' : 'خرجوا من اللعبة.') : 'لم يخرج أحد من اللعبة.',
    x.join('\n'), () => { if (!checkEnd(room)) startDay(room); });
}
function doDay(room) {
  if (room.locked || room.phase !== 'day' || room.status !== 'playing') return;
  room.locked = true;
  const pid = room.phaseId;
  pushMsg(room, { kind: 'nar', text: nar('vote') });
  broadcast(room);
  setTimeout(() => {
    if (room.phaseId !== pid || room.status !== 'playing') return;
    const alive = new Set(alivePlayers(room).map(p => p.name));
    const votes = {};
    Object.keys(room.votes).forEach(v => { if (alive.has(v) && alive.has(room.votes[v])) votes[v] = room.votes[v]; });
    const r = Engine.tally(votes);
    if (!r.target) {
      showReveal(room, '🗳️ قرار المدينة', 'لا أحد', Object.keys(votes).length ? 'تعادلت الأصوات.' : 'لم يصوّت أحد.', 'لم يخرج أحد من اللعبة.', () => { if (!checkEnd(room)) startNight(room); });
      return;
    }
    const t = byName(room, r.target); t.alive = false;
    const m = room.roles[t.name] === 'mafia';
    showReveal(room, '🗳️ قرار المدينة', t.name, 'خرج من اللعبة.', m ? '🎭 كان من المافيا.' : '🎭 لم يكن من المافيا.', () => { if (!checkEnd(room)) startNight(room); });
  }, 2500);
}
function timeUp(room) { room.phase === 'night' ? doNight(room) : doDay(room); }

/* مؤقت واحد لكل الغرف: كل ثانية */
setInterval(() => {
  const t = now();
  for (const [code, room] of rooms) {
    if (t - room.touched > 6 * 3600 * 1000) { rooms.delete(code); continue; }
    if (room.status !== 'playing') continue;
    if (room.reveal) { room.reveal.left--; if (room.reveal.left <= 0) afterReveal(room); broadcast(room); continue; }
    if (!room.hold && !room.locked && room.time > 0) { room.time--; if (room.time <= 0) timeUp(room); }
    broadcast(room);
  }
}, 1000);
setInterval(() => { for (const room of rooms.values()) room.players.forEach(p => { if (p.res) { try { p.res.write(': ping\n\n'); } catch (_) { } } }); }, 15000);

/* ===== الأفعال ===== */
const ACTORS = new Set(['mafia', 'doctor', 'investigator', 'mute']);
function checkEarly(room) {
  if (room.earlyDone || room.phase !== 'night') return;
  const need = alivePlayers(room).filter(p => ACTORS.has(roleOf(room, p)));
  if (need.length && need.every(p => p.used)) { room.earlyDone = true; room.time = Math.min(room.time, SHORT_SECS); }
}
function act(room, p, body) {
  const a = body.a;
  const host = p.id === room.hostId;
  if (a === 'start') {
    if (!host) return 'host_only';
    if (room.status !== 'lobby') return 'started';
    if (room.players.length < MIN_PLAYERS) return 'min_players';
    startGame(room); return null;
  }
  if (a === 'end') {
    if (!host) return 'host_only';
    room.status = 'closed'; room.phaseId++;
    room.players.forEach(q => { if (q.res) { send(q, 'closed', {}); try { q.res.end(); } catch (_) { } q.res = null; } });
    rooms.delete(room.code);
    return null;
  }
  if (a === 'reset' || a === 'again') {
    if (!host) return 'host_only';
    if (room.status !== 'ended') return 'not_ended';
    resetRoom(room);
    if (a === 'again') { if (room.players.length < MIN_PLAYERS) return 'min_players'; startGame(room); }
    return null;
  }
  if (a === 'leave') {
    if (room.status === 'lobby') {
      if (p.res) { try { p.res.end(); } catch (_) { } p.res = null; }
      room.players = room.players.filter(q => q !== p);
      if (!room.players.length) rooms.delete(room.code);
      else { if (room.hostId === p.id) room.hostId = room.players[0].id; broadcast(room); }
    } else { p.connected = false; broadcast(room); }
    return null;
  }
  if (room.status !== 'playing') return 'not_playing';
  if (a === 'hold' || a === 'next') {
    if (!host) return 'host_only';
    if (room.reveal || room.locked) return 'busy';
    if (a === 'hold') { room.hold = !room.hold; broadcast(room); return null; }
    if (body.phaseId !== undefined && body.phaseId !== room.phaseId) return 'stale';
    room.hold = false; timeUp(room); return null;
  }
  if (a === 'chat') {
    const text = String(body.text || '').trim().slice(0, 140);
    if (!text || !p.alive || room.reveal) return 'cannot';
    if (room.phase === 'day' && room.muted === p.name) return 'muted';
    if (now() - p.lastChat < 400) return 'slow';
    p.lastChat = now();
    pushMsg(room, { kind: 'chat', who: p.name, text });
    return null;
  }
  const target = byName(room, String(body.t || ''));
  if (a === 'vote') {
    if (!p.alive || room.phase !== 'day' || room.locked || room.reveal) return 'cannot';
    if (p.vote) return 'already';
    if (!target || !target.alive || target === p) return 'bad_target';
    p.vote = target.name; room.votes[p.name] = target.name;
    pushMsg(room, { kind: 'sys', text: '🗳️ سجّلتَ صوتك ضد ' + target.name, to: p.id });
    if (alivePlayers(room).every(q => q.vote)) room.time = Math.min(room.time, 2);
    broadcast(room); return null;
  }
  if (a === 'ability') {
    if (!p.alive || room.phase !== 'night' || room.locked || room.reveal) return 'cannot';
    const r = roleOf(room, p);
    if (!target || !target.alive) return 'bad_target';
    if (r === 'mafia') {
      if (p.used) return 'already';
      if (roleOf(room, target) === 'mafia') return 'bad_target';
      room.mafiaVotes[p.id] = target.name; p.used = true;
      pushMsg(room, { kind: 'priv', text: '🔪 اخترتَ ' + target.name + '.', to: p.id });
    } else if (r === 'doctor') {
      if (p.used) return 'already';
      room.protect = target.name; p.used = true;
      pushMsg(room, { kind: 'priv', text: '🩺 ستحمي ' + target.name + ' هذه الليلة.', to: p.id });
    } else if (r === 'investigator') {
      if (p.used) return 'already';
      if (target === p) return 'bad_target';
      p.used = true;
      pushMsg(room, { kind: 'priv', text: '🔎 نتيجة التحقيق\n' + target.name + (roleOf(room, target) === 'mafia' ? ' يتصرف كأحد أفراد المافيا.' : ' يبدو بريئًا.'), to: p.id });
    } else if (r === 'mute') {
      if (p.used) return 'already';
      if (target === p) return 'bad_target';
      room.muteT = target.name; p.used = true;
      pushMsg(room, { kind: 'priv', text: '🤐 ' + target.name + ' سيبقى صامتًا طوال النهار.', to: p.id });
    } else if (r === 'sniper') {
      if (p.spent || p.used) return 'already';
      if (target === p) return 'bad_target';
      room.shoot = target.name; p.spent = true; p.used = true;
      pushMsg(room, { kind: 'priv', text: '🔫 أطلقتَ الطلقة على ' + target.name + '. لا طلقات بعدها.', to: p.id });
    } else return 'no_ability';
    checkEarly(room); broadcast(room); return null;
  }
  return 'unknown';
}

/* ===== HTTP ===== */
const INDEX = path.join(__dirname, 'index.html');
function page() {
  const body = fs.readFileSync(INDEX, 'utf8');
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}html,body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style></head><body>' + body + '</body></html>';
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise(resolve => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function auth(code, pid, token) {
  const room = rooms.get(normCode(code)); if (!room) return {};
  const p = byId(room, pid);
  if (!p || p.token !== token) return {};
  return { room, p };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(page());
    }
    if (u.pathname === '/api/ping') return json(res, 200, { ok: true, game: 'mafia' });
    if (req.method === 'POST' && u.pathname === '/api/create') {
      const b = await readBody(req); const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: 'name' });
      if (rooms.size > 500) return json(res, 503, { error: 'busy' });
      const { room, p } = createRoom(name, b.max);
      return json(res, 200, { code: room.code, pid: p.id, token: p.token, max: room.max });
    }
    if (req.method === 'POST' && u.pathname === '/api/join') {
      const b = await readBody(req); const room = rooms.get(normCode(b.code)); const name = cleanName(b.name);
      if (!room) return json(res, 404, { error: 'no_room' });
      if (!name) return json(res, 400, { error: 'name' });
      if (room.players.some(q => sameName(q.name, name))) return json(res, 409, { error: 'dup_name' });
      if (room.status !== 'lobby') return json(res, 409, { error: 'started' });
      if (room.players.length >= room.max) return json(res, 409, { error: 'full' });
      const p = addPlayer(room, name); broadcast(room);
      return json(res, 200, { code: room.code, pid: p.id, token: p.token, max: room.max });
    }
    if (req.method === 'POST' && u.pathname === '/api/act') {
      const b = await readBody(req); const { room, p } = auth(b.code, b.pid, b.token);
      if (!room) return json(res, 401, { error: 'auth' });
      const err = act(room, p, b);
      return json(res, err ? 400 : 200, err ? { error: err } : { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      const { room, p } = auth(u.searchParams.get('code'), u.searchParams.get('pid'), u.searchParams.get('token'));
      if (!room) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      if (p.res) { try { p.res.end(); } catch (_) { } }
      p.res = res; p.connected = true;
      send(p, 'init', { state: viewFor(room, p), log: visibleLog(room, p) });
      broadcast(room);
      req.on('close', () => { if (p.res === res) { p.res = null; p.connected = false; if (rooms.has(room.code)) broadcast(room); } });
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) { console.error(e); try { json(res, 500, { error: 'server' }); } catch (_) { } }
});
if (require.main === module) server.listen(PORT, () => console.log('مافيا تعمل على المنفذ ' + PORT));
module.exports = { server, rooms };

// server.js — Naruto RPG: web + đăng nhập + lưu game + multiplayer (Socket.IO)
const express = require('express'), http = require('http'), path = require('path'), fs = require('fs');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser'), cookie = require('cookie');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), cors = require('cors');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-doi-di';
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const CROSS = ORIGINS.length > 0;                       // game đặt ở domain khác (vd GitHub Pages)
const PROD = !!process.env.RENDER || process.env.NODE_ENV === 'production';
const CHARS = ['Naruto', 'Sasuke', 'Kakashi'];
if (PROD && !process.env.JWT_SECRET) console.warn('⚠ Chưa đặt JWT_SECRET trong Environment!');

/* ---------- Kho dữ liệu: MongoDB (nếu có MONGODB_URI) hoặc file JSON ---------- */
async function openDb() {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const cli = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await cli.connect();
    const d = cli.db(process.env.MONGODB_DB || 'naruto');
    const U = d.collection('users'), S = d.collection('saves');
    console.log('✔ Dùng MongoDB');
    return {
      getUser: async n => U.findOne({ _id: n }),
      createUser: async (n, hash) => { try { await U.insertOne({ _id: n, hash }); } catch (e) { throw new Error('dup'); } },
      getSave: async (n, c) => ((await S.findOne({ _id: n + ':' + c })) || {}).data || null,
      setSave: async (n, c, data) => { await S.updateOne({ _id: n + ':' + c }, { $set: { data } }, { upsert: true }); },
      delSave: async (n, c) => { await S.deleteOne({ _id: n + ':' + c }); }
    };
  }
  const file = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = { users: {}, saves: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  let t = null;
  const flush = () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(file, JSON.stringify(db), () => {}), 500); };
  console.warn('⚠ Dùng file JSON — trên Render miễn phí dữ liệu sẽ MẤT khi server khởi động lại. Hãy đặt MONGODB_URI.');
  return {
    getUser: async n => db.users[n] || null,
    createUser: async (n, hash) => { if (db.users[n]) throw new Error('dup'); db.users[n] = { hash }; flush(); },
    getSave: async (n, c) => db.saves[n + ':' + c] || null,
    setSave: async (n, c, data) => { db.saves[n + ':' + c] = data; flush(); },
    delSave: async (n, c) => { delete db.saves[n + ':' + c]; flush(); }
  };
}

/* ---------- Kiểm tra dữ liệu lưu game ---------- */
const okId = v => typeof v === 'string' && v.length <= 12;
const cleanSave = d => {
  if (!d || typeof d !== 'object') return null;
  const arr = (a, n) => Array.isArray(a) ? a.slice(0, n).map(v => okId(v) ? v : null) : [];
  return { i: arr(d.i, 300).filter(Boolean), s: arr(d.s, 6), k: okId(d.k) ? d.k : 'k0',
           a: okId(d.a) ? d.a : null, r: Math.max(0, Math.min(1e9, +d.r || 0)) };
};

(async () => {
  const app = express();
  const server = http.createServer(app);
  // Mở cổng NGAY để Render nhận ra dịch vụ, rồi mới kết nối database
  server.listen(PORT, '0.0.0.0', () => console.log('Server chạy cổng ' + PORT));
  let db = null;
  openDb().then(d => { db = d; console.log('✔ Database sẵn sàng'); })
    .catch(e => { console.error('❌ Lỗi database:', e.message); process.exit(1); });
  app.set('trust proxy', 1);
  if (CROSS) app.use(cors({ origin: ORIGINS, credentials: true }));
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  const ckOpt = { httpOnly: true, secure: PROD || CROSS, sameSite: CROSS ? 'none' : 'lax', maxAge: 30 * 864e5 };
  const userOf = req => { try { return jwt.verify(req.cookies.tk, SECRET).u; } catch (e) { return null; } };
  const login = (res, u) => res.cookie('tk', jwt.sign({ u }, SECRET, { expiresIn: '30d' }), ckOpt);
  const need = (req, res, next) => { req.user = userOf(req); req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập.' }); };
  const w = f => (q, s, n) => f(q, s, n).catch(e => { console.error(e); s.status(500).json({ error: 'Lỗi máy chủ.' }); });

  const tries = new Map();
  setInterval(() => tries.clear(), 10 * 60 * 1000);
  const limited = req => {
    const n = Date.now(), a = (tries.get(req.ip) || []).filter(t => n - t < 60000);
    a.push(n); tries.set(req.ip, a); return a.length > 10;
  };

  app.get('/health', (q, s) => s.send('ok'));

  app.post('/api/register', w(async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Thử quá nhiều lần, đợi 1 phút.' });
    const u = String((req.body || {}).username || '').trim().toLowerCase(), p = String((req.body || {}).password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return res.status(400).json({ error: 'Tên tài khoản: 3–20 ký tự a-z, 0-9, _.' });
    if (p.length < 6 || p.length > 64) return res.status(400).json({ error: 'Mật khẩu 6–64 ký tự.' });
    try { await db.createUser(u, await bcrypt.hash(p, 10)); }
    catch (e) { return res.status(409).json({ error: 'Tên tài khoản đã tồn tại.' }); }
    login(res, u); res.json({ username: u });
  }));

  app.post('/api/login', w(async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Thử quá nhiều lần, đợi 1 phút.' });
    const u = String((req.body || {}).username || '').trim().toLowerCase(), p = String((req.body || {}).password || '');
    const row = await db.getUser(u);
    if (!row || !(await bcrypt.compare(p, row.hash))) return res.status(401).json({ error: 'Sai tên tài khoản hoặc mật khẩu.' });
    login(res, u); res.json({ username: u });
  }));

  app.post('/api/logout', (req, res) => { res.clearCookie('tk', { ...ckOpt, maxAge: undefined }); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => { const u = userOf(req); res.json(u ? { loggedIn: true, username: u } : { loggedIn: false }); });

  app.get('/api/save/:char', need, w(async (req, res) => {
    if (!CHARS.includes(req.params.char)) return res.status(400).json({ error: 'Nhân vật không hợp lệ.' });
    const d = await db.getSave(req.user, req.params.char);
    d ? res.json({ data: d }) : res.status(404).json({ error: 'Chưa có dữ liệu.' });
  }));
  app.post('/api/save', need, w(async (req, res) => {
    const c = (req.body || {}).character, d = cleanSave((req.body || {}).data);
    if (!CHARS.includes(c) || !d) return res.status(400).json({ error: 'Dữ liệu không hợp lệ.' });
    await db.setSave(req.user, c, d); res.json({ ok: true });
  }));
  app.delete('/api/save/:char', need, w(async (req, res) => {
    if (!CHARS.includes(req.params.char)) return res.status(400).json({ error: 'Nhân vật không hợp lệ.' });
    await db.delSave(req.user, req.params.char); res.json({ ok: true });
  }));

  // Phục vụ chính file game (public/index.html) -> cùng domain, không lo CORS/cookie
  app.use(express.static(path.join(__dirname, 'public')));

  const io = new Server(server, { cors: CROSS ? { origin: ORIGINS, credentials: true } : undefined });
  io.use((s, next) => {
    try { s.data.user = jwt.verify(cookie.parse(s.handshake.headers.cookie || '').tk, SECRET).u; }
    catch (e) { s.data.user = null; }
    next();
  });
  require('./multiplayer')(io, { max: 60 });

})();

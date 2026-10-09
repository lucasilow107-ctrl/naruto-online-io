// multiplayer.js — gắn vào server Socket.IO sẵn có trên Render:
//   const io = new Server(httpServer, { cors: { origin: '...', credentials: true } });
//   require('./multiplayer')(io, { max: 60 });
// (Xóa handler cũ 'playerMovement' / 'updatePlayers' nếu có.)
const CHARS = ['Naruto', 'Sasuke', 'Kakashi'];
const ROOMS = ['lobby', 'world', 'raid'];
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').slice(0, 20);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0));

module.exports = function (io, opt = {}) {
  const MAX = opt.max || 60, VIEW = 2600, W = 40000, P = new Map();

  io.on('connection', s => {
    if (P.size >= MAX) {
      s.emit('server_full', 'Máy chủ đầy (' + MAX + ' người), thử lại sau.');
      return s.disconnect(true);
    }
    let sc = 0, fc = 0, t0 = Date.now();
    const ok = k => {
      const t = Date.now();
      if (t - t0 > 1000) { t0 = t; sc = 0; fc = 0; }
      return k === 's' ? ++sc <= 30 : ++fc <= 40;
    };

    s.on('join', d => {
      d = d || {};
      P.set(s.id, {
        id: s.id, name: s.data.user || ('Khach' + s.id.slice(0, 3).replace(/[^a-zA-Z0-9]/g, 'x')),
        char: CHARS.includes(d.char) ? d.char : 'Naruto',
        x: 0, y: 0, hp: 100, maxHp: 100, lvl: 1, score: 0, face: 1, room: 'lobby', dead: 0
      });
      s.join('lobby');
    });

    s.on('state', d => {
      const p = P.get(s.id);
      if (!p || !d || !ok('s')) return;
      const room = ROOMS.includes(d.room) ? d.room : 'lobby';
      if (room !== p.room) {
        s.leave(p.room);
        if (room !== 'raid') s.join(room); // raid = solo, không ai thấy
        p.room = room;
      }
      Object.assign(p, {
        x: num(d.x, 0, W), y: num(d.y, 0, W),
        hp: num(d.hp, 0, 1e6), maxHp: num(d.maxHp, 1, 1e6),
        lvl: num(d.lvl, 1, 999), score: num(d.score, 0, 1e9),
        face: d.face < 0 ? -1 : 1,
        char: CHARS.includes(d.char) ? d.char : p.char,
        dead: d.dead ? 1 : 0
      });
    });

    // Đạn: relay cho người khác trong cùng phòng, người bị bắn tự tính sát thương
    s.on('fire', a => {
      const p = P.get(s.id);
      if (!p || p.room === 'raid' || !Array.isArray(a) || !ok('f')) return;
      const out = a.slice(0, 12).map(q => Array.isArray(q) ? [
        num(q[0], 0, W), num(q[1], 0, W), num(q[2], -30, 30), num(q[3], -30, 30),
        num(q[4], 0, 250), String(q[5]).slice(0, 9), num(q[6], 2, 30),
        num(q[7], 1, 200), num(q[8], 0, 300), q[9] ? 1 : 0, String(q[10] || '').slice(0, 8)
      ] : null).filter(Boolean);
      if (out.length) s.to(p.room).emit('fire', { id: s.id, a: out });
    });

    s.on('died', d => {
      const p = P.get(s.id);
      if (!p || p.room !== 'world') return;
      const by = clean(d && d.by);
      if (by) io.to('world').emit('feed', p.name + ' bị ' + by + ' hạ gục');
    });

    s.on('disconnect', () => P.delete(s.id));
  });

  // Gửi danh sách người chơi lân cận ~15 lần/giây
  setInterval(() => {
    for (const p of P.values()) {
      if (p.room === 'raid') continue;
      const a = [];
      for (const q of P.values()) {
        if (q !== p && q.room === p.room && Math.abs(q.x - p.x) < VIEW && Math.abs(q.y - p.y) < VIEW)
          a.push({ id: q.id, name: q.name, char: q.char, x: q.x | 0, y: q.y | 0, hp: q.hp,
                   maxHp: q.maxHp, lvl: q.lvl, score: q.score, face: q.face, dead: q.dead });
      }
      io.to(p.id).emit('players', a);
    }
  }, 66);
};
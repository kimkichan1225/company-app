const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// ── PostgreSQL ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:kYzCJkFsoKyZCZFkTTZcneJoPUmoFZKt@postgres.railway.internal:5432/railway',
  ssl: false,
});

// 테이블 생성
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        colors JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        last_seen TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        nickname TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('DB 테이블 초기화 완료');
  } catch (err) {
    console.error('DB 초기화 실패:', err.message);
  }
}

// 프로필 저장/업데이트
async function saveProfile(nickname, colors) {
  try {
    await pool.query(`
      INSERT INTO profiles (id, nickname, colors, last_seen)
      VALUES ($1, $1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET colors = $2, last_seen = NOW()
    `, [nickname, JSON.stringify(colors)]);
  } catch (err) {
    console.error('프로필 저장 실패:', err.message);
  }
}

// 채팅 저장
async function saveChatMessage(nickname, message) {
  try {
    await pool.query(
      'INSERT INTO chat_history (nickname, message) VALUES ($1, $2)',
      [nickname, message]
    );
  } catch (err) {
    console.error('채팅 저장 실패:', err.message);
  }
}

// 최근 채팅 불러오기
async function getRecentChats(limit = 50) {
  try {
    const result = await pool.query(
      'SELECT nickname, message, created_at FROM chat_history ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows.reverse();
  } catch (err) {
    console.error('채팅 로드 실패:', err.message);
    return [];
  }
}

// ── 접속 중인 유저 관리 (메모리) ──
const users = new Map();

// ── 점심 메뉴 투표 시스템 (nickname 기반 — 앱 재시작/재접속에도 유지, 00시에만 초기화) ──
const MAX_MENU_SLOTS = 6;
// 메뉴: slotIndex → { name, ownerNick, ownerRealName }
const lunchMenus = new Map();
// 투표: nickname → slotIndex
const lunchVotes = new Map();
// 투표자의 실명 캐시: nickname → realName (발표 시 실명 사용)
const voterRealNames = new Map();
// 결과 발표는 하루에 한 번만 (날짜 문자열 저장)
let lastResultDate = null;
let lastResetDate = null;

function getAvailableSlot() {
  for (let i = 0; i < MAX_MENU_SLOTS; i++) {
    if (!lunchMenus.has(i)) return i;
  }
  return -1;
}

function getOwnerSlotByNick(nickname) {
  for (const [slot, m] of lunchMenus) {
    if (m.ownerNick === nickname) return slot;
  }
  return -1;
}

function buildLunchState() {
  const menus = [];
  for (const [slot, m] of lunchMenus) {
    menus.push({
      slotIndex: slot,
      name: m.name,
      ownerNick: m.ownerNick,
    });
  }
  menus.sort((a, b) => a.slotIndex - b.slotIndex);
  const votes = {};
  for (const [voterNick, slotIdx] of lunchVotes) {
    if (!votes[slotIdx]) votes[slotIdx] = [];
    votes[slotIdx].push({ voterNick });
  }
  return { menus, votes };
}

function broadcastLunchState() {
  io.emit('lunch-state', buildLunchState());
}

function resetLunch(reason = 'reset') {
  lunchMenus.clear();
  lunchVotes.clear();
  voterRealNames.clear();
  io.emit('lunch-reset', { reason });
  broadcastLunchState();
  console.log(`[점심] 초기화 (${reason})`);
}

function getRealNameForNick(nickname) {
  // 현재 접속 중인 유저 우선 → 없으면 voterRealNames 캐시 → 없으면 닉네임
  for (const u of users.values()) {
    if (u.nickname === nickname && u.realName) return u.realName;
  }
  return voterRealNames.get(nickname) || nickname;
}

function announceLunchResult() {
  // 결과 집계 (nickname 기반)
  const tally = new Map(); // slotIdx → [{voterNick, voterRealName}]
  for (const [voterNick, slotIdx] of lunchVotes) {
    if (!tally.has(slotIdx)) tally.set(slotIdx, []);
    tally.get(slotIdx).push({
      voterNick,
      voterRealName: getRealNameForNick(voterNick),
    });
  }

  const results = [];
  for (const [slot, m] of lunchMenus) {
    const voters = tally.get(slot) || [];
    results.push({
      slotIndex: slot,
      menuName: m.name,
      ownerNick: m.ownerNick,
      count: voters.length,
      voterRealNames: voters.map(v => v.voterRealName),
    });
  }
  results.sort((a, b) => b.count - a.count || a.slotIndex - b.slotIndex);

  // 미투표 유저 (현재 접속자 기준 실명)
  const votedNicks = new Set(lunchVotes.keys());
  const noVoters = [];
  for (const u of users.values()) {
    if (!votedNicks.has(u.nickname)) {
      noVoters.push(u.realName || u.nickname);
    }
  }

  const payload = {
    results,
    noVoters,
    timestamp: Date.now(),
  };
  io.emit('lunch-result', payload);
  console.log('[점심] 결과 발표:', results.map(r => `${r.menuName}(${r.count})`).join(', '));
}

// KST(Asia/Seoul) 기준 시간 얻기 (서버가 UTC라도 한국 시간으로 동작)
function getKSTParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  let h = parseInt(get('hour'), 10);
  if (h === 24) h = 0; // en-US hour12:false에서 24 반환 케이스 방어
  return {
    h,
    m: parseInt(get('minute'), 10),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

// 30초마다 KST 시간 체크
setInterval(() => {
  const { h, m, dateStr } = getKSTParts();

  // 00:00 — 초기화
  if (h === 0 && m === 0 && lastResetDate !== dateStr) {
    lastResetDate = dateStr;
    lastResultDate = null; // 새 날이니 결과 플래그도 리셋
    resetLunch('daily-00');
  }

  // 12:00 — 결과 발표
  if (h === 12 && m === 0 && lastResultDate !== dateStr) {
    lastResultDate = dateStr;
    announceLunchResult();
  }
}, 30 * 1000);

// 책상 좌석 위치 (총 20자리: 5줄 × 4자리)
const SEATS = [
  { col: 2,  row: 3,  dir: 'back' },
  { col: 3,  row: 3,  dir: 'back' },
  { col: 6,  row: 3,  dir: 'back' },
  { col: 7,  row: 3,  dir: 'back' },
  { col: 2,  row: 6,  dir: 'back' },
  { col: 3,  row: 6,  dir: 'back' },
  { col: 6,  row: 6,  dir: 'back' },
  { col: 7,  row: 6,  dir: 'back' },
  { col: 2,  row: 9,  dir: 'back' },
  { col: 3,  row: 9,  dir: 'back' },
  { col: 6,  row: 9,  dir: 'back' },
  { col: 7,  row: 9,  dir: 'back' },
  { col: 2,  row: 12, dir: 'back' },
  { col: 3,  row: 12, dir: 'back' },
  { col: 6,  row: 12, dir: 'back' },
  { col: 7,  row: 12, dir: 'back' },
  { col: 2,  row: 15, dir: 'back' },
  { col: 3,  row: 15, dir: 'back' },
  { col: 6,  row: 15, dir: 'back' },
  { col: 7,  row: 15, dir: 'back' },
];

const seatAssignments = new Map();

function assignSeat(socketId) {
  for (let i = 0; i < SEATS.length; i++) {
    if (!seatAssignments.has(i)) {
      seatAssignments.set(i, socketId);
      return i;
    }
  }
  return -1;
}

function releaseSeat(socketId) {
  for (const [idx, id] of seatAssignments) {
    if (id === socketId) {
      seatAssignments.delete(idx);
      return idx;
    }
  }
  return -1;
}

function getSeatPosition(seatIndex) {
  if (seatIndex < 0 || seatIndex >= SEATS.length) return null;
  const seat = SEATS[seatIndex];
  return { x: seat.col * 32 + 2, y: seat.row * 32 - 10, direction: seat.dir };
}

// ── Socket.io ──
io.on('connection', (socket) => {
  console.log(`접속: ${socket.id}`);

  // 유저 입장
  socket.on('join', async (data) => {
    const user = {
      id: socket.id,
      nickname: data.nickname,
      realName: data.realName || data.nickname,
      colors: data.colors,
      gender: data.gender || 'boy',
      x: data.x || 400,
      y: data.y || 300,
      direction: 'front',
      isWalking: false,
      mode: data.mode || 'rest',
      seatIndex: -1,
    };

    // 일하기 모드면 좌석 배정
    if (user.mode === 'work') {
      const idx = assignSeat(socket.id);
      user.seatIndex = idx;
      if (idx >= 0) {
        const pos = getSeatPosition(idx);
        user.x = pos.x;
        user.y = pos.y;
        user.direction = pos.direction;
        user.isWalking = false;
      }
    }

    users.set(socket.id, user);

    // 재접속: 이미 내 닉네임으로 투표한 기록이 있으면 실명 캐시 업데이트
    if (user.realName) voterRealNames.set(user.nickname, user.realName);

    // DB에 프로필 저장
    await saveProfile(data.nickname, data.colors);

    // 기존 유저 목록 전송
    socket.emit('users-list', Array.from(users.values()));

    // 최근 채팅 기록 전송
    const recentChats = await getRecentChats(30);
    socket.emit('chat-history', recentChats);

    // 현재 점심 메뉴/투표 상태 전송 (닉네임 기반이므로 재접속 시에도 내 메뉴가 복원됨)
    socket.emit('lunch-state', buildLunchState());

    // 다른 유저에게 새 유저 알림
    socket.broadcast.emit('user-joined', user);
    console.log(`입장: ${data.nickname} (${socket.id}) [${user.mode}]`);
  });

  // 점심 메뉴 등록 (1인 1개, nickname 기반)
  socket.on('menu-register', (payload) => {
    const user = users.get(socket.id);
    if (!user) return;
    const name = typeof payload === 'string' ? payload : (payload && payload.name);
    if (!name || typeof name !== 'string') return;
    const trimmed = name.trim().slice(0, 10);
    if (trimmed.length < 1) return;

    // 이미 등록한 유저면 이름만 변경 (닉네임 매칭)
    const existingSlot = getOwnerSlotByNick(user.nickname);
    if (existingSlot >= 0) {
      const m = lunchMenus.get(existingSlot);
      m.name = trimmed;
      m.ownerRealName = user.realName || user.nickname;
      broadcastLunchState();
      return;
    }

    const slot = getAvailableSlot();
    if (slot < 0) {
      socket.emit('menu-error', { message: '메뉴가 가득 찼습니다 (최대 6개)' });
      return;
    }
    lunchMenus.set(slot, {
      name: trimmed,
      ownerNick: user.nickname,
      ownerRealName: user.realName || user.nickname,
    });
    broadcastLunchState();
  });

  // 점심 메뉴 등록 취소
  socket.on('menu-unregister', () => {
    const user = users.get(socket.id);
    if (!user) return;
    const slot = getOwnerSlotByNick(user.nickname);
    if (slot < 0) return;
    lunchMenus.delete(slot);
    // 이 메뉴에 투표한 사람들의 투표도 취소
    for (const [voterNick, slotIdx] of lunchVotes) {
      if (slotIdx === slot) lunchVotes.delete(voterNick);
    }
    broadcastLunchState();
  });

  // 투표 (nickname 기반 — 앱 껐다 켜도 유지)
  socket.on('vote', (payload) => {
    const user = users.get(socket.id);
    if (!user) return;
    const slotIdx = typeof payload === 'number' ? payload : (payload && payload.slotIndex);
    if (typeof slotIdx !== 'number') return;
    if (!lunchMenus.has(slotIdx)) return;
    lunchVotes.set(user.nickname, slotIdx);
    if (user.realName) voterRealNames.set(user.nickname, user.realName);
    broadcastLunchState();
  });

  // 투표 취소
  socket.on('vote-cancel', () => {
    const user = users.get(socket.id);
    if (!user) return;
    if (lunchVotes.delete(user.nickname)) broadcastLunchState();
  });

  // 위치 업데이트
  socket.on('move', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    user.x = data.x;
    user.y = data.y;
    user.direction = data.direction;
    user.isWalking = data.isWalking;
    socket.broadcast.emit('user-moved', {
      id: socket.id,
      x: data.x,
      y: data.y,
      direction: data.direction,
      isWalking: data.isWalking,
    });
  });

  // 모드 변경 (payload: 'work' | 'rest' | { mode, seatIndex? })
  socket.on('mode-change', (payload) => {
    const user = users.get(socket.id);
    if (!user) return;

    const mode = typeof payload === 'string' ? payload : (payload && payload.mode);
    const requestedSeat = (payload && typeof payload === 'object') ? payload.seatIndex : null;
    if (mode !== 'work' && mode !== 'rest') return;

    releaseSeat(socket.id);
    user.seatIndex = -1;
    user.mode = mode;

    if (mode === 'work') {
      let idx = -1;
      if (typeof requestedSeat === 'number' && requestedSeat >= 0 &&
          requestedSeat < SEATS.length && !seatAssignments.has(requestedSeat)) {
        seatAssignments.set(requestedSeat, socket.id);
        idx = requestedSeat;
      } else {
        idx = assignSeat(socket.id);
      }
      user.seatIndex = idx;
      if (idx >= 0) {
        const pos = getSeatPosition(idx);
        user.x = pos.x;
        user.y = pos.y;
        user.direction = pos.direction;
        user.isWalking = false;
      }
    }

    io.emit('user-mode-changed', {
      id: socket.id,
      mode,
      seatIndex: user.seatIndex,
      x: user.x,
      y: user.y,
      direction: user.direction,
    });
  });

  // 유저 목록 재요청 (rest 재진입 시)
  socket.on('request-users', () => {
    socket.emit('users-list', Array.from(users.values()));
    socket.emit('lunch-state', buildLunchState());
  });

  // 채팅
  socket.on('chat', async (message) => {
    const user = users.get(socket.id);
    if (!user) return;

    // DB에 저장
    await saveChatMessage(user.nickname, message);

    io.emit('chat-message', {
      id: socket.id,
      nickname: user.nickname,
      message,
      timestamp: Date.now(),
    });
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`퇴장: ${user.nickname} (${socket.id})`);
      // 실명 캐시는 보존 (결과 발표 시 사용)
      if (user.realName) voterRealNames.set(user.nickname, user.realName);
      releaseSeat(socket.id);
      io.emit('user-left', socket.id);
    }
    users.delete(socket.id);
    // ※ 점심 메뉴/투표는 삭제하지 않음 — nickname 기반으로 유지되어 재접속 시 복원됨.
    //    매일 00시(KST)에만 resetLunch()로 초기화.
  });
});

// 서버 시작
const PORT = process.env.PORT || 3456;
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`FitCharacter 서버 실행 중: http://localhost:${PORT}`);
  });
});

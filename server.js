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
    // 기존 테이블에 type 컬럼 추가 (시스템 메시지 구분용)
    await pool.query(`
      ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'user'
    `);
    // 점심 관련 메타데이터 (lastResultDate 등)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lunch_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    // 점심 메뉴 (slot 단위로 저장, 하루 단위로 reset)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lunch_menus (
        slot_index INT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_nick TEXT NOT NULL,
        owner_real_name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // 점심 투표 (voter_nick이 PK — 1인 1투표)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lunch_votes (
        voter_nick TEXT PRIMARY KEY,
        voter_real_name TEXT,
        slot_index INT NOT NULL,
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
async function saveChatMessage(nickname, message, type = 'user') {
  try {
    await pool.query(
      'INSERT INTO chat_history (nickname, message, type) VALUES ($1, $2, $3)',
      [nickname, message, type]
    );
  } catch (err) {
    console.error('채팅 저장 실패:', err.message);
  }
}

// 최근 채팅 불러오기
async function getRecentChats(limit = 50) {
  try {
    const result = await pool.query(
      'SELECT nickname, message, type, created_at FROM chat_history ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows.reverse();
  } catch (err) {
    console.error('채팅 로드 실패:', err.message);
    return [];
  }
}

// 점심 메타 (lastResultDate 등)
async function getMeta(key) {
  try {
    const r = await pool.query('SELECT value FROM lunch_meta WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
  } catch (err) { return null; }
}

async function setMeta(key, value) {
  try {
    await pool.query(`
      INSERT INTO lunch_meta (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2
    `, [key, value]);
  } catch (err) { console.error('meta 저장 실패:', err.message); }
}

// ── 점심 메뉴/투표 DB 헬퍼 ──
async function dbUpsertMenu(slot, name, ownerNick, ownerRealName) {
  try {
    await pool.query(`
      INSERT INTO lunch_menus (slot_index, name, owner_nick, owner_real_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (slot_index) DO UPDATE SET name = $2, owner_nick = $3, owner_real_name = $4
    `, [slot, name, ownerNick, ownerRealName]);
  } catch (err) { console.error('메뉴 저장 실패:', err.message); }
}

async function dbDeleteMenu(slot) {
  try {
    await pool.query('DELETE FROM lunch_menus WHERE slot_index = $1', [slot]);
  } catch (err) { console.error('메뉴 삭제 실패:', err.message); }
}

async function dbUpsertVote(voterNick, voterRealName, slotIdx) {
  try {
    await pool.query(`
      INSERT INTO lunch_votes (voter_nick, voter_real_name, slot_index)
      VALUES ($1, $2, $3)
      ON CONFLICT (voter_nick) DO UPDATE SET voter_real_name = $2, slot_index = $3, created_at = NOW()
    `, [voterNick, voterRealName, slotIdx]);
  } catch (err) { console.error('투표 저장 실패:', err.message); }
}

async function dbDeleteVote(voterNick) {
  try {
    await pool.query('DELETE FROM lunch_votes WHERE voter_nick = $1', [voterNick]);
  } catch (err) { console.error('투표 삭제 실패:', err.message); }
}

async function dbDeleteVotesBySlot(slotIdx) {
  try {
    await pool.query('DELETE FROM lunch_votes WHERE slot_index = $1', [slotIdx]);
  } catch (err) { console.error('슬롯 투표 삭제 실패:', err.message); }
}

async function dbClearLunch() {
  try {
    await pool.query('DELETE FROM lunch_menus');
    await pool.query('DELETE FROM lunch_votes');
  } catch (err) { console.error('점심 데이터 초기화 실패:', err.message); }
}

// 서버 시작 시 DB에서 메뉴/투표 복원 (자정 넘었으면 폐기)
async function loadLunchFromDB() {
  try {
    const { dateStr: todayKST } = getKSTParts();
    // 오늘(KST) 생성된 데이터만 로드. 이전 날 데이터는 DB에서 정리.
    const menuRes = await pool.query(`
      SELECT slot_index, name, owner_nick, owner_real_name, created_at
      FROM lunch_menus
    `);
    let staleFound = false;
    for (const row of menuRes.rows) {
      const rowDate = formatKSTDate(row.created_at);
      if (rowDate !== todayKST) { staleFound = true; continue; }
      lunchMenus.set(row.slot_index, {
        name: row.name,
        ownerNick: row.owner_nick,
        ownerRealName: row.owner_real_name,
      });
    }
    const voteRes = await pool.query(`
      SELECT voter_nick, voter_real_name, slot_index, created_at
      FROM lunch_votes
    `);
    for (const row of voteRes.rows) {
      const rowDate = formatKSTDate(row.created_at);
      if (rowDate !== todayKST) { staleFound = true; continue; }
      // 메뉴가 이미 폐기된 슬롯에 대한 투표면 스킵
      if (!lunchMenus.has(row.slot_index)) continue;
      lunchVotes.set(row.voter_nick, row.slot_index);
      if (row.voter_real_name) voterRealNames.set(row.voter_nick, row.voter_real_name);
    }
    // 어제 이전 데이터 정리
    if (staleFound) {
      await pool.query(`
        DELETE FROM lunch_menus WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date < (NOW() AT TIME ZONE 'Asia/Seoul')::date
      `);
      await pool.query(`
        DELETE FROM lunch_votes WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date < (NOW() AT TIME ZONE 'Asia/Seoul')::date
      `);
    }
    console.log(`[점심] DB에서 복원: 메뉴 ${lunchMenus.size}개, 투표 ${lunchVotes.size}개`);
  } catch (err) {
    console.error('점심 데이터 로드 실패:', err.message);
  }
}

function formatKSTDate(dt) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(dt));
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

async function resetLunch(reason = 'reset') {
  lunchMenus.clear();
  lunchVotes.clear();
  voterRealNames.clear();
  await dbClearLunch();
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

async function announceLunchResult() {
  // 중복 발표 방지 (오늘 이미 발표했으면 skip)
  const { dateStr } = getKSTParts();
  if (lastResultDate === dateStr) return;
  lastResultDate = dateStr;
  await setMeta('last_result_date', dateStr);

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

  // 채팅 히스토리 DB에 저장 (나중에 접속한 사람도 확인 가능)
  const lines = ['━━━━━━━━━━━━━━━', '🍚 점심 투표 결과 발표 (12:00)'];
  if (results.length === 0 || results.every(r => r.count === 0)) {
    lines.push('(투표한 사람이 없습니다)');
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    results.forEach((r, idx) => {
      if (r.count === 0) return;
      const prefix = medals[idx] || '・';
      const names = (r.voterRealNames || []).join(', ');
      lines.push(`${prefix} ${r.menuName} (${r.count}표): ${names}`);
    });
  }
  if (noVoters.length > 0) {
    lines.push(`미투표: ${noVoters.join(', ')}`);
  }
  lines.push('━━━━━━━━━━━━━━━');
  for (const line of lines) {
    await saveChatMessage('__system__', line, 'system');
  }
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
setInterval(async () => {
  const { h, dateStr } = getKSTParts();

  // 자정 이후 첫 체크에 초기화 (놓쳐도 복구)
  if (lastResetDate !== dateStr) {
    lastResetDate = dateStr;
    lastResultDate = null; // 새 날이니 결과 플래그도 리셋
    await setMeta('last_reset_date', dateStr);
    await setMeta('last_result_date', '');
    await resetLunch('daily-00');
  }

  // 12시 이후이고 오늘 아직 발표 안 했으면 발표 (놓쳐도 복구)
  if (h >= 12 && lastResultDate !== dateStr) {
    await announceLunchResult();
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

    // 12시 이후인데 오늘 아직 발표 안 했으면 지금 발표 (채팅 히스토리 보내기 전에)
    const { h: nowH, dateStr: nowDate } = getKSTParts();
    if (nowH >= 12 && lastResultDate !== nowDate) {
      await announceLunchResult();
    }

    // 최근 채팅 기록 전송 (결과 발표 이후라 방금 저장한 결과도 포함됨)
    const recentChats = await getRecentChats(30);
    socket.emit('chat-history', recentChats);

    // 현재 점심 메뉴/투표 상태 전송 (닉네임 기반이므로 재접속 시에도 내 메뉴가 복원됨)
    socket.emit('lunch-state', buildLunchState());

    // 다른 유저에게 새 유저 알림
    socket.broadcast.emit('user-joined', user);
    console.log(`입장: ${data.nickname} (${socket.id}) [${user.mode}]`);
  });

  // 점심 메뉴 등록 (1인 1개, nickname 기반)
  socket.on('menu-register', async (payload) => {
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
      await dbUpsertMenu(existingSlot, m.name, m.ownerNick, m.ownerRealName);
      broadcastLunchState();
      return;
    }

    const slot = getAvailableSlot();
    if (slot < 0) {
      socket.emit('menu-error', { message: '메뉴가 가득 찼습니다 (최대 6개)' });
      return;
    }
    const ownerRealName = user.realName || user.nickname;
    lunchMenus.set(slot, {
      name: trimmed,
      ownerNick: user.nickname,
      ownerRealName,
    });
    await dbUpsertMenu(slot, trimmed, user.nickname, ownerRealName);
    broadcastLunchState();
  });

  // 점심 메뉴 등록 취소
  socket.on('menu-unregister', async () => {
    const user = users.get(socket.id);
    if (!user) return;
    const slot = getOwnerSlotByNick(user.nickname);
    if (slot < 0) return;
    lunchMenus.delete(slot);
    // 이 메뉴에 투표한 사람들의 투표도 취소
    for (const [voterNick, slotIdx] of lunchVotes) {
      if (slotIdx === slot) lunchVotes.delete(voterNick);
    }
    await dbDeleteMenu(slot);
    await dbDeleteVotesBySlot(slot);
    broadcastLunchState();
  });

  // 투표 (nickname 기반 — 앱 껐다 켜도 유지)
  socket.on('vote', async (payload) => {
    const user = users.get(socket.id);
    if (!user) return;
    const slotIdx = typeof payload === 'number' ? payload : (payload && payload.slotIndex);
    if (typeof slotIdx !== 'number') return;
    if (!lunchMenus.has(slotIdx)) return;
    lunchVotes.set(user.nickname, slotIdx);
    if (user.realName) voterRealNames.set(user.nickname, user.realName);
    await dbUpsertVote(user.nickname, user.realName || user.nickname, slotIdx);
    broadcastLunchState();
  });

  // 투표 취소
  socket.on('vote-cancel', async () => {
    const user = users.get(socket.id);
    if (!user) return;
    if (lunchVotes.delete(user.nickname)) {
      await dbDeleteVote(user.nickname);
      broadcastLunchState();
    }
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
  socket.on('request-users', async () => {
    // rest 재진입 시에도 발표 체크 (서버가 슬립 중 12시를 놓쳤을 수 있음)
    const { h: nowH, dateStr: nowDate } = getKSTParts();
    if (nowH >= 12 && lastResultDate !== nowDate) {
      await announceLunchResult();
    }
    socket.emit('users-list', Array.from(users.values()));
    socket.emit('lunch-state', buildLunchState());
    // 채팅 히스토리 재전송 (work → rest 전환 시 누락 방지)
    const recentChats = await getRecentChats(30);
    socket.emit('chat-history', recentChats);
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
async function loadMetaFromDB() {
  lastResultDate = await getMeta('last_result_date') || null;
  lastResetDate = await getMeta('last_reset_date') || null;
  console.log(`[점심] meta 복원: lastResultDate=${lastResultDate}, lastResetDate=${lastResetDate}`);
}

const PORT = process.env.PORT || 3456;
initDB()
  .then(loadMetaFromDB)
  .then(loadLunchFromDB)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`FitCharacter 서버 실행 중: http://localhost:${PORT}`);
    });
  });

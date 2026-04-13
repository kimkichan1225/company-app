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

// 책상 좌석 위치
const SEATS = [
  { col: 2,  row: 4,  dir: 'back' },
  { col: 3,  row: 4,  dir: 'back' },
  { col: 6,  row: 4,  dir: 'back' },
  { col: 7,  row: 4,  dir: 'back' },
  { col: 2,  row: 8,  dir: 'back' },
  { col: 3,  row: 8,  dir: 'back' },
  { col: 6,  row: 8,  dir: 'back' },
  { col: 7,  row: 8,  dir: 'back' },
  { col: 2,  row: 13, dir: 'back' },
  { col: 3,  row: 13, dir: 'back' },
  { col: 6,  row: 13, dir: 'back' },
  { col: 7,  row: 13, dir: 'back' },
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
      colors: data.colors,
      x: data.x || 400,
      y: data.y || 300,
      direction: 'front',
      isWalking: false,
      mode: data.mode || 'rest',
      status: data.status || '휴식 중',
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

    // DB에 프로필 저장
    await saveProfile(data.nickname, data.colors);

    // 기존 유저 목록 전송
    socket.emit('users-list', Array.from(users.values()));

    // 최근 채팅 기록 전송
    const recentChats = await getRecentChats(30);
    socket.emit('chat-history', recentChats);

    // 다른 유저에게 새 유저 알림
    socket.broadcast.emit('user-joined', user);
    console.log(`입장: ${data.nickname} (${socket.id}) [${user.mode}]`);
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

  // 모드 변경
  socket.on('mode-change', (mode) => {
    const user = users.get(socket.id);
    if (!user) return;

    releaseSeat(socket.id);
    user.seatIndex = -1;
    user.mode = mode;

    if (mode === 'work') {
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

    io.emit('user-mode-changed', {
      id: socket.id,
      mode,
      seatIndex: user.seatIndex,
      x: user.x,
      y: user.y,
      direction: user.direction,
    });
  });

  // 상태 변경
  socket.on('status-change', (status) => {
    const user = users.get(socket.id);
    if (!user) return;
    user.status = status;
    io.emit('user-status-changed', {
      id: socket.id,
      nickname: user.nickname,
      status,
    });
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
      releaseSeat(socket.id);
      io.emit('user-left', socket.id);
    }
    users.delete(socket.id);
  });
});

// 서버 시작
const PORT = process.env.PORT || 3456;
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`FitCharacter 서버 실행 중: http://localhost:${PORT}`);
  });
});

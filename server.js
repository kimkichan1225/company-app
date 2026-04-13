const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// 접속 중인 유저 관리
const users = new Map();

// 책상 좌석 위치 (의자 타일의 맵 좌표 → 픽셀 좌표)
// 맵에서 의자(CHAIR) 위치: 각 책상 아래 의자
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

// 좌석 사용 현황 (seatIndex → socketId)
const seatAssignments = new Map();

function assignSeat(socketId) {
  for (let i = 0; i < SEATS.length; i++) {
    if (!seatAssignments.has(i)) {
      seatAssignments.set(i, socketId);
      return i;
    }
  }
  return -1; // 빈 좌석 없음
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

io.on('connection', (socket) => {
  console.log(`접속: ${socket.id}`);

  // 유저 입장 (프로필 + 초기 위치)
  socket.on('join', (data) => {
    const user = {
      id: socket.id,
      nickname: data.nickname,
      colors: data.colors,
      x: data.x || 400,
      y: data.y || 300,
      direction: 'front',
      isWalking: false,
      mode: data.mode || 'rest',  // work 또는 rest
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

    // 좌석 정보 포함하여 전송
    socket.emit('users-list', Array.from(users.values()));
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

    // 기존 좌석 해제
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

  // 채팅
  socket.on('chat', (message) => {
    const user = users.get(socket.id);
    if (!user) return;
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

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`FitCharacter 서버 실행 중: http://localhost:${PORT}`);
});

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
    };
    users.set(socket.id, user);

    // 기존 유저 목록 전송
    socket.emit('users-list', Array.from(users.values()));

    // 다른 유저에게 새 유저 알림
    socket.broadcast.emit('user-joined', user);
    console.log(`입장: ${data.nickname} (${socket.id})`);
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
      io.emit('user-left', socket.id);
    }
    users.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`FitCharacter 서버 실행 중: http://localhost:${PORT}`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── 방 관리 ──
const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(4).toString('hex');
}

function serializeRoom(room) {
  const participants = [];
  for (const [id, p] of room.participants) {
    participants.push({ userId: id, userName: p.userName, avatar: p.avatar, isHost: p.isHost });
  }
  return {
    id: room.id,
    title: room.title,
    hostId: room.hostId,
    duration: room.duration,
    meetingStarted: room.meetingStarted,
    meetingStartTime: room.meetingStartTime,
    participants
  };
}

// REST: 방 정보 조회
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.json({ error: '존재하지 않는 방입니다.' });
  res.json({ room: serializeRoom(room) });
});

io.on('connection', (socket) => {
  console.log('[접속]', socket.id);

  // 방 생성
  socket.on('create-room', (data) => {
    try {
      const roomId = generateRoomId();
      const room = {
        id: roomId,
        title: data.title || '제목 없는 회의',
        hostId: socket.id,
        duration: Math.min(Math.max(data.duration || 30, 1), 59),
        meetingStarted: false,
        meetingStartTime: null,
        participants: new Map()
      };

      room.participants.set(socket.id, {
        userName: data.userName,
        avatar: data.avatar,
        isHost: true
      });

      rooms.set(roomId, room);
      socket.join(roomId);
      socket.roomId = roomId;
      socket.userName = data.userName;
      socket.avatar = data.avatar;

      console.log('[방 생성]', data.userName, '→', room.title, '(' + roomId + ')');
      socket.emit('room-created', { roomId: roomId, room: serializeRoom(room) });
    } catch (err) {
      console.error('[create-room 에러]', err);
      socket.emit('room-created', { error: err.message });
    }
  });

  // 방 참가
  socket.on('join-room', (data) => {
    try {
      const room = rooms.get(data.roomId);
      if (!room) {
        socket.emit('room-joined', { error: '존재하지 않는 방입니다.' });
        return;
      }

      socket.join(data.roomId);
      socket.roomId = data.roomId;
      socket.userName = data.userName;
      socket.avatar = data.avatar;

      room.participants.set(socket.id, {
        userName: data.userName,
        avatar: data.avatar,
        isHost: false
      });

      // 기존 참가자들에게 알림
      socket.to(data.roomId).emit('user-joined', {
        userId: socket.id,
        userName: data.userName,
        avatar: data.avatar
      });

      // 기존 참가자 목록
      const existingUsers = [];
      for (const [id, p] of room.participants) {
        if (id !== socket.id) {
          existingUsers.push({ userId: id, userName: p.userName, avatar: p.avatar, isHost: p.isHost });
        }
      }

      console.log('[입장]', data.userName, '→', room.title, '(' + room.participants.size + '명)');
      socket.emit('room-joined', { room: serializeRoom(room), existingUsers: existingUsers });
    } catch (err) {
      console.error('[join-room 에러]', err);
      socket.emit('room-joined', { error: err.message });
    }
  });

  // 회의 시작 (방장만)
  socket.on('start-meeting', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;

    room.meetingStarted = true;
    room.meetingStartTime = Date.now();

    io.to(socket.roomId).emit('meeting-started', {
      startTime: room.meetingStartTime,
      duration: room.duration
    });

    console.log('[회의 시작]', room.title, '(' + room.duration + '분)');
  });

  // WebRTC 시그널링
  socket.on('offer', (data) => {
    socket.to(data.to).emit('offer', { from: socket.id, offer: data.offer });
  });

  socket.on('answer', (data) => {
    socket.to(data.to).emit('answer', { from: socket.id, answer: data.answer });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.to).emit('ice-candidate', { from: socket.id, candidate: data.candidate });
  });

  // 마이크 셧다운 브로드캐스트
  socket.on('mic-shutdown', () => {
    socket.to(socket.roomId).emit('user-mic-shutdown', {
      userId: socket.id,
      userName: socket.userName
    });
  });

  socket.on('mic-restored', () => {
    socket.to(socket.roomId).emit('user-mic-restored', { userId: socket.id });
  });

  socket.on('speaking-state', (isSpeaking) => {
    socket.to(socket.roomId).emit('user-speaking-state', {
      userId: socket.id,
      isSpeaking: isSpeaking
    });
  });

  // 마이크 ON/OFF 토글 브로드캐스트
  socket.on('mic-toggle', (micOn) => {
    socket.to(socket.roomId).emit('user-mic-toggle', {
      userId: socket.id,
      micOn: micOn
    });
  });

  // 연결 해제
  socket.on('disconnect', () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      room.participants.delete(socket.id);
      socket.to(socket.roomId).emit('user-left', { userId: socket.id });

      if (room.participants.size === 0) {
        rooms.delete(socket.roomId);
        console.log('[방 삭제]', room.title);
      }
    }
    console.log('[퇴장]', socket.userName || socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n🤐 2분만 서버 실행 중: http://localhost:' + PORT + '\n');
});

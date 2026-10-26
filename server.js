const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const rooms = new Map();

function genCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function newRoom(code) {
  return {
    code,
    players: { X: null, O: null },
    board: Array(9).fill(''),
    turn: 'X',
    starter: 'X',
    status: 'waiting', // waiting | playing | over
    winner: null,
    line: null,
  };
}

function playerCount(room) {
  return (room.players.X ? 1 : 0) + (room.players.O ? 1 : 0);
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  for (const symbol of ['X', 'O']) {
    const ws = room.players[symbol];
    if (!ws) continue;
    sendTo(ws, {
      type: 'state',
      room: room.code,
      you: symbol,
      board: room.board,
      turn: room.turn,
      status: room.status,
      winner: room.winner,
      line: room.line,
    });
  }
}

function checkResult(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line };
    }
  }
  if (board.every((cell) => cell)) return { winner: null, line: null, draw: true };
  return null;
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  if (room.players[ws.symbol] === ws) room.players[ws.symbol] = null;
  ws.room = null;
  ws.symbol = null;

  if (playerCount(room) === 0) {
    rooms.delete(room.code);
    return;
  }
  // 한 명만 남으면 대기 상태로 (진행 중이던 판은 보존, 끝난 판은 그대로 유지)
  if (room.status === 'playing') room.status = 'waiting';
  broadcast(room);
}

function seat(ws, room) {
  const symbol = room.players.X ? 'O' : 'X';
  room.players[symbol] = ws;
  ws.room = room;
  ws.symbol = symbol;
  if (room.status === 'waiting' && playerCount(room) === 2) room.status = 'playing';
  broadcast(room);
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      leaveRoom(ws);
      const room = newRoom(genCode());
      rooms.set(room.code, room);
      seat(ws, room);
      break;
    }
    case 'join': {
      const code = String(msg.room || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendTo(ws, { type: 'error', code: 'NO_ROOM', message: '방을 찾을 수 없습니다' });
        return;
      }
      if (ws.room === room) {
        broadcast(room);
        return;
      }
      if (playerCount(room) >= 2) {
        sendTo(ws, { type: 'error', code: 'FULL', message: '방이 가득 찼습니다' });
        return;
      }
      leaveRoom(ws);
      seat(ws, room);
      break;
    }
    case 'move': {
      const room = ws.room;
      if (!room || room.status !== 'playing') return;
      const idx = msg.idx;
      if (!Number.isInteger(idx) || idx < 0 || idx > 8) return;
      if (room.turn !== ws.symbol || room.board[idx]) return;
      room.board[idx] = ws.symbol;
      const result = checkResult(room.board);
      if (result) {
        room.status = 'over';
        room.winner = result.winner;
        room.line = result.line;
      } else {
        room.turn = ws.symbol === 'X' ? 'O' : 'X';
      }
      broadcast(room);
      break;
    }
    case 'restart': {
      const room = ws.room;
      if (!room || room.status !== 'over') return;
      room.board = Array(9).fill('');
      room.starter = room.starter === 'X' ? 'O' : 'X';
      room.turn = room.starter;
      room.winner = null;
      room.line = null;
      room.status = playerCount(room) === 2 ? 'playing' : 'waiting';
      broadcast(room);
      break;
    }
    case 'leave': {
      leaveRoom(ws);
      sendTo(ws, { type: 'left' });
      break;
    }
    default:
      break;
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
});

const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.symbol = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    handleMessage(ws, msg);
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

// 끊어진 연결 정리 + 무료 호스팅의 유휴 연결 끊김 방지
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`relay server listening on :${PORT}`);
});

module.exports = { server, wss };

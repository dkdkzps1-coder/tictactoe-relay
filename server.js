const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ─────────────────────────────────────────────
// 게임 규칙 모음
//  - cells: 판의 칸 수 (칸 기반 게임만. 알까기는 0)
//  - check(board, idx, symbol): 방금 둔 수 이후의 결과를 돌려줌
//      승리  → { winner: symbol, line: [칸 번호들] }
//      무승부 → { winner: null, line: null }
//      계속  → null
// 새 게임을 추가하려면 여기에 항목 하나만 더 넣으면 됩니다.
// ─────────────────────────────────────────────
const TTT_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const OMOK_N = 15;
const OMOK_DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// ── 알까기(물리) 설정 ──
const A_B = 300; // 판 한 변 길이
const A_R = 12; // 알 반지름
const A_MAXV = 9; // 한 번에 낼 수 있는 최대 속도 (1/60초당 이동 거리)
const A_FRICTION = 0.982; // 1/60초마다 속도에 곱해지는 값 (마찰)
const A_STOP = 0.08; // 이보다 느리면 멈춤
const A_E = 0.9; // 반발 계수 (알끼리 부딪힐 때)
const A_MAX_STEPS = 600; // 최대 시뮬레이션 길이 (10초)
const A_SAMPLE = 2; // 2스텝마다 한 프레임 저장 → 30fps
const A_FPS = 60 / A_SAMPLE;

const GAMES = {
  tictactoe: {
    cells: 9,
    check(board) {
      for (const [a, b, c] of TTT_LINES) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
          return { winner: board[a], line: [a, b, c] };
        }
      }
      if (board.every((cell) => cell)) return { winner: null, line: null };
      return null;
    },
  },

  // 오목: 15x15, 가로/세로/대각선으로 5개 이상 이어지면 승리 (자유룰, 금수 없음)
  // X = 흑(선공), O = 백
  omok: {
    cells: OMOK_N * OMOK_N,
    check(board, idx, symbol) {
      const r = Math.floor(idx / OMOK_N);
      const c = idx % OMOK_N;
      for (const [dr, dc] of OMOK_DIRS) {
        const line = [idx];
        for (const step of [1, -1]) {
          let rr = r + dr * step;
          let cc = c + dc * step;
          while (
            rr >= 0 && rr < OMOK_N && cc >= 0 && cc < OMOK_N &&
            board[rr * OMOK_N + cc] === symbol
          ) {
            line.push(rr * OMOK_N + cc);
            rr += dr * step;
            cc += dc * step;
          }
        }
        if (line.length >= 5) return { winner: symbol, line: line.sort((a, b) => a - b) };
      }
      if (board.every((cell) => cell)) return { winner: null, line: null };
      return null;
    },
  },

  // 알까기: 번갈아 알을 하나씩 튕겨서 상대 알을 판 밖으로 내보내면 승리
  // 규칙 판정은 아래 shoot 처리에서 함 (칸 기반이 아니라 check는 쓰지 않음)
  alkkagi: {
    cells: 0,
    check() {
      return null;
    },
  },
};

// ─────────────────────────────────────────────
// 알까기 물리
// ─────────────────────────────────────────────
const round1 = (v) => Math.round(v * 10) / 10;

function layoutStones(n) {
  const stones = [];
  for (const o of ['X', 'O']) {
    for (let k = 0; k < n; k++) {
      stones.push({
        id: stones.length,
        o,
        x: round1((A_B * (k + 1)) / (n + 1)),
        y: o === 'X' ? A_B * 0.8 : A_B * 0.2,
        alive: true,
      });
    }
  }
  return stones;
}

// 한 번 튕긴 결과를 끝까지 계산해서 돌려준다.
//  frames: 30fps로 저장한 모든 알의 위치 [x0,y0,x1,y1,...] 배열들
//  hits:   알끼리 부딪힌 순간 { f(프레임 번호), x, y, p(세기 0~1) }
//  fell:   판 밖으로 떨어진 알 { i(알 번호), f }
function simulate(stones, shooterId, vx, vy) {
  const s = stones.map((st) => ({
    id: st.id, o: st.o, x: st.x, y: st.y, alive: st.alive, vx: 0, vy: 0,
  }));
  s[shooterId].vx = vx;
  s[shooterId].vy = vy;

  const snap = () => {
    const f = [];
    for (const st of s) f.push(round1(st.x), round1(st.y));
    return f;
  };
  const frames = [snap()];
  const hits = [];
  const fell = [];
  const D = 2 * A_R;
  let step = 0;

  while (step < A_MAX_STEPS) {
    step++;

    for (const st of s) {
      if (!st.alive) continue;
      st.x += st.vx;
      st.y += st.vy;
      st.vx *= A_FRICTION;
      st.vy *= A_FRICTION;
      if (Math.hypot(st.vx, st.vy) < A_STOP) {
        st.vx = 0;
        st.vy = 0;
      }
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < s.length; a++) {
        const A = s[a];
        if (!A.alive) continue;
        for (let b = a + 1; b < s.length; b++) {
          const Bs = s[b];
          if (!Bs.alive) continue;
          const dx = Bs.x - A.x;
          const dy = Bs.y - A.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= D * D) continue;
          let d = Math.sqrt(d2);
          let nx = 1;
          let ny = 0;
          if (d > 1e-6) {
            nx = dx / d;
            ny = dy / d;
          } else {
            d = 0;
          }
          // 겹친 만큼 서로 밀어내기
          const push = (D - d) / 2;
          A.x -= nx * push;
          A.y -= ny * push;
          Bs.x += nx * push;
          Bs.y += ny * push;
          // 같은 질량의 탄성 충돌
          const rv = (A.vx - Bs.vx) * nx + (A.vy - Bs.vy) * ny;
          if (rv > 0) {
            const j = ((1 + A_E) / 2) * rv;
            A.vx -= j * nx;
            A.vy -= j * ny;
            Bs.vx += j * nx;
            Bs.vy += j * ny;
            if (j > 0.5) {
              hits.push({
                f: round1(step / A_SAMPLE),
                x: round1((A.x + Bs.x) / 2),
                y: round1((A.y + Bs.y) / 2),
                p: Math.round(Math.min(1, j / 6) * 100) / 100,
              });
            }
          }
        }
      }
    }

    // 알의 중심이 판 밖으로 나가면 떨어진 것
    let moving = false;
    for (const st of s) {
      if (!st.alive) continue;
      if (st.x < 0 || st.x > A_B || st.y < 0 || st.y > A_B) {
        st.alive = false;
        st.vx = 0;
        st.vy = 0;
        fell.push({ i: st.id, f: round1(step / A_SAMPLE) });
      } else if (st.vx !== 0 || st.vy !== 0) {
        moving = true;
      }
    }

    if (step % A_SAMPLE === 0) frames.push(snap());
    if (!moving) break;
  }
  if (step % A_SAMPLE !== 0) frames.push(snap());

  const result = s.map((st) => ({
    id: st.id, o: st.o, x: round1(st.x), y: round1(st.y), alive: st.alive,
  }));
  return { stones: result, anim: { frames, hits, fell, fps: A_FPS } };
}

// ─────────────────────────────────────────────
// 방 관리
// ─────────────────────────────────────────────
const rooms = new Map();

function genCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function resetBoard(room) {
  room.board = Array(GAMES[room.game].cells).fill('');
  room.stones = room.game === 'alkkagi' ? layoutStones(room.options.stones) : null;
  room.busyUntil = 0;
}

function newRoom(code, game, options) {
  const room = {
    code,
    game,
    options: options || {},
    players: { X: null, O: null },
    board: [],
    stones: null,
    turn: 'X',
    starter: 'X',
    status: 'waiting', // waiting | playing | over
    winner: null,
    line: null,
    last: null,
    busyUntil: 0,
  };
  resetBoard(room);
  return room;
}

function playerCount(room) {
  return (room.players.X ? 1 : 0) + (room.players.O ? 1 : 0);
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, anim) {
  for (const symbol of ['X', 'O']) {
    const ws = room.players[symbol];
    if (!ws) continue;
    sendTo(ws, {
      type: 'state',
      room: room.code,
      game: room.game,
      options: room.options,
      you: symbol,
      board: room.board,
      stones: room.stones,
      turn: room.turn,
      status: room.status,
      winner: room.winner,
      line: room.line,
      last: room.last,
      anim: anim || undefined,
    });
  }
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
  // 한 명만 남으면 대기 상태로 (진행 중이던 판은 보존, 끝난 판은 결과 유지)
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
      const game = msg.game === undefined ? 'tictactoe' : msg.game;
      if (typeof game !== 'string' || !Object.prototype.hasOwnProperty.call(GAMES, game)) {
        sendTo(ws, { type: 'error', code: 'BAD_GAME', message: '지원하지 않는 게임입니다' });
        return;
      }
      const options = {};
      if (game === 'alkkagi') {
        const n = msg.stones;
        options.stones = Number.isInteger(n) && n >= 3 && n <= 5 ? n : 3;
      }
      leaveRoom(ws);
      const room = newRoom(genCode(), game, options);
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
      if (!room || room.status !== 'playing' || room.game === 'alkkagi') return;
      const idx = msg.idx;
      if (!Number.isInteger(idx) || idx < 0 || idx >= room.board.length) return;
      if (room.turn !== ws.symbol || room.board[idx]) return;
      room.board[idx] = ws.symbol;
      room.last = idx;
      const result = GAMES[room.game].check(room.board, idx, ws.symbol);
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
    case 'shoot': {
      const room = ws.room;
      if (!room || room.game !== 'alkkagi' || room.status !== 'playing') return;
      if (room.turn !== ws.symbol) return;
      if (Date.now() < room.busyUntil) return; // 이전 알이 아직 굴러가는 중
      const id = msg.i;
      if (!Number.isInteger(id)) return;
      const stone = room.stones[id];
      if (!stone || !stone.alive || stone.o !== ws.symbol) return;
      if (typeof msg.vx !== 'number' || typeof msg.vy !== 'number') return;
      let { vx, vy } = msg;
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
      const speed = Math.hypot(vx, vy);
      if (speed < 0.5) return;
      if (speed > A_MAXV) {
        vx *= A_MAXV / speed;
        vy *= A_MAXV / speed;
      }

      const sim = simulate(room.stones, id, vx, vy);
      room.stones = sim.stones;
      const alive = { X: 0, O: 0 };
      for (const st of room.stones) if (st.alive) alive[st.o]++;
      if (alive.X === 0 || alive.O === 0) {
        room.status = 'over';
        room.winner = alive.X === 0 && alive.O === 0 ? null : alive.X === 0 ? 'O' : 'X';
        room.line = null;
      } else {
        room.turn = ws.symbol === 'X' ? 'O' : 'X';
      }
      room.busyUntil = Date.now() + ((sim.anim.frames.length - 1) / A_FPS) * 1000 + 300;
      broadcast(room, sim.anim);
      break;
    }
    case 'restart': {
      const room = ws.room;
      if (!room || room.status !== 'over') return;
      resetBoard(room);
      room.starter = room.starter === 'X' ? 'O' : 'X';
      room.turn = room.starter;
      room.winner = null;
      room.line = null;
      room.last = null;
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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`relay server listening on :${PORT}`);
  });
}

module.exports = { server, wss, simulate, layoutStones, GAMES };

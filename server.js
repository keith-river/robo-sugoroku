const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createGame, SPEED } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ゲームの進行（順番・サイコロ・移動・ジャンケン・ライフ・勝敗）は game.js が決める。
// ここは「通信」と「時間」（CPUの操作・制限時間）だけを担当する。
const game = createGame();

const TURN_TIMEOUT_MS = 25000;    // 向きを選ぶ制限時間（超えたらランダム）
const HAND_TIMEOUT_MS = 14000;    // ジャンケンの制限時間（超えたらランダム）。画面のタイマー(main.js)と同じ長さ
const BOT_THINK_MS = [900 * SPEED, 1800 * SPEED]; // CPUが「考える」時間

const humans = new Set();         // 接続中の人間（観戦者を含む）
const names = new Map();          // socket.id → 名前（観戦者が次のゲームに入るときに使う）

let version = 0;                  // 状態が進むたびに増やす。古いタイマーを無効にするための印
let timers = [];

const rnd = (a, b) => a + Math.random() * (b - a);

/** 全員に「いまの状態」と「再生すべき出来事(events)」を送る。 */
function broadcast(events = []) {
  io.emit('update', { state: game.snapshot(), events });
}

/** 操作結果を配信し、次の入力待ち（CPU・タイムアウト）を仕込む。 */
function publish(res) {
  broadcast(res.events || []);
  schedule(res.waitMs || 0);
}

function clearTimers() { timers.forEach(clearTimeout); timers = []; }

/**
 * 次の入力待ちを見て、CPUの操作と制限時間のタイマーを仕込む。
 * waitMs は「いま配った出来事をクライアントが再生し終えるまで」の目安。再生中に時間切れにならないよう足す。
 */
function schedule(waitMs) {
  clearTimers();
  const v = ++version;
  const aw = game.awaiting();
  if (!aw) return;
  const later = (ms, fn) => timers.push(setTimeout(() => { if (v === version) fn(); }, ms));

  if (aw.type === 'turn') {
    const id = aw.ids[0];
    const p = game.state.players[id];
    if (p.bot) later(waitMs + rnd(...BOT_THINK_MS), () => publish(game.chooseDirection(id, game.randomDirection())));
    else later(waitMs + TURN_TIMEOUT_MS, () => publish(game.chooseDirection(id, game.randomDirection())));
    return;
  }

  // ジャンケン：CPUはそれぞれ少し考えてから出す。人間は制限時間までに出さなければランダム。
  for (const id of aw.ids) {
    if (game.state.players[id].bot) {
      later(waitMs + rnd(...BOT_THINK_MS), () => publish(game.chooseHand(id, game.randomHand())));
    } else {
      later(waitMs + HAND_TIMEOUT_MS, () => publish(game.chooseHand(id, game.randomHand())));
    }
  }
}

/** ロビーに戻ったとき、観戦していた人も参加者にする。 */
function admitSpectators() {
  for (const id of humans) {
    if (!game.state.players[id]) game.addPlayer(id, names.get(id));
  }
}

io.on('connection', (socket) => {
  console.log(`接続: ${socket.id}`);
  humans.add(socket.id);
  names.set(socket.id, `ロボ_${socket.id.substring(0, 4)}`);

  // ロビーなら参加者に。ゲーム中なら観戦者（次のゲームから参加）。
  if (game.state.phase === 'lobby') game.addPlayer(socket.id, names.get(socket.id));
  broadcast();   // タイマーは触らない（観戦者の入室で制限時間が延びないように）

  socket.on('setName', (raw) => {
    const r = game.setName(socket.id, raw);
    if (r.ok) names.set(socket.id, game.state.players[socket.id].name);
    else if (typeof raw === 'string' && !game.state.players[socket.id]) {
      // 観戦中の名前変更（次のゲームに反映）
      const n = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
      if (n) names.set(socket.id, n);
    }
    broadcast();
  });

  const lobbyOnly = (fn) => () => {
    if (game.state.phase !== 'lobby' || !game.state.players[socket.id]) return;
    const r = fn();
    if (r.ok) publish(r);
  };
  socket.on('addBot', lobbyOnly(() => game.addBot()));
  socket.on('removeBot', lobbyOnly(() => game.removeBot()));
  socket.on('startGame', lobbyOnly(() => game.startGame()));

  socket.on('chooseDirection', (dir) => {
    const r = game.chooseDirection(socket.id, dir);
    if (r.ok) publish(r);
  });
  socket.on('chooseHand', (hand) => {
    const r = game.chooseHand(socket.id, hand);
    if (!r.ok) return;
    publish(r);
  });

  // ゲーム終了後：ロビーに戻る（観戦者も参加者になる）
  socket.on('backToLobby', () => {
    const r = game.backToLobby();
    if (!r.ok) return;
    admitSpectators();
    publish(r);
  });

  socket.on('disconnect', () => {
    console.log(`切断: ${socket.id}`);
    humans.delete(socket.id);
    names.delete(socket.id);
    if (humans.size === 0) {            // 誰もいなくなったら完全にリセット（CPUだけで回り続けない）
      clearTimers(); version++;
      game.reset();
      return;
    }
    if (!game.state.players[socket.id]) { broadcast(); return; }   // 観戦者の退室：進行には影響しない
    publish(game.removePlayer(socket.id));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🤖 ロボ箱庭すごろく Server running at http://localhost:${PORT}`);
});

'use strict';
/**
 * ロボ箱庭すごろく — ゲームロジック（通信・時間に依存しない純粋なロジック）
 *
 * ルール
 *  - 20個の石畳が輪になっている。ロボットは最初ランダムな石に置かれ、ライフは3。
 *  - 自分の番に「右回り(cw)／左回り(ccw)」を選ぶと、サイコロの目の数だけ、その向きに進む。
 *  - 進む途中で他のロボットのいる石を通ると「すれ違い」、最後に止まった石に他のロボットがいると
 *    「同じ石」。どちらも、その相手とジャンケン。負けた方のライフが1減る（勝った方は増えない）。
 *    あいこは決着がつくまでやり直し。同じ石に複数いれば、参加順に1人ずつ勝負する。
 *  - ライフが0になったロボットは脱落。最後まで残ったロボットの勝ち。
 *
 * すべての変更メソッドは { ok, events, waitMs } を返す。
 *  events … クライアントが順に再生する出来事（各イベントの ms は演出の長さの目安）
 *  waitMs … events を再生し終えるまでの目安（サーバが CPU の操作やタイムアウトの起点に使う）
 */

const TILE_COUNT = 20;
const START_LIVES = 3;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const HANDS = ['rock', 'scissors', 'paper'];          // グー・チョキ・パー
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const DIRS = ['cw', 'ccw'];                           // cw=右回り(時計回り) / ccw=左回り
const LOG_LIMIT = 60;

// 演出の長さ(ms)。クライアントもこの値でアニメーションする。
// 開発・テスト用に SUGOROKU_SPEED=0.3 のように指定すると、演出（とCPUの待ち時間）が速くなる。
const SPEED = Number(process.env.SUGOROKU_SPEED) > 0 ? Number(process.env.SUGOROKU_SPEED) : 1;
const BASE_DUR = {
  start: 2200, turn: 800, roll: 1700, step: 460,
  jankenStart: 1400, jankenRound: 3000, jankenEnd: 1700, eliminated: 2600, win: 6000, lobby: 100
};
const DUR = Object.fromEntries(Object.entries(BASE_DUR).map(([k, v]) => [k, Math.round(v * SPEED)]));

const BOT_NAMES = ['ロボ太', 'メカ吉', 'ピコ', 'ガチャ丸', 'ネジ子', 'ボルト', 'ギア美', 'サビ丸'];
const wrap = (n) => ((n % TILE_COUNT) + TILE_COUNT) % TILE_COUNT;
const dirLabel = (d) => (d === 'cw' ? '右回り' : '左回り');
const handLabel = (h) => ({ rock: 'グー', scissors: 'チョキ', paper: 'パー' }[h]);

function createGame({ rng = Math.random } = {}) {
  const state = freshState();
  let out = [];                                        // いま実行中の操作で出たイベント

  function freshState() {
    return {
      phase: 'lobby',        // lobby | turn | moving | janken | over
      players: {},           // id → { id, name, color, lives, tile, alive, bot, left }
      order: [],             // 参加順
      turnId: null,
      plan: null,            // 移動中の計画 { id, dir, remaining, queue, kind }
      pending: null,         // ジャンケン待ち { a, b, kind, tile, round, hands }
      winnerId: null,
      lastRoll: null,
      log: []
    };
  }

  // ---------- 小物 ----------
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const alivePlayers = () => state.order.map((id) => state.players[id]).filter((p) => p.alive);
  const P = (id) => state.players[id];

  function push(t, data = {}, text) {
    const ev = { t, ms: DUR[t] ?? 0, ...data };
    if (text) { ev.log = text; state.log.push(text); if (state.log.length > LOG_LIMIT) state.log.shift(); }
    out.push(ev);
    return ev;
  }
  function run(fn) {
    out = [];
    const res = fn();
    const events = out; out = [];
    const waitMs = events.reduce((s, e) => s + (e.ms || 0), 0);
    if (res && res.error) return { ok: false, error: res.error, events: [], waitMs: 0 };
    return { ok: true, events, waitMs };
  }
  const fail = (error) => ({ error });

  function pickColor() {
    const used = new Set(Object.values(state.players).map((p) => p.color));
    for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return 0;
  }

  // ---------- ロビー ----------
  function addPlayer(id, name, { bot = false } = {}) {
    return run(() => {
      if (state.phase !== 'lobby') return fail('ゲーム中は参加できません');
      if (state.players[id]) return fail('参加済みです');
      if (state.order.length >= MAX_PLAYERS) return fail('満員です');
      state.players[id] = { id, name, color: pickColor(), lives: START_LIVES, tile: null, alive: true, bot, left: false };
      state.order.push(id);
    });
  }

  function addBot() {
    const used = new Set(Object.values(state.players).map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `CPU${state.order.length + 1}`;
    const id = `bot-${Math.floor(rng() * 1e9).toString(36)}-${state.order.length}`;
    const res = addPlayer(id, name, { bot: true });
    return res.ok ? { ...res, id } : res;
  }

  function removeBot() {
    return run(() => {
      if (state.phase !== 'lobby') return fail('ロビーでのみ操作できます');
      const id = [...state.order].reverse().find((i) => state.players[i].bot);
      if (!id) return fail('CPUがいません');
      state.order.splice(state.order.indexOf(id), 1);
      delete state.players[id];
    });
  }

  function setName(id, raw) {
    return run(() => {
      const p = P(id);
      if (!p || typeof raw !== 'string') return fail('不正な操作です');
      // eslint-disable-next-line no-control-regex
      const name = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
      if (!name || name === p.name) return fail('変更なし');
      p.name = name;
    });
  }

  /** 切断。ロビーなら退出、ゲーム中はCPUが引き継いで続行する（進行が止まらないように）。 */
  function removePlayer(id) {
    return run(() => {
      const p = P(id);
      if (!p) return;
      if (state.phase === 'lobby') {
        state.order.splice(state.order.indexOf(id), 1);
        delete state.players[id];
        return;
      }
      p.bot = true; p.left = true;
      push('note', {}, `📡 ${p.name} の接続が切れたので、CPUが引き継ぎました。`);
    });
  }

  // ---------- ゲーム開始 ----------
  function startGame() {
    return run(() => {
      if (state.phase !== 'lobby') return fail('すでに始まっています');
      if (state.order.length < MIN_PLAYERS) return fail(`${MIN_PLAYERS}人以上で始められます`);
      // 初期位置はランダム（重ならないように 20 個の石からシャッフルして配る）
      const tiles = [...Array(TILE_COUNT).keys()];
      for (let i = tiles.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
      }
      state.order.forEach((id, i) => {
        const p = P(id);
        p.tile = tiles[i]; p.lives = START_LIVES; p.alive = true;
      });
      state.winnerId = null; state.lastRoll = null; state.plan = null; state.pending = null;
      state.log = [];
      push('start', { players: state.order.map(publicPlayer), order: [...state.order] }, '🎮 ゲーム開始！全員ライフ3。最後まで生き残れ！');
      beginTurn(pick(state.order));
    });
  }

  function beginTurn(id) {
    state.turnId = id;
    state.phase = 'turn';
    push('turn', { id }, `🤖 ${P(id).name} の番`);
  }

  function endTurn() {
    state.plan = null; state.pending = null;
    if (state.phase === 'over') return;
    const idx = state.order.indexOf(state.turnId);
    for (let i = 1; i <= state.order.length; i++) {
      const next = P(state.order[(idx + i) % state.order.length]);
      if (next.alive) { beginTurn(next.id); return; }
    }
  }

  // ---------- 自分の番：向きを選ぶ → サイコロ → 移動 ----------
  function chooseDirection(id, dir) {
    return run(() => {
      if (state.phase !== 'turn') return fail('いまは向きを選べません');
      if (state.turnId !== id) return fail('あなたの番ではありません');
      if (!DIRS.includes(dir)) return fail('向きが不正です');
      const p = P(id);
      const dice = Math.floor(rng() * 6) + 1;
      state.lastRoll = { id, dir, dice };
      push('roll', { id, dir, dice }, `🎲 ${p.name} は${dirLabel(dir)}で「${dice}」マス進む！`);
      state.phase = 'moving';
      state.plan = { id, dir, remaining: dice, queue: [], kind: null };
      advance();
    });
  }

  /** 進行役：ジャンケンが必要になるか、移動が終わるまで進める。 */
  function advance() {
    const plan = state.plan;
    const mover = P(plan.id);
    for (;;) {
      if (plan.queue.length) {
        if (startJanken()) return;
        continue;
      }
      if (plan.remaining <= 0) { endTurn(); return; }
      const from = mover.tile;
      const to = wrap(from + (plan.dir === 'cw' ? 1 : -1));
      mover.tile = to;
      plan.remaining -= 1;
      push('step', { id: mover.id, from, to, remaining: plan.remaining });
      const rivals = state.order.filter((id) => id !== mover.id && P(id).alive && P(id).tile === to);
      if (rivals.length) {
        plan.queue = rivals;
        plan.kind = plan.remaining === 0 ? 'land' : 'pass';   // 止まった / すれ違った
      }
    }
  }

  function startJanken() {
    const plan = state.plan;
    while (plan.queue.length) {
      const rid = plan.queue.shift();
      if (!P(rid).alive) continue;
      const a = P(plan.id), b = P(rid);
      state.pending = { a: a.id, b: b.id, kind: plan.kind, tile: a.tile, round: 1, hands: {} };
      state.phase = 'janken';
      push('jankenStart', { a: a.id, b: b.id, kind: plan.kind, tile: a.tile },
        plan.kind === 'land'
          ? `⚔️ ${a.name} は ${b.name} と同じ石に止まった！ジャンケン！`
          : `👟 ${a.name} は ${b.name} とすれ違った！ジャンケン！`);
      return true;
    }
    return false;
  }

  // ---------- ジャンケン ----------
  function chooseHand(id, hand) {
    return run(() => {
      const pd = state.pending;
      if (state.phase !== 'janken' || !pd) return fail('いまはジャンケンの時間ではありません');
      if (id !== pd.a && id !== pd.b) return fail('あなたの勝負ではありません');
      if (!HANDS.includes(hand)) return fail('手が不正です');
      if (pd.hands[id]) return fail('もう出しています');
      pd.hands[id] = hand;
      if (pd.hands[pd.a] && pd.hands[pd.b]) resolveRound();
    });
  }

  function resolveRound() {
    const pd = state.pending;
    const a = P(pd.a), b = P(pd.b);
    const ha = pd.hands[pd.a], hb = pd.hands[pd.b];
    const result = ha === hb ? 'draw' : (BEATS[ha] === hb ? 'a' : 'b');
    push('jankenRound', { a: a.id, b: b.id, ha, hb, result, round: pd.round },
      `✊ ${a.name}：${handLabel(ha)} ／ ${b.name}：${handLabel(hb)} → ${result === 'draw' ? 'あいこ！' : `${result === 'a' ? a.name : b.name} の勝ち！`}`);
    if (result === 'draw') { pd.round += 1; pd.hands = {}; return; }   // やり直し（pending は残す）

    const winner = result === 'a' ? a : b;
    const loser = result === 'a' ? b : a;
    loser.lives -= 1;                                // 勝った方のライフは増えない
    push('jankenEnd', { winner: winner.id, loser: loser.id, lives: loser.lives },
      `💔 ${loser.name} のライフが1減って ${loser.lives} に！`);
    state.pending = null;

    if (loser.lives <= 0) {
      loser.alive = false;
      push('eliminated', { id: loser.id, tile: loser.tile }, `💥 ${loser.name} は脱落…`);
      if (alivePlayers().length <= 1) {
        const champ = alivePlayers()[0];
        state.phase = 'over'; state.winnerId = champ ? champ.id : null; state.plan = null;
        push('win', { id: state.winnerId }, `🏆 ${champ ? champ.name : '誰も'} が最後まで生き残った！優勝！`);
        return;
      }
      if (loser.id === state.plan.id) { endTurn(); return; }   // 動いていた本人が脱落：その場で手番終了
    }
    state.phase = 'moving';
    advance();
  }

  // ---------- 後始末 ----------
  function backToLobby() {
    return run(() => {
      if (state.phase !== 'over') return fail('ゲーム終了後に使えます');
      for (const id of [...state.order]) {
        if (P(id).left) { state.order.splice(state.order.indexOf(id), 1); delete state.players[id]; }
      }
      for (const p of Object.values(state.players)) { p.lives = START_LIVES; p.alive = true; p.tile = null; }
      state.phase = 'lobby'; state.turnId = null; state.plan = null; state.pending = null;
      state.winnerId = null; state.lastRoll = null; state.log = [];
      push('lobby');
    });
  }

  /** 全員が抜けたときなどに完全初期化。 */
  function reset() { Object.assign(state, freshState()); }

  // ---------- サーバ向けの補助 ----------
  /** いま誰の入力待ちか。 { type:'turn', ids:[id] } | { type:'janken', ids:[未入力のid...] } | null */
  function awaiting() {
    if (state.phase === 'turn') return { type: 'turn', ids: [state.turnId] };
    if (state.phase === 'janken' && state.pending) {
      const pd = state.pending;
      return { type: 'janken', ids: [pd.a, pd.b].filter((i) => !pd.hands[i]) };
    }
    return null;
  }
  const randomDirection = () => pick(DIRS);
  const randomHand = () => pick(HANDS);

  function publicPlayer(p) {
    return { id: p.id, name: p.name, color: p.color, lives: p.lives, tile: p.tile, alive: p.alive, bot: p.bot, left: p.left };
  }

  /** 全員に同じ内容を送る（ジャンケンの手は決着まで伏せる＝ submitted の真偽だけ）。 */
  function snapshot() {
    const pd = state.pending;
    return {
      phase: state.phase,
      players: state.order.map((id) => publicPlayer(P(id))),
      turnId: state.turnId,
      winnerId: state.winnerId,
      lastRoll: state.lastRoll,
      pending: pd ? { a: pd.a, b: pd.b, kind: pd.kind, tile: pd.tile, round: pd.round, submitted: { [pd.a]: !!pd.hands[pd.a], [pd.b]: !!pd.hands[pd.b] } } : null,
      tileCount: TILE_COUNT,
      log: state.log
    };
  }

  return {
    state, addPlayer, addBot, removeBot, setName, removePlayer, startGame,
    chooseDirection, chooseHand, backToLobby, reset, awaiting, randomDirection, randomHand, snapshot
  };
}

module.exports = { createGame, TILE_COUNT, START_LIVES, MIN_PLAYERS, MAX_PLAYERS, HANDS, DIRS, DUR, SPEED };

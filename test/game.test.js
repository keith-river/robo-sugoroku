'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, TILE_COUNT, START_LIVES } = require('../game');

// 出したい目 d を返す乱数（開始時のシャッフル等は別の乱数を使うので、サイコロ用に後から差し替える）
function seeded(seed = 1) {            // 再現性のある疑似乱数（mulberry32）
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// 指定した目を順に返し、使い切ったあとは通常の疑似乱数に戻る
const dieRng = (...faces) => { let i = 0; const rest = seeded(99); return () => (i < faces.length ? (faces[i++] - 1) / 6 + 0.01 : rest()); };

// n人で開始し、テストしやすいよう石と手番を指定する。サイコロは fixed で固定。
function setup(tiles, { turn = 0, faces = [1] } = {}) {
  let rng = seeded(7);
  const g = createGame({ rng: () => rng() });
  tiles.forEach((_, i) => g.addPlayer(`p${i}`, `P${i}`));
  assert.equal(g.startGame().ok, true);
  tiles.forEach((t, i) => { g.state.players[`p${i}`].tile = t; });
  g.state.turnId = `p${turn}`; g.state.phase = 'turn';
  rng = dieRng(...faces);                       // ここから先のサイコロを固定
  return g;
}
const ev = (res, t) => res.events.filter((e) => e.t === t);
const tileOf = (g, id) => g.state.players[id].tile;
const hand = (g, a, ha, b, hb) => { g.chooseHand(a, ha); return g.chooseHand(b, hb); };

test('開始：全員ライフ3、初期位置はランダムで重ならない、2人未満は開始できない', () => {
  const g = createGame({ rng: seeded(3) });
  g.addPlayer('a', 'A');
  assert.equal(g.startGame().ok, false);
  for (let i = 0; i < 5; i++) g.addPlayer(`x${i}`, `X${i}`);
  const r = g.startGame();
  assert.equal(r.ok, true);
  const ps = Object.values(g.state.players);
  assert.ok(ps.every((p) => p.lives === START_LIVES && p.alive));
  assert.equal(new Set(ps.map((p) => p.tile)).size, ps.length, '初期位置が重なっていない');
  assert.ok(ps.every((p) => p.tile >= 0 && p.tile < TILE_COUNT));
  assert.equal(g.state.phase, 'turn');
});

test('初期位置は開始のたびに変わる（ランダム）', () => {
  const seen = new Set();
  for (let s = 1; s <= 8; s++) {
    const g = createGame({ rng: seeded(s) });
    g.addPlayer('a', 'A'); g.addPlayer('b', 'B'); g.startGame();
    seen.add(`${g.state.players.a.tile}-${g.state.players.b.tile}`);
  }
  assert.ok(seen.size > 4);
});

test('右回りはサイコロの目だけ +1 ずつ、左回りは -1 ずつ進む（19→0のように輪になっている）', () => {
  let g = setup([5, 15], { faces: [4] });
  let r = g.chooseDirection('p0', 'cw');
  assert.equal(tileOf(g, 'p0'), 9);
  assert.deepEqual(ev(r, 'step').map((e) => e.to), [6, 7, 8, 9]);

  g = setup([2, 10], { faces: [5] });
  r = g.chooseDirection('p0', 'ccw');
  assert.deepEqual(ev(r, 'step').map((e) => e.to), [1, 0, 19, 18, 17]);
  assert.equal(tileOf(g, 'p0'), 17);
});

test('進んだら次の人の番になる（ジャンケンがなければ）', () => {
  const g = setup([0, 10, 5], { faces: [2] });
  g.chooseDirection('p0', 'cw');
  assert.equal(g.state.turnId, 'p1');
  assert.equal(g.state.phase, 'turn');
});

test('自分の番でない・向きが不正・フェーズ違いは受け付けない', () => {
  const g = setup([0, 10], { faces: [2, 2] });
  assert.equal(g.chooseDirection('p1', 'cw').ok, false);
  assert.equal(g.chooseDirection('p0', 'up').ok, false);
  assert.equal(g.chooseHand('p0', 'rock').ok, false);
  assert.equal(g.chooseDirection('p0', 'cw').ok, true);
});

test('同じ石に止まったらジャンケン（kind=land）。勝ったほうがライフを奪い、勝者のライフは増えない', () => {
  const g = setup([0, 3], { faces: [3] });
  const r = g.chooseDirection('p0', 'cw');
  const js = ev(r, 'jankenStart');
  assert.equal(js.length, 1);
  assert.equal(js[0].kind, 'land');
  assert.equal(g.state.phase, 'janken');
  assert.equal(g.awaiting().type, 'janken');

  const r2 = hand(g, 'p0', 'rock', 'p1', 'scissors');     // p0 の勝ち
  assert.equal(ev(r2, 'jankenRound')[0].result, 'a');
  assert.equal(g.state.players.p1.lives, START_LIVES - 1);
  assert.equal(g.state.players.p0.lives, START_LIVES, '勝者のライフは増えない');
  assert.equal(g.state.turnId, 'p1');
});

test('負けたのが動いたほうでも、ライフが1減るだけ', () => {
  const g = setup([0, 3], { faces: [3] });
  g.chooseDirection('p0', 'cw');
  hand(g, 'p0', 'rock', 'p1', 'paper');                    // p1 の勝ち
  assert.equal(g.state.players.p0.lives, START_LIVES - 1);
  assert.equal(g.state.players.p1.lives, START_LIVES);
});

test('すれ違い（kind=pass）：途中の石に相手がいたらジャンケン、終わったら続きを進む', () => {
  const g = setup([0, 2, 10], { faces: [5] });
  const r = g.chooseDirection('p0', 'cw');                  // 0→1→2(すれ違い)で停止
  assert.deepEqual(ev(r, 'step').map((e) => e.to), [1, 2]);
  assert.equal(ev(r, 'jankenStart')[0].kind, 'pass');
  assert.equal(tileOf(g, 'p0'), 2);

  const r2 = hand(g, 'p0', 'paper', 'p1', 'rock');          // p0 勝ち → 続きを 3,4,5 と進む
  assert.deepEqual(ev(r2, 'step').map((e) => e.to), [3, 4, 5]);
  assert.equal(tileOf(g, 'p0'), 5);
  assert.equal(g.state.players.p1.lives, START_LIVES - 1);
  assert.equal(g.state.turnId, 'p1');
});

test('すれ違った相手に負けても、移動は続く（ライフが残っていれば）', () => {
  const g = setup([0, 1, 10], { faces: [3] });
  g.chooseDirection('p0', 'cw');                            // 1 でジャンケン
  const r = hand(g, 'p0', 'rock', 'p1', 'paper');           // p0 の負け
  assert.equal(g.state.players.p0.lives, START_LIVES - 1);
  assert.deepEqual(ev(r, 'step').map((e) => e.to), [2, 3]);
  assert.equal(tileOf(g, 'p0'), 3);
});

test('あいこは決着がつくまでやり直し（ライフは減らない）', () => {
  const g = setup([0, 2], { faces: [2] });
  g.chooseDirection('p0', 'cw');
  const r = hand(g, 'p0', 'rock', 'p1', 'rock');
  assert.equal(ev(r, 'jankenRound')[0].result, 'draw');
  assert.equal(g.state.phase, 'janken');
  assert.equal(g.state.pending.round, 2);
  assert.deepEqual(g.awaiting().ids.sort(), ['p0', 'p1']);   // もう一度、両方の入力待ち
  assert.equal(g.state.players.p0.lives, START_LIVES);
  assert.equal(g.state.players.p1.lives, START_LIVES);
  hand(g, 'p0', 'scissors', 'p1', 'paper');
  assert.equal(g.state.players.p1.lives, START_LIVES - 1);
});

test('手は決着まで伏せられる：snapshot には出したかどうかだけ', () => {
  const g = setup([0, 2], { faces: [2] });
  g.chooseDirection('p0', 'cw');
  g.chooseHand('p0', 'rock');
  const pd = g.snapshot().pending;
  assert.deepEqual(pd.submitted, { p0: true, p1: false });
  assert.equal(JSON.stringify(g.snapshot()).includes('rock'), false);
  assert.equal(g.chooseHand('p0', 'paper').ok, false, '出し直しはできない');
  assert.equal(g.chooseHand('p2', 'paper').ok, false, '関係ない人は出せない');
});

test('同じ石に2人いる所に止まったら、参加順に1人ずつジャンケン', () => {
  const g = setup([0, 3, 3], { faces: [3] });
  const r = g.chooseDirection('p0', 'cw');
  assert.equal(ev(r, 'jankenStart')[0].b, 'p1');
  const r2 = hand(g, 'p0', 'rock', 'p1', 'scissors');
  assert.equal(ev(r2, 'jankenStart')[0].b, 'p2', '次の相手');
  assert.equal(g.state.phase, 'janken');
  hand(g, 'p0', 'rock', 'p2', 'scissors');
  assert.equal(g.state.players.p1.lives, START_LIVES - 1);
  assert.equal(g.state.players.p2.lives, START_LIVES - 1);
  assert.equal(g.state.turnId, 'p1');
});

test('途中の石と最後の石の両方に相手がいれば、2回ジャンケンする', () => {
  const g = setup([0, 2, 4], { faces: [4] });
  g.chooseDirection('p0', 'cw');
  assert.equal(g.state.pending.b, 'p1');
  assert.equal(g.state.pending.kind, 'pass');
  hand(g, 'p0', 'rock', 'p1', 'scissors');
  assert.equal(g.state.pending.b, 'p2');
  assert.equal(g.state.pending.kind, 'land');
});

test('ライフ0で脱落。残り2人なら脱落者は盤面から外れ、手番も回らない', () => {
  const g = setup([0, 2, 10], { faces: [2, 1] });
  g.state.players.p1.lives = 1;
  g.chooseDirection('p0', 'cw');
  const r = hand(g, 'p0', 'rock', 'p1', 'scissors');
  assert.equal(ev(r, 'eliminated')[0].id, 'p1');
  assert.equal(g.state.players.p1.alive, false);
  assert.equal(g.state.turnId, 'p2', '脱落したp1を飛ばしてp2');
  // 脱落者のいる石はすれ違い対象にならない
  g.chooseDirection('p2', 'cw');
  assert.equal(g.state.turnId, 'p0');
});

test('最後の1人になったら、その人の優勝でゲーム終了', () => {
  const g = setup([0, 2], { faces: [2] });
  g.state.players.p1.lives = 1;
  g.chooseDirection('p0', 'cw');
  const r = hand(g, 'p0', 'rock', 'p1', 'scissors');
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.winnerId, 'p0');
  assert.equal(ev(r, 'win')[0].id, 'p0');
  assert.equal(g.awaiting(), null);
  assert.equal(g.chooseDirection('p0', 'cw').ok, false);
});

test('動いていた本人が脱落したら、その場で手番終了して次の人へ', () => {
  const g = setup([0, 2, 10], { faces: [5] });
  g.state.players.p0.lives = 1;
  g.chooseDirection('p0', 'cw');
  hand(g, 'p0', 'rock', 'p1', 'paper');                      // p0 負けて脱落
  assert.equal(g.state.players.p0.alive, false);
  assert.equal(tileOf(g, 'p0'), 2, '脱落した場所で止まる');
  assert.equal(g.state.turnId, 'p1');
  assert.equal(g.state.phase, 'turn');
});

test('脱落者は初期化後も盤面に出ない：alive=false は snapshot に反映される', () => {
  const g = setup([0, 2, 10], { faces: [2] });
  g.state.players.p1.lives = 1;
  g.chooseDirection('p0', 'cw');
  hand(g, 'p0', 'rock', 'p1', 'scissors');
  const snap = g.snapshot();
  assert.equal(snap.players.find((p) => p.id === 'p1').alive, false);
});

test('ゲーム終了後にロビーへ戻ると、ライフが戻り再スタートできる', () => {
  const g = setup([0, 2], { faces: [2] });
  g.state.players.p1.lives = 1;
  g.chooseDirection('p0', 'cw');
  hand(g, 'p0', 'rock', 'p1', 'scissors');
  assert.equal(g.backToLobby().ok, true);
  assert.equal(g.state.phase, 'lobby');
  assert.ok(Object.values(g.state.players).every((p) => p.lives === START_LIVES && p.alive && p.tile === null));
  assert.equal(g.startGame().ok, true);
});

test('ゲーム中の切断：CPUが引き継いで続行（ロビーなら退出）', () => {
  const g = setup([0, 10, 5], { faces: [1] });
  g.removePlayer('p1');
  assert.equal(g.state.players.p1.bot, true);
  assert.equal(g.state.players.p1.left, true);
  const lobby = createGame({ rng: seeded(1) });
  lobby.addPlayer('a', 'A');
  lobby.removePlayer('a');
  assert.equal(lobby.state.order.length, 0);
});

test('CPUの追加・削除、名前変更、最大8人', () => {
  const g = createGame({ rng: seeded(5) });
  g.addPlayer('h', 'Human');
  for (let i = 0; i < 7; i++) assert.equal(g.addBot().ok, true);
  assert.equal(g.addBot().ok, false, '9人目は入れない');
  assert.equal(g.state.order.length, 8);
  assert.equal(new Set(Object.values(g.state.players).map((p) => p.color)).size, 8, '色は全員別');
  assert.equal(g.removeBot().ok, true);
  g.setName('h', '<b>あいうえおかきくけこさしすせ</b>');
  assert.equal(g.state.players.h.name, 'bあいうえおかきくけこさ');
});

test('ランダムな対戦を何百回もシミュレートしても、必ず1人が残って終わる（不変条件も確認）', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = seeded(seed);
    const g = createGame({ rng });
    const n = 2 + (seed % 7);
    for (let i = 0; i < n; i++) g.addPlayer(`p${i}`, `P${i}`);
    g.startGame();
    let guard = 0;
    while (g.state.phase !== 'over') {
      assert.ok(++guard < 20000, `seed ${seed}: 終わらない`);
      const aw = g.awaiting();
      assert.ok(aw, `seed ${seed}: 入力待ちがない`);
      if (aw.type === 'turn') assert.equal(g.chooseDirection(aw.ids[0], g.randomDirection()).ok, true);
      else for (const id of aw.ids) g.chooseHand(id, g.randomHand());
      const alive = Object.values(g.state.players).filter((p) => p.alive);
      assert.ok(alive.length >= 1);
      assert.ok(Object.values(g.state.players).every((p) => p.lives >= 0 && p.lives <= START_LIVES));
      assert.ok(alive.every((p) => p.tile >= 0 && p.tile < TILE_COUNT));
    }
    const alive = Object.values(g.state.players).filter((p) => p.alive);
    assert.equal(alive.length, 1, `seed ${seed}: 生存者は1人`);
    assert.equal(g.state.winnerId, alive[0].id);
  }
});

/* ロボ箱庭すごろく — ブラウザ側（UI と通信）
 * サーバ(server.js)から 'update' = { state, events } を受け取る。
 *   state  … その時点の最終状態（全員同じ。ジャンケンの手は決着まで含まれない）
 *   events … 再生すべき出来事。キューに積んで1つずつ演出し、HUD も出来事に合わせて進める
 * こうして「結果が演出より先に画面に出てしまう（ネタバレ）」ことを防いでいる。
 * 入力ボタン（向き・ジャンケン）は、再生が全部終わってから出す。
 */
import { World, PALETTE, START_LIVES } from './scene.js';

const $ = (id) => document.getElementById(id);
const HAND = { rock: '✊', scissors: '✌️', paper: '✋' };
const HAND_NAME = { rock: 'グー', scissors: 'チョキ', paper: 'パー' };
const HAND_TIMEOUT_S = 14;
const heartSvg = '<svg viewBox="0 0 24 24"><path d="M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z"/></svg>';

// ---------------------------------------------------------------- 3D
let world = null;
try {
  world = new World($('stage'));
} catch (e) {
  console.error(e);
  $('webgl-error').hidden = false;
}

// ---------------------------------------------------------------- 状態
const socket = io();
let me = null;
let latest = null;                 // サーバから届いた最新の状態
let disp = { players: [], turnId: null };   // 画面に「いま見せている」状態（出来事の再生に合わせて進む）
let queue = [];
let pumping = false;
let eliminatedOrder = [];          // 脱落した順（結果の順位表用）
let versusState = null;
let bannerTimer = null;
let handTimer = null;

socket.on('connect', () => { me = socket.id; });
socket.on('update', ({ state, events }) => {
  latest = state;
  if (events && events.length) { queue.push(...events); pump(); } else if (!pumping) syncAll();
});

const player = (id, list = disp.players) => list.find((p) => p.id === id);
const color = (p) => PALETTE[p.color % PALETTE.length];
const isMe = (id) => id === me;

// ---------------------------------------------------------------- 出来事の再生
async function pump() {
  if (pumping) return;
  pumping = true;
  refreshInput();                                  // 再生中は入力ボタンを隠す
  while (queue.length) {
    const ev = queue.shift();
    try { await handle(ev); } catch (e) { console.error('event error', ev, e); }
  }
  pumping = false;
  syncAll();                                       // 最後は必ずサーバの最新状態に合わせる
}

async function handle(ev) {
  switch (ev.t) {
    case 'start':
      eliminatedOrder = [];
      disp = { players: ev.players.map((p) => ({ ...p })), turnId: null, phase: 'turn' };
      hideOverlay(); clearLog(); renderPlayers(); say('');
      banner('🎮 ゲーム開始！', 'win', 1800);
      break;
    case 'turn':
      disp.turnId = ev.id; disp.phase = 'turn';
      renderPlayers(); setBadge();
      break;
    case 'roll': {
      const p = player(ev.id);
      banner(`🎲 ${ev.dice}！ ${ev.dir === 'cw' ? '右回り ↻' : '左回り ↺'}`, '', 1500);
      say(`${p ? p.name : ''} は ${ev.dice} マス進む`);
      break;
    }
    case 'step': {
      const p = player(ev.id); if (p) p.tile = ev.to;
      break;
    }
    case 'jankenStart': {
      const a = player(ev.a), b = player(ev.b);
      disp.phase = 'janken';
      showVersus(a, b);
      banner(ev.kind === 'land' ? '⚔️ 同じ石！ジャンケン！' : '👟 すれ違い！ジャンケン！', 'fight', 1300);
      break;
    }
    case 'jankenRound': {
      revealVersus(ev);
      break;
    }
    case 'jankenEnd': {
      const l = player(ev.loser);
      if (l) { l.lives = ev.lives; }
      renderPlayers(ev.loser);
      break;
    }
    case 'eliminated': {
      const p = player(ev.id); if (p) p.alive = false;
      eliminatedOrder.push(ev.id);
      hideVersus();
      banner(`💥 ${p ? p.name : ''} 脱落…`, 'sad', 2200);
      renderPlayers();
      break;
    }
    case 'win': {
      hideVersus();
      const p = player(ev.id);
      disp.phase = 'over'; disp.winnerId = ev.id;
      banner(`🏆 ${p ? p.name : ''} の優勝！`, 'win', 5000);
      break;
    }
    case 'lobby':
      disp.phase = 'lobby'; hideVersus();
      break;
    default: break;
  }
  if (ev.log) appendLog(ev.log);
  if (world) await world.play(ev); else await sleep(Math.min(ev.ms || 0, 300));
  if (ev.t === 'jankenEnd' || ev.t === 'jankenRound') {
    if (ev.t === 'jankenEnd') hideVersus();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 同期（再生が空のとき）
function syncAll() {
  if (!latest) return;
  disp = { players: latest.players.map((p) => ({ ...p })), turnId: latest.turnId, phase: latest.phase, winnerId: latest.winnerId };
  if (world) world.sync(latest.players, latest.turnId, latest.phase);
  renderPlayers(); setBadge(); renderLobby(); renderLog();
  if (latest.phase !== 'janken') hideVersus();
  else showVersusFromState();
  refreshInput();
}

// ---------------------------------------------------------------- HUD
function setBadge() {
  const b = $('turn-badge');
  const ph = disp.phase;
  const p = player(disp.turnId);
  b.className = 'turn-badge';
  if (!latest) { b.textContent = '接続中…'; return; }
  if (ph === 'lobby') b.textContent = '🏠 ロビー';
  else if (ph === 'over') b.textContent = '🏁 ゲーム終了';
  else if (p && isMe(p.id)) { b.textContent = '👉 あなたの番！'; b.classList.add('mine'); }
  else b.textContent = p ? `⏳ ${p.name} の番` : '…';
}

function heartsHtml(lives, popIdx = -1) {
  let h = '';
  for (let i = 0; i < START_LIVES; i++) h += `<span class="heart ${i < lives ? 'full' : 'empty'}${i === popIdx ? ' pop' : ''}">${heartSvg}</span>`;
  return `<span class="hearts">${h}</span>`;
}

function renderPlayers(poppedId) {
  const box = $('players');
  if (disp.phase === 'lobby') { box.innerHTML = ''; return; }
  box.innerHTML = '';
  for (const p of disp.players) {
    const d = document.createElement('div');
    d.className = `pc${p.id === disp.turnId && p.alive && disp.phase !== 'over' ? ' turn' : ''}${p.alive ? '' : ' dead'}`;
    d.style.setProperty('--c', color(p));
    const face = document.createElement('span'); face.className = 'face';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
    if (isMe(p.id)) { const em = document.createElement('em'); em.textContent = 'あなた'; nm.appendChild(em); }
    else if (p.bot) { const em = document.createElement('em'); em.textContent = p.left ? '(離脱→CPU)' : 'CPU'; nm.appendChild(em); }
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.innerHTML = p.alive ? heartsHtml(p.lives, p.id === poppedId ? p.lives : -1) : '<span class="tag">💥 脱落</span>';
    d.append(face, nm, meta);
    box.appendChild(d);
  }
}

function say(text) { $('msg').textContent = text; }

function banner(text, cls = '', ms = 1500) {
  const b = $('banner');
  b.className = `banner ${cls}`; b.textContent = text;
  void b.offsetWidth; b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}

// ---- ジャンケン表示
function showVersus(a, b) {
  if (!a || !b) return;
  const v = $('versus'); v.hidden = false;
  for (const [id, p] of [['vs-a', a], ['vs-b', b]]) {
    const s = $(id); s.className = 'side';
    s.querySelector('.who').textContent = p.name + (isMe(p.id) ? '（あなた）' : '');
    s.querySelector('.who').style.color = color(p);
    s.querySelector('.hand').textContent = '❔'; s.querySelector('.hand').classList.remove('reveal');
    s.querySelector('.st').textContent = '考え中…';
  }
  $('vs-msg').textContent = '';
}
function showVersusFromState() {
  const pd = latest.pending; if (!pd) return;
  const a = player(pd.a), b = player(pd.b);
  const v = $('versus');
  if (v.hidden) showVersus(a, b);
  for (const [id, pid] of [['vs-a', pd.a], ['vs-b', pd.b]]) $(id).querySelector('.st').textContent = pd.submitted[pid] ? '✅ 出した！' : '考え中…';
  $('vs-msg').textContent = pd.round > 1 ? `あいこ！（${pd.round}回目）` : '';
}
function revealVersus(ev) {
  for (const [id, h] of [['vs-a', ev.ha], ['vs-b', ev.hb]]) {
    const s = $(id); const hd = s.querySelector('.hand');
    hd.textContent = HAND[h]; hd.classList.remove('reveal'); void hd.offsetWidth; hd.classList.add('reveal');
    s.querySelector('.st').textContent = HAND_NAME[h];
  }
  const sa = $('vs-a'), sb = $('vs-b'), a = player(ev.a), b = player(ev.b);
  sa.classList.toggle('win', ev.result === 'a'); sb.classList.toggle('win', ev.result === 'b');
  sa.classList.toggle('lose', ev.result === 'b'); sb.classList.toggle('lose', ev.result === 'a');
  $('vs-msg').textContent = ev.result === 'draw' ? '🤝 あいこ！もう一回！' : `${(ev.result === 'a' ? a : b).name} の勝ち！`;
  setTimeout(() => { if (ev.result === 'draw') { for (const id of ['vs-a', 'vs-b']) { const s = $(id); s.className = 'side'; s.querySelector('.hand').textContent = '❔'; s.querySelector('.st').textContent = '考え中…'; } } }, ev.ms - 500);
}
function hideVersus() { $('versus').hidden = true; }

// ---- ログ
function appendLog(t) {
  const li = document.createElement('li'); li.textContent = t;
  const ol = $('log'); ol.appendChild(li); ol.scrollTop = ol.scrollHeight;
  while (ol.children.length > 60) ol.removeChild(ol.firstChild);
}
function clearLog() { $('log').textContent = ''; }
function renderLog() {
  const ol = $('log'); ol.textContent = '';
  (latest.log || []).forEach((t) => appendLog(t));
}
$('log-toggle').addEventListener('click', () => { $('log-panel').hidden = !$('log-panel').hidden; });

// ---------------------------------------------------------------- 入力（再生が終わってから）
function refreshInput() {
  const dirBox = $('dir-box'), handBox = $('hand-box');
  dirBox.hidden = true; handBox.hidden = true;
  clearInterval(handTimer);
  if (world) world.showChoice(null);
  if (!latest) return;
  const ph = latest.phase;
  const iAmPlayer = !!player(me, latest.players);
  const lobby = $('lobby'), over = $('over');
  lobby.hidden = !(ph === 'lobby' && !pumping);
  over.hidden = !(ph === 'over' && !pumping);
  if (!over.hidden) renderOver();
  if (pumping) return;

  if (ph === 'lobby') { say(''); return; }
  if (ph === 'over') { say(''); return; }
  if (!iAmPlayer) { say('👀 観戦中（次のゲームから参加できます）'); return; }
  const mine = player(me, latest.players);
  if (!mine.alive) { say('💥 脱落しました。観戦中…'); }

  if (ph === 'turn' && latest.turnId === me) {
    dirBox.hidden = false;
    say('進む向きを選んでください（サイコロは自動で振られます）');
    if (world) world.showChoice(me);
  } else if (ph === 'janken' && latest.pending && (latest.pending.a === me || latest.pending.b === me)) {
    const pd = latest.pending;
    const submitted = pd.submitted[me];
    handBox.hidden = false;
    handBox.querySelectorAll('.hand-btn').forEach((b) => { b.disabled = submitted; b.classList.remove('picked'); });
    if (!submitted) { startHandTimer(); say(pd.round > 1 ? `あいこ！もう一度出そう（${pd.round}回目）` : '手を選んでください！'); }
    else say('✅ 出しました。相手を待っています…');
    if (submitted && myPick) handBox.querySelector(`[data-hand="${myPick}"]`)?.classList.add('picked');
  } else if (ph === 'turn') {
    const p = player(latest.turnId, latest.players);
    say(p ? `${p.name} が向きを選んでいます…` : '');
  } else if (ph === 'janken' && latest.pending) {
    const a = player(latest.pending.a, latest.players), b = player(latest.pending.b, latest.players);
    say(`${a.name} と ${b.name} がジャンケン中…`);
  } else say('');
}

let myPick = null;
function startHandTimer() {
  const bar = $('timer-bar');
  const t0 = performance.now();
  bar.style.transform = 'scaleX(1)';
  handTimer = setInterval(() => {
    const k = Math.max(0, 1 - (performance.now() - t0) / (HAND_TIMEOUT_S * 1000));
    bar.style.transform = `scaleX(${k})`;
    if (k <= 0) clearInterval(handTimer);
  }, 100);
}

document.querySelectorAll('#dir-box .dir').forEach((b) => {
  b.addEventListener('click', () => chooseDir(b.dataset.dir));
  b.addEventListener('pointerenter', () => world && world.setHoverDir(b.dataset.dir));
  b.addEventListener('pointerleave', () => world && world.setHoverDir(null));
});
function chooseDir(dir) {
  if ($('dir-box').hidden) return;
  $('dir-box').hidden = true;
  if (world) { world.setHoverDir(null); world.showChoice(null); }
  socket.emit('chooseDirection', dir);
}
if (world) world.onPick((dir) => chooseDir(dir));

document.querySelectorAll('#hand-box .hand-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.disabled) return;
    myPick = b.dataset.hand;
    document.querySelectorAll('#hand-box .hand-btn').forEach((x) => { x.disabled = true; x.classList.toggle('picked', x === b); });
    say('✅ 出しました。相手を待っています…');
    socket.emit('chooseHand', myPick);
  });
});
// キーボード: ← → で向き、 G/C/P でジャンケン
window.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (!$('dir-box').hidden) { if (e.key === 'ArrowLeft') chooseDir('ccw'); if (e.key === 'ArrowRight') chooseDir('cw'); }
  if (!$('hand-box').hidden) {
    const m = { '1': 'rock', g: 'rock', '2': 'scissors', c: 'scissors', '3': 'paper', p: 'paper' }[e.key.toLowerCase()];
    if (m) document.querySelector(`#hand-box [data-hand="${m}"]`).click();
  }
});

// ---------------------------------------------------------------- ロビー・結果
const nameInput = $('name-input');
nameInput.addEventListener('change', () => socket.emit('setName', nameInput.value));
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
$('add-bot').addEventListener('click', () => socket.emit('addBot'));
$('remove-bot').addEventListener('click', () => socket.emit('removeBot'));
$('start-btn').addEventListener('click', () => socket.emit('startGame'));
$('lobby-btn').addEventListener('click', () => socket.emit('backToLobby'));

function renderLobby() {
  if (!latest || latest.phase !== 'lobby') return;
  const ul = $('lobby-list'); ul.textContent = '';
  for (const p of latest.players) {
    const li = document.createElement('li'); li.style.setProperty('--c', color(p));
    const f = document.createElement('span'); f.className = 'face';
    const n = document.createElement('span'); n.textContent = p.name;
    li.append(f, n);
    if (isMe(p.id)) { const em = document.createElement('em'); em.textContent = 'あなた'; li.appendChild(em); }
    else if (p.bot) { const em = document.createElement('em'); em.textContent = 'CPU'; li.appendChild(em); }
    ul.appendChild(li);
  }
  const mine = player(me, latest.players);
  if (mine && document.activeElement !== nameInput) nameInput.value = mine.name;
  const n = latest.players.length;
  $('start-btn').disabled = n < 2 || !mine;
  $('add-bot').disabled = n >= 8; $('remove-bot').disabled = !latest.players.some((p) => p.bot);
  $('lobby-hint').textContent = n < 2 ? '2体以上で始められます。「CPUを追加」か、友だちにこのURLを送って呼んでね。' : `${n}体で対戦！（最大8体）`;
}

function renderOver() {
  const winner = player(latest.winnerId, latest.players);
  $('over-title').textContent = winner ? `${winner.name} の優勝！` : 'ゲーム終了';
  const ol = $('over-rank'); ol.textContent = '';
  const ranking = [latest.winnerId, ...[...eliminatedOrder].reverse()].filter(Boolean);
  const seen = new Set();
  ranking.forEach((id, i) => {
    if (seen.has(id)) return; seen.add(id);
    const p = player(id, latest.players); if (!p) return;
    const li = document.createElement('li'); li.style.setProperty('--c', color(p));
    const f = document.createElement('span'); f.className = 'face';
    const n = document.createElement('span'); n.textContent = `${i + 1}位  ${p.name}${isMe(id) ? '（あなた）' : ''}`;
    li.append(f, n); ol.appendChild(li);
  });
}
function hideOverlay() { $('lobby').hidden = true; $('over').hidden = true; }

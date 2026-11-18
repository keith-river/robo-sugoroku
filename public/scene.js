/* ロボ箱庭すごろく — 3Dの箱庭（three.js）
 * テーブルの上の木のトレーに、石畳の輪（20個）・池・木・鳥居・風車などを並べたジオラマ。
 * ゲームの進行は知らず、main.js から渡される「出来事(event)」を演出として再生するだけ。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/RoundedBoxGeometry.js';

export const PALETTE = ['#ff5a5f', '#2ec4b6', '#ffb703', '#4d8bff', '#a06bff', '#ff7eb6', '#7bc043', '#ff8a3d'];
export const START_LIVES = 3;

const TILE_COUNT = 20;
const RING_R = 7.4;          // 石畳の輪の半径
const TILE_TOP = 0.34;       // 石の上面の高さ（地面=0）
const TAU = Math.PI * 2;

// ---------- ユーティリティ ----------
function mulberry32(a) {                       // 飾りの配置を毎回同じにするための疑似乱数
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a, b, k) => a + (b - a) * k;
const clamp01 = (k) => Math.max(0, Math.min(1, k));
const ease = {
  out: (k) => 1 - (1 - k) ** 3,
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
  bounce: (k) => {
    const n1 = 7.5625, d1 = 2.75;
    if (k < 1 / d1) return n1 * k * k;
    if (k < 2 / d1) return n1 * (k -= 1.5 / d1) * k + 0.75;
    if (k < 2.5 / d1) return n1 * (k -= 2.25 / d1) * k + 0.9375;
    return n1 * (k -= 2.625 / d1) * k + 0.984375;
  }
};
const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

const tangentYaw = (tile, s = 1) => { const a = -Math.PI / 2 + (tile / 20) * Math.PI * 2; return Math.atan2(-Math.sin(a) * s, Math.cos(a) * s); };
const tileAngle = (i) => -Math.PI / 2 + (i / TILE_COUNT) * TAU;   // 0番が奥(北)。番号が増えると時計回り
export function tilePos(i, r = RING_R) {
  const a = tileAngle(i);
  return new THREE.Vector3(Math.cos(a) * r, TILE_TOP, Math.sin(a) * r);
}

function canvasTex(w, h, draw, { repeat, srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

function drawHeart(ctx, x, y, s, fill) {       // (x,y)=中心, s=大きさ
  ctx.save(); ctx.translate(x, y); ctx.scale(s / 20, s / 20);
  ctx.beginPath();
  ctx.moveTo(0, 8);
  ctx.bezierCurveTo(-14, -2, -10, -14, 0, -6);
  ctx.bezierCurveTo(10, -14, 14, -2, 0, 8);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
  ctx.restore();
}

// ============================================================================
//  World
// ============================================================================
export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.robots = new Map();
    this.tweens = [];
    this.particles = [];
    this._last = performance.now();
    this.time = 0;
    this.turnId = null;
    this.focus = new THREE.Vector3(0, 0.6, 0);
    this.focusDist = null;                      // 演出で寄るときの目標距離（null=触らない）
    this.pickHandler = null;
    this.hoverDir = null;
    this.celebrate = null;

    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = this.scene = new THREE.Scene();
    scene.background = canvasTex(8, 512, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#9fd3f2'); g.addColorStop(0.55, '#dff1fb'); g.addColorStop(1, '#fbe9cf');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    });
    scene.fog = new THREE.Fog(0xdff1fb, 60, 130);

    const camera = this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 300);
    camera.position.set(0, 17, 21);
    const controls = this.controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minPolarAngle = 0.25; controls.maxPolarAngle = 1.38;
    controls.minDistance = 9; controls.maxDistance = 46;
    controls.target.copy(this.focus);
    controls.autoRotateSpeed = 0.5;
    controls.addEventListener('start', () => { this._userMoved = true; });
    this.wantRotate = true;

    this.buildLights();
    this.buildTable();
    this.buildGarden();
    this.buildRing();
    this.buildPond();
    this.buildDecor();
    this.buildPetals();
    this.buildParticles();
    this.buildArrows();
    this.buildDice();
    this.buildCounter();

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.fitCamera();

    this.bindPicking();
    this.loop = this.loop.bind(this);
    renderer.setAnimationLoop(this.loop);
  }

  // ---------------------------------------------------------------- 光
  buildLights() {
    const { scene } = this;
    scene.add(new THREE.HemisphereLight(0xcfe9ff, 0xb78b5c, 0.85));
    const sun = this.sun = new THREE.DirectionalLight(0xfff0d2, 2.6);
    sun.position.set(11, 24, 13);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -19; sc.right = 19; sc.top = 19; sc.bottom = -19; sc.near = 5; sc.far = 70;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.55);
    fill.position.set(-14, 10, -8);
    scene.add(fill);
  }

  // ---------------------------------------------------------------- テーブルとトレー
  buildTable() {
    const { scene } = this;
    const wood = canvasTex(512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#c99358'; ctx.fillRect(0, 0, w, h);
      const r = mulberry32(5);
      for (let i = 0; i < 90; i++) {
        const y = r() * h, th = 1 + r() * 4;
        ctx.fillStyle = `rgba(${90 + r() * 40},${55 + r() * 30},${25 + r() * 20},${0.1 + r() * 0.16})`;
        ctx.fillRect(0, y, w, th);
      }
      for (let i = 0; i < 6; i++) {              // 節
        const x = r() * w, y = r() * h;
        const g = ctx.createRadialGradient(x, y, 1, x, y, 26);
        g.addColorStop(0, 'rgba(90,55,25,.45)'); g.addColorStop(1, 'rgba(90,55,25,0)');
        ctx.fillStyle = g; ctx.fillRect(x - 30, y - 30, 60, 60);
      }
    }, { repeat: [5, 5] });
    const table = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.85 }));
    table.rotation.x = -Math.PI / 2; table.position.y = -0.9; table.receiveShadow = true;
    scene.add(table);

    // トレーの枠
    const frameTex = canvasTex(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#8a5a34'; ctx.fillRect(0, 0, w, h);
      const r = mulberry32(11);
      for (let i = 0; i < 60; i++) { ctx.fillStyle = `rgba(60,35,15,${0.08 + r() * 0.15})`; ctx.fillRect(0, r() * h, w, 1 + r() * 3); }
    });
    const frameMat = new THREE.MeshStandardMaterial({ map: frameTex, roughness: 0.7 });
    const H = 13, T = 1.4, top = 0.55, bot = -0.9;
    const mk = (w, d, x, z) => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, top - bot, d, 3, 0.18), frameMat);
      m.position.set(x, (top + bot) / 2, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
    };
    mk(2 * H + 2 * T, T, 0, H + T / 2); mk(2 * H + 2 * T, T, 0, -H - T / 2);
    mk(T, 2 * H, H + T / 2, 0); mk(T, 2 * H, -H - T / 2, 0);
  }

  buildGarden() {
    const { scene } = this;
    const grass = canvasTex(512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#8fd16a'; ctx.fillRect(0, 0, w, h);
      const r = mulberry32(21);
      for (let i = 0; i < 260; i++) {
        const x = r() * w, y = r() * h, rad = 10 + r() * 40;
        const g = ctx.createRadialGradient(x, y, 1, x, y, rad);
        const l = 55 + r() * 18;
        g.addColorStop(0, `hsla(${90 + r() * 30},55%,${l}%,.5)`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    }, { repeat: [3, 3] });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(26, 0.9, 26), new THREE.MeshStandardMaterial({ map: grass, roughness: 0.95 }));
    ground.position.y = -0.45; ground.receiveShadow = true;
    this.scene.add(ground);

    // 草のふさ（インスタンス）
    const rr = mulberry32(31);
    const tuftGeo = new THREE.ConeGeometry(0.09, 0.38, 4); tuftGeo.translate(0, 0.19, 0);
    const N = 650;
    const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
    let n = 0;
    while (n < N) {
      const x = (rr() - 0.5) * 25, z = (rr() - 0.5) * 25, d = Math.hypot(x, z);
      if (Math.abs(d - RING_R) < 1.55 || d < 3.9) continue;                 // 石畳・池の上は避ける
      e.set((rr() - 0.5) * 0.4, rr() * TAU, (rr() - 0.5) * 0.4); q.setFromEuler(e);
      const s = 0.7 + rr() * 1.1;
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * (0.8 + rr() * 0.8), s));
      tufts.setMatrixAt(n, m); tufts.setColorAt(n, col.setHSL(0.25 + rr() * 0.08, 0.55, 0.38 + rr() * 0.14));
      n++;
    }
    tufts.castShadow = false; tufts.receiveShadow = true;
    scene.add(tufts);

    // 花
    const fl = 110;
    const stemGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.34, 4); stemGeo.translate(0, 0.17, 0);
    const headGeo = new THREE.SphereGeometry(0.11, 8, 6); headGeo.translate(0, 0.38, 0);
    const stems = new THREE.InstancedMesh(stemGeo, new THREE.MeshStandardMaterial({ color: 0x5aa14a }), fl);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), fl);
    const cols = ['#ffffff', '#ffd54a', '#ff8fb8', '#b69cff', '#ff7a6b'];
    n = 0;
    while (n < fl) {
      const x = (rr() - 0.5) * 24.5, z = (rr() - 0.5) * 24.5, d = Math.hypot(x, z);
      if (Math.abs(d - RING_R) < 1.6 || d < 4.2) continue;
      m.compose(new THREE.Vector3(x, 0, z), q.identity(), new THREE.Vector3(1, 0.8 + rr() * 0.5, 1));
      stems.setMatrixAt(n, m); heads.setMatrixAt(n, m); heads.setColorAt(n, col.set(cols[Math.floor(rr() * cols.length)]));
      n++;
    }
    heads.castShadow = true;
    scene.add(stems, heads);
  }

  // ---------------------------------------------------------------- 石畳の輪
  buildRing() {
    const { scene } = this;
    // 土の道
    const dirt = new THREE.Mesh(
      new THREE.RingGeometry(RING_R - 1.45, RING_R + 1.45, 96, 1),
      new THREE.MeshStandardMaterial({ color: 0xcaa878, roughness: 1 })
    );
    dirt.rotation.x = -Math.PI / 2; dirt.position.y = 0.02; dirt.receiveShadow = true;
    scene.add(dirt);

    this.tileMeshes = [];
    const rr = mulberry32(41);
    const numTex = (n) => canvasTex(128, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = '900 76px "Hiragino Maru Gothic ProN","Noto Sans JP",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.strokeText(String(n), w / 2, h / 2 + 4);
      ctx.fillStyle = 'rgba(70,58,48,.55)'; ctx.fillText(String(n), w / 2, h / 2 + 4);
    });
    for (let i = 0; i < TILE_COUNT; i++) {
      // 少しいびつな多角形の敷石（半径方向 a、接線方向 b）
      const a = 1.02, b = 0.9, pts = [];
      const K = 9;
      for (let k = 0; k < K; k++) {
        const t = (k / K) * TAU + 0.2;
        const j = 0.9 + rr() * 0.2;
        pts.push(new THREE.Vector2(Math.cos(t) * a * j, Math.sin(t) * b * j));
      }
      const shape = new THREE.Shape(pts);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: true, bevelSize: 0.1, bevelThickness: 0.07, bevelSegments: 3, curveSegments: 4 });
      geo.rotateX(-Math.PI / 2);                // 上方向に押し出す
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.09 + rr() * 0.03, 0.1 + rr() * 0.1, 0.6 + rr() * 0.1), roughness: 0.92
      });
      const stone = new THREE.Mesh(geo, mat);
      const p = tilePos(i, RING_R); p.y = 0.02 + (rr() - 0.5) * 0.03;
      stone.position.copy(p);
      stone.rotation.y = -tileAngle(i) + (rr() - 0.5) * 0.14;
      stone.rotation.z = (rr() - 0.5) * 0.02;
      stone.castShadow = true; stone.receiveShadow = true;
      scene.add(stone);
      this.tileMeshes.push(stone);

      // 番号（石に刻まれた感じ）
      const num = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicMaterial({ map: numTex(i + 1), transparent: true, depthWrite: false }));
      num.rotation.x = -Math.PI / 2;
      const inner = tilePos(i, RING_R - 0.62);
      num.position.set(inner.x, TILE_TOP + 0.012, inner.z);
      scene.add(num);

      // 苔
      if (rr() < 0.6) {
        const moss = new THREE.Mesh(new THREE.SphereGeometry(0.16 + rr() * 0.1, 8, 5), new THREE.MeshStandardMaterial({ color: 0x6fae4a, roughness: 1 }));
        moss.scale.y = 0.35;
        const o = tilePos(i, RING_R + (rr() < 0.5 ? 0.78 : -0.78)); o.add(new THREE.Vector3((rr() - 0.5) * 0.5, 0, (rr() - 0.5) * 0.5));
        moss.position.set(o.x, TILE_TOP - 0.04, o.z); moss.castShadow = true; scene.add(moss);
      }
    }
    // 道端の小さな丸石
    const pebGeo = new THREE.IcosahedronGeometry(0.12, 0);
    const peb = new THREE.InstancedMesh(pebGeo, new THREE.MeshStandardMaterial({ color: 0xb9b2a8, roughness: 0.9 }), 160);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < 160; i++) {
      const a = rr() * TAU, side = rr() < 0.5 ? -1 : 1, r = RING_R + side * (1.25 + rr() * 0.3);
      m.compose(new THREE.Vector3(Math.cos(a) * r, 0.05, Math.sin(a) * r), q.setFromEuler(new THREE.Euler(rr() * 3, rr() * 3, rr() * 3)), new THREE.Vector3(1 + rr(), 0.6 + rr() * 0.4, 1 + rr()));
      peb.setMatrixAt(i, m);
    }
    peb.castShadow = true; scene.add(peb);
  }

  // ---------------------------------------------------------------- 池
  buildPond() {
    const { scene } = this;
    const g = this.pond = new THREE.Group(); scene.add(g);
    const bank = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.9, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0xd8c39a, roughness: 1 }));
    bank.position.y = 0.1; bank.receiveShadow = true; g.add(bank);
    const water = this.water = new THREE.Mesh(
      new THREE.CylinderGeometry(3.3, 3.3, 0.06, 48),
      new THREE.MeshStandardMaterial({ color: 0x4fc3e8, roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.9 })
    );
    water.position.y = 0.27; water.receiveShadow = true; g.add(water);
    const rr = mulberry32(51);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a9a98, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 16; i++) {                // 岸の石
      const a = (i / 16) * TAU + rr() * 0.2, s = 0.28 + rr() * 0.3;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
      rock.position.set(Math.cos(a) * 3.55, 0.25 + s * 0.2, Math.sin(a) * 3.55);
      rock.scale.set(1.2, 0.7 + rr() * 0.3, 1); rock.rotation.set(rr(), rr() * 3, rr());
      rock.castShadow = true; rock.receiveShadow = true; g.add(rock);
    }
    // 蓮の葉と花
    const padMat = new THREE.MeshStandardMaterial({ color: 0x4caf50, roughness: 0.7 });
    for (let i = 0; i < 7; i++) {
      const a = rr() * TAU, d = 0.6 + rr() * 2.1, s = 0.32 + rr() * 0.22;
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(s, s, 0.02, 14, 1, false, 0.5, TAU - 0.9), padMat);
      pad.position.set(Math.cos(a) * d, 0.31, Math.sin(a) * d); pad.rotation.y = rr() * 6; g.add(pad);
      if (i % 3 === 0) {
        const fl = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff9ec4, roughness: 0.5 }));
        fl.scale.y = 0.7; fl.position.set(pad.position.x, 0.4, pad.position.z); g.add(fl);
      }
    }
    // 錦鯉（池をゆっくり泳ぐ）
    this.koi = [];
    [[0xff7a2f, 2.0, 0.5], [0xfff3e0, 1.3, -0.4], [0xff5a5f, 2.5, 0.3]].forEach(([c, r, sp], i) => {
      const fish = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }));
      body.scale.set(2.2, 0.7, 1);
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 4), new THREE.MeshStandardMaterial({ color: c }));
      tail.rotation.z = Math.PI / 2; tail.position.x = -0.42;
      fish.add(body, tail); fish.position.y = 0.2; fish.castShadow = false;
      g.add(fish); this.koi.push({ fish, r, sp, ph: i * 2 });
    });
  }

  // ---------------------------------------------------------------- 飾り（木・鳥居・小屋・風車・灯籠）
  buildDecor() {
    const { scene } = this;
    const rr = mulberry32(61);
    const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, ...o });
    const add = (g, x, z, ry = 0) => { g.position.set(x, 0, z); g.rotation.y = ry; g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); scene.add(g); return g; };

    const trunkMat = mat(0x8b5a2b);
    const roundTree = (s = 1, leaf = 0x5cb85c) => {
      const g = new THREE.Group();
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * s, 0.22 * s, 1.1 * s, 7), trunkMat); t.position.y = 0.55 * s; g.add(t);
      [[0, 1.55, 0, 0.95], [0.35, 1.2, 0.2, 0.62], [-0.3, 1.3, -0.2, 0.6]].forEach(([x, y, z, r]) => {
        const c = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 1), mat(leaf, { flatShading: true })); c.position.set(x * s, y * s, z * s); g.add(c);
      });
      return g;
    };
    const pine = (s = 1) => {
      const g = new THREE.Group();
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.17 * s, 0.7 * s, 6), trunkMat); t.position.y = 0.35 * s; g.add(t);
      [[0.5, 0.9], [1.15, 0.72], [1.75, 0.52]].forEach(([y, r], i) => {
        const c = new THREE.Mesh(new THREE.ConeGeometry(r * s, 0.95 * s, 8), mat(i % 2 ? 0x2f8f5b : 0x3aa66a, { flatShading: true })); c.position.y = (y + 0.35) * s; g.add(c);
      });
      return g;
    };
    const sakura = (s = 1) => roundTree(s, 0xffb7d1);

    // 配置（トレーの四隅と外周。石畳の輪(半径≈7.4+1.5)の外側）
    add(pine(1.25), -10.6, 3.2); add(pine(1.0), -9.4, 6.8, 1); add(pine(1.45), 10.8, 4.4, 2);
    add(sakura(1.3), -4.5, 10.4); add(sakura(1.1), 5.8, 10.7); add(sakura(1.5), 10.6, -4.4);
    add(roundTree(1.2), -11, -3.8); add(roundTree(0.95), 8.6, 8.3);

    // 鳥居（奥の中央）
    {
      const g = new THREE.Group(); const red = mat(0xe14b3b, { roughness: 0.55 }), blk = mat(0x2a2a30);
      [-1.3, 1.3].forEach((x) => { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 3.1, 10), red); p.position.set(x, 1.55, 0); g.add(p); });
      const kasagi = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.26, 0.5), blk); kasagi.position.y = 3.2; g.add(kasagi);
      const kasagiTop = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.14, 0.62), red); kasagiTop.position.y = 3.42; g.add(kasagiTop);
      const nuki = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.18, 0.3), red); nuki.position.y = 2.6; g.add(nuki);
      add(g, 0, -11.3, 0);
    }
    // 小屋（左奥）
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.5, 2), mat(0xf3e2c2)); body.position.y = 0.75; g.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.1, 4), mat(0xc0583a, { flatShading: true })); roof.position.y = 2.05; roof.rotation.y = Math.PI / 4; roof.scale.set(1.12, 1, 0.95); g.add(roof);
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.06), mat(0x7a4a2a)); door.position.set(0, 0.45, 1.02); g.add(door);
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.06), new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffc860, emissiveIntensity: 0.7 })); win.position.set(0.8, 0.95, 1.02); g.add(win);
      const chim = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.8, 0.35), mat(0x9a6b55)); chim.position.set(-0.7, 2.2, -0.2); g.add(chim);
      add(g, -9.3, -8.6, 0.55);
    }
    // 風車（右奥）
    {
      const g = new THREE.Group();
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.15, 3.2, 8), mat(0xf6efe2)); tower.position.y = 1.6; g.add(tower);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1, 8), mat(0x4d8bff, { flatShading: true })); cap.position.y = 3.65; g.add(cap);
      const hub = new THREE.Group(); hub.position.set(0, 3.2, 0.95);
      const hubBall = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), mat(0x444)); hub.add(hubBall);
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.9, 0.05), mat(0xffffff)); blade.position.y = 1.05;
        const arm = new THREE.Group(); arm.rotation.z = (i * Math.PI) / 2; arm.add(blade); hub.add(arm);
      }
      g.add(hub); this.windmill = hub;
      add(g, 9.6, -8.8, -0.3);
    }
    // 石灯籠
    const lantern = () => {
      const g = new THREE.Group(); const st = mat(0xb4b0a8, { roughness: 0.95 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.2, 8), st); base.position.y = 0.1; g.add(base);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.7, 8), st); post.position.y = 0.55; g.add(post);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.38, 0.46), new THREE.MeshStandardMaterial({ color: 0xffe3a0, emissive: 0xffb84d, emissiveIntensity: 0.9 })); lamp.position.y = 1.08; g.add(lamp);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.46, 0.34, 4), st); hat.position.y = 1.44; hat.rotation.y = Math.PI / 4; g.add(hat);
      return g;
    };
    [[-10, -0.2], [10.3, 0.8], [-3.2, -10.2], [4.2, -10.4]].forEach(([x, z]) => add(lantern(), x, z));

    // 岩と低木
    const rockMat = mat(0x9b9a97, { flatShading: true, roughness: 1 });
    [[-11.5, 9.5, 1], [11.4, 10.8, 1.3], [11.3, -10.8, 0.9], [-11.2, -11.2, 1.1], [-6, 11.5, 0.7], [0, 11.3, 0.6]].forEach(([x, z, s]) => {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7 * s, 0), rockMat); r.scale.set(1.3, 0.8, 1); r.position.y = 0.3 * s; r.rotation.y = rr() * 6;
      const g = new THREE.Group(); g.add(r); add(g, x, z);
    });
    [[-8.6, 9.3], [9, 9.2], [-11.8, 1.4], [12, -1], [11.7, 7.6], [-7.6, -11.6]].forEach(([x, z]) => {
      const g = new THREE.Group();
      for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42 + rr() * 0.2, 1), mat(0x4f9d4d, { flatShading: true })); b.position.set((rr() - 0.5) * 0.7, 0.35, (rr() - 0.5) * 0.7); g.add(b); }
      add(g, x, z);
    });
  }

  // ---------------------------------------------------------------- 舞う花びら
  buildPetals() {
    const N = 70, geo = new THREE.BufferGeometry();
    this.petalPos = new Float32Array(N * 3); this.petalVel = [];
    const rr = mulberry32(71);
    for (let i = 0; i < N; i++) {
      this.petalPos.set([(rr() - 0.5) * 30, rr() * 14, (rr() - 0.5) * 30], i * 3);
      this.petalVel.push([(rr() - 0.3) * 0.5, -0.5 - rr() * 0.5, (rr() - 0.5) * 0.4, rr() * 6]);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.petalPos, 3));
    this.petals = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffc2d6, size: 0.22, transparent: true, opacity: 0.9, depthWrite: false }));
    this.petals.frustumCulled = false;
    this.scene.add(this.petals);
  }

  // ---------------------------------------------------------------- パーティクル（砂ぼこり・煙・紙吹雪）
  buildParticles() {
    const MAX = 500;
    this.pMax = MAX;
    this.pPos = new Float32Array(MAX * 3); this.pCol = new Float32Array(MAX * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const dot = canvasTex(64, 64, (ctx) => { const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64); });
    this.pPoints = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.42, map: dot, vertexColors: true, transparent: true, depthWrite: false }));
    this.pPoints.frustumCulled = false;
    this.scene.add(this.pPoints);
    this.pData = Array.from({ length: MAX }, () => ({ life: 0 }));
    this.pPos.fill(-999);
  }
  burst(pos, { color = '#ffffff', n = 14, speed = 2.2, life = 0.7, up = 1.2, gravity = 3, spread = 1 } = {}) {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.pData.findIndex((d) => d.life <= 0);
      if (i < 0) return;
      const a = Math.random() * TAU, s = (0.4 + Math.random() * 0.8) * speed * spread;
      Object.assign(this.pData[i], { life: life * (0.6 + Math.random() * 0.6), max: life, vx: Math.cos(a) * s, vy: up * (0.5 + Math.random()), vz: Math.sin(a) * s, g: gravity, x: pos.x, y: pos.y, z: pos.z });
      this.pCol.set([c.r, c.g, c.b], i * 3);
    }
  }

  // ---------------------------------------------------------------- 方向の矢印（自分の番）
  buildArrows() {
    this.arrows = {};
    const mkArrow = (dir, color) => {
      const g = new THREE.Group();
      const shape = new THREE.Shape(); shape.moveTo(0.55, 0); shape.lineTo(-0.25, 0.5); shape.lineTo(-0.05, 0); shape.lineTo(-0.25, -0.5); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.04, bevelSegments: 2 });
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.35 }));
      m.castShadow = true; m.userData.dir = dir; g.add(m);
      // 当たり判定を少し大きく
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.6, 12), new THREE.MeshBasicMaterial({ visible: false })); hit.userData.dir = dir; hit.position.y = 0.2; g.add(hit);
      g.visible = false; this.scene.add(g);
      return { group: g, mesh: m, hit, dir };
    };
    this.arrows.cw = mkArrow('cw', 0xff8a3d);
    this.arrows.ccw = mkArrow('ccw', 0x2ec4b6);
  }

  /** 自分の番：両隣に矢印を出す。id=null で消す。 */
  showChoice(id) {
    this.choiceId = id;
    for (const k of ['cw', 'ccw']) this.arrows[k].group.visible = !!id && !!this.robots.get(id);
  }
  setHoverDir(dir) { this.hoverDir = dir; }
  onPick(fn) { this.pickHandler = fn; }

  bindPicking() {
    const ray = new THREE.Raycaster(), v = new THREE.Vector2();
    let down = null;
    const at = (e) => { const r = this.canvas.getBoundingClientRect(); v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(v, this.camera); };
    this.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }   // ドラッグは無視
      down = null;
      if (!this.choiceId || !this.pickHandler) return;
      at(e);
      const hits = ray.intersectObjects([this.arrows.cw.hit, this.arrows.cw.mesh, this.arrows.ccw.hit, this.arrows.ccw.mesh], false);
      if (hits.length) this.pickHandler(hits[0].object.userData.dir);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.choiceId) { this.canvas.style.cursor = ''; return; }
      at(e);
      const hit = ray.intersectObjects([this.arrows.cw.hit, this.arrows.ccw.hit], false)[0];
      this.hoverDir3d = hit ? hit.object.userData.dir : null;
      this.canvas.style.cursor = hit ? 'pointer' : '';
    });
  }

  // ---------------------------------------------------------------- サイコロ（3D）
  buildDice() {
    const pipsOn = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    const face = (n) => canvasTex(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#fffdf7'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#e4dccb'; ctx.lineWidth = 8; ctx.strokeRect(0, 0, w, h);
      for (const k of pipsOn[n]) {
        const x = 32 + (k % 3) * 32, y = 32 + Math.floor(k / 3) * 32;
        ctx.beginPath(); ctx.arc(x, y, 11, 0, TAU); ctx.fillStyle = n === 1 ? '#e63946' : '#26303f'; ctx.fill();
      }
    });
    // BoxGeometry の面順: +x,-x,+y,-y,+z,-z
    const faces = [3, 4, 1, 6, 2, 5].map((n) => new THREE.MeshStandardMaterial({ map: face(n), roughness: 0.35 }));
    const die = this.die = new THREE.Mesh(new RoundedBoxGeometry(1.05, 1.05, 1.05, 4, 0.16), faces);
    die.castShadow = true; die.visible = false; this.scene.add(die);
    // 出目 n の面が上(+y)に来る回転
    const e = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
    this.dieUp = { 1: e(0, 0, 0), 6: e(Math.PI, 0, 0), 2: e(-Math.PI / 2, 0, 0), 5: e(Math.PI / 2, 0, 0), 3: e(0, 0, Math.PI / 2), 4: e(0, 0, -Math.PI / 2) };
  }

  buildCounter() {                              // 「あと n マス」の丸い表示
    this.counter = { sprite: null, n: -1 };
    const c = document.createElement('canvas'); c.width = c.height = 128;
    this.counterCtx = c.getContext('2d'); this.counterTex = new THREE.CanvasTexture(c); this.counterTex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.counterTex, transparent: true, depthTest: false }));
    sp.scale.set(1.25, 1.25, 1); sp.visible = false; sp.renderOrder = 10;
    this.scene.add(sp); this.counter.sprite = sp;
  }
  setCounter(robot, n, color) {
    const sp = this.counter.sprite;
    if (!robot || n == null) { sp.visible = false; this.counter.robot = null; return; }
    this.counter.robot = robot;
    if (this.counter.n !== n || this.counter.color !== color) {
      const ctx = this.counterCtx; ctx.clearRect(0, 0, 128, 128);
      ctx.beginPath(); ctx.arc(64, 64, 56, 0, TAU); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 8; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '900 72px "Hiragino Maru Gothic ProN","Noto Sans JP",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), 64, 70);
      this.counterTex.needsUpdate = true; this.counter.n = n; this.counter.color = color;
    }
    sp.visible = true;
  }

  // ============================================================== ロボット
  makeRobot(colorHex, variant) {
    const col = new THREE.Color(colorHex);
    const light = col.clone().lerp(new THREE.Color('#ffffff'), 0.4);
    const mMain = new THREE.MeshStandardMaterial({ color: col, roughness: 0.38, metalness: 0.12 });
    const mLight = new THREE.MeshStandardMaterial({ color: light, roughness: 0.34, metalness: 0.1 });
    const mDark = new THREE.MeshStandardMaterial({ color: 0x2d3343, roughness: 0.55, metalness: 0.35 });
    const mScreen = new THREE.MeshStandardMaterial({ color: 0x0d121b, roughness: 0.2, metalness: 0.5 });
    const mGlow = new THREE.MeshStandardMaterial({ color: 0xaaf7ff, emissive: 0x58e6ff, emissiveIntensity: 1.7 });
    const mAcc = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.9 });
    const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    const add = (geo, m, x, y, z, parent = body) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o; };

    // 足
    [-1, 1].forEach((s) => { add(new RoundedBoxGeometry(0.36, 0.2, 0.52, 3, 0.07), mDark, s * 0.27, 0.1, 0.05); add(new THREE.CylinderGeometry(0.09, 0.1, 0.28, 8), mDark, s * 0.27, 0.32, 0); });
    // 胴
    add(new RoundedBoxGeometry(0.98, 0.8, 0.74, 5, 0.22), mMain, 0, 0.9, 0);
    add(new RoundedBoxGeometry(0.52, 0.32, 0.06, 3, 0.05), mLight, 0, 0.88, 0.37);
    add(new THREE.SphereGeometry(0.075, 10, 8), mAcc, 0, 0.88, 0.41);
    add(new THREE.CylinderGeometry(0.13, 0.15, 0.14, 8), mDark, 0, 1.36, 0);
    // 頭
    const head = new THREE.Group(); head.position.y = 1.82; body.add(head);
    add(new RoundedBoxGeometry(1.14, 0.82, 0.9, 5, 0.27), mLight, 0, 0, 0, head);
    add(new RoundedBoxGeometry(0.88, 0.52, 0.08, 3, 0.1), mScreen, 0, 0.02, 0.44, head);
    const eyes = new THREE.Group(); eyes.position.set(0, 0.06, 0.5); head.add(eyes);
    [-1, 1].forEach((s) => add(new RoundedBoxGeometry(0.15, 0.21, 0.04, 2, 0.05), mGlow, s * 0.21, 0.02, 0, eyes));
    const mouth = add(new RoundedBoxGeometry(0.22, 0.045, 0.03, 2, 0.02), mGlow, 0, -0.15, 0.5, head);
    const xeyes = new THREE.Group(); xeyes.position.set(0, 0.06, 0.5); xeyes.visible = false; head.add(xeyes);
    const mRed = new THREE.MeshStandardMaterial({ color: 0xff6b6b, emissive: 0xff3b3b, emissiveIntensity: 1.5 });
    [-1, 1].forEach((s) => [0.7, -0.7].forEach((r) => { const b = add(new THREE.BoxGeometry(0.24, 0.045, 0.03), mRed, s * 0.21, 0.02, 0, xeyes); b.rotation.z = r; }));
    [-1, 1].forEach((s) => { const ear = add(new THREE.CylinderGeometry(0.14, 0.14, 0.17, 12), mMain, s * 0.62, 0, 0, head); ear.rotation.z = Math.PI / 2; });
    // 頭の飾り（個体ごとに違う）
    let spin = null;
    switch (variant % 8) {
      case 0: add(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 6), mDark, 0, 0.55, 0, head); add(new THREE.SphereGeometry(0.1, 10, 8), mAcc, 0, 0.76, 0, head); break;
      case 1: [-1, 1].forEach((s) => { const g = new THREE.Group(); g.position.set(s * 0.25, 0.4, 0); g.rotation.z = -s * 0.35; head.add(g); add(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 6), mDark, 0, 0.2, 0, g); add(new THREE.SphereGeometry(0.085, 10, 8), mAcc, 0, 0.42, 0, g); }); break;
      case 2: [-1, 1].forEach((s) => { const c = add(new THREE.ConeGeometry(0.17, 0.3, 4), mMain, s * 0.34, 0.54, 0, head); c.rotation.z = -s * 0.25; c.rotation.y = Math.PI / 4; }); break;
      case 3: add(new RoundedBoxGeometry(0.08, 0.34, 0.62, 2, 0.03), mMain, 0, 0.55, 0, head); break;
      case 4: { add(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 6), mDark, 0, 0.5, 0, head); spin = new THREE.Group(); spin.position.y = 0.62; head.add(spin); [0, Math.PI / 2].forEach((r) => { const b = add(new THREE.BoxGeometry(0.62, 0.025, 0.1), mAcc, 0, 0, 0, spin); b.rotation.y = r; }); break; }
      case 5: { const d = add(new THREE.SphereGeometry(0.2, 12, 8, 0, TAU, 0, Math.PI / 2), mAcc, 0, 0.4, 0, head); d.scale.y = 1.1; break; }
      case 6: add(new THREE.ConeGeometry(0.1, 0.4, 8), mAcc, 0, 0.6, 0, head); break;
      default: add(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), mDark, 0, 0.5, 0, head); add(new THREE.SphereGeometry(0.15, 10, 8), mLight, 0, 0.7, 0, head);
    }
    // 腕（肩を支点に回転）
    const arms = [-1, 1].map((s) => {
      const a = new THREE.Group(); a.position.set(s * 0.62, 1.2, 0); body.add(a);
      add(new THREE.CapsuleGeometry(0.1, 0.32, 4, 8), mMain, 0, -0.24, 0, a);
      add(new THREE.SphereGeometry(0.15, 10, 8), mLight, 0, -0.52, 0, a);
      return a;
    });
    root.scale.setScalar(0.82);
    return { root, body, head, eyes, xeyes, mouth, armL: arms[0], armR: arms[1], spin, mats: [mMain, mLight] };
  }

  makeLabelTexture() {
    const c = document.createElement('canvas'); c.width = 340; c.height = 124;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    return { c, tex };
  }
  drawLabel(r) {
    const { c, tex } = r.label; const ctx = c.getContext('2d'); const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const rad = 30;
    ctx.beginPath(); ctx.roundRect(6, 6, w - 12, h - 12, rad);
    ctx.fillStyle = r.alive ? 'rgba(22,28,42,.82)' : 'rgba(60,60,60,.7)'; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = r.color; ctx.stroke();
    let fs = 38; ctx.font = `800 ${fs}px "Hiragino Maru Gothic ProN","Noto Sans JP",sans-serif`;
    while (ctx.measureText(r.name).width > w - 50 && fs > 20) { fs -= 2; ctx.font = `800 ${fs}px "Hiragino Maru Gothic ProN","Noto Sans JP",sans-serif`; }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(r.name, w / 2, 44);
    for (let i = 0; i < START_LIVES; i++) drawHeart(ctx, w / 2 + (i - 1) * 50, 90, 34, i < r.lives ? '#ff3b57' : '#7b8494');
    tex.needsUpdate = true;
  }

  addRobot(p) {
    const variant = p.color;
    const parts = this.makeRobot(PALETTE[p.color % PALETTE.length], variant);
    const label = this.makeLabelTexture();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: label.tex, transparent: true, depthTest: false }));
    sprite.scale.set(2.6, 0.95, 1); sprite.position.y = 2.75; sprite.renderOrder = 9;
    parts.root.add(sprite);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 1.0, 40), new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; ring.visible = false; parts.root.add(ring);
    const hand = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false })); hand.scale.set(1.5, 1.5, 1); hand.position.y = 4.1; hand.visible = false; hand.renderOrder = 12;
    parts.root.add(hand);
    const r = {
      id: p.id, name: p.name, color: PALETTE[p.color % PALETTE.length], colorIdx: p.color, lives: p.lives, alive: p.alive, tile: p.tile ?? 0,
      ...parts, label, sprite, ring, hand, base: new THREE.Vector3(), yaw: 0, yawTarget: 0, fx: { y: 0, sy: 0, armR: 0, armL: 0, shake: 0, spin: 0, flash: 0, tilt: 0, scale: 1 },
      hopping: null, phase: Math.random() * 10, mood: null
    };
    this.drawLabel(r);
    this.scene.add(parts.root);
    this.robots.set(p.id, r);
    return r;
  }
  removeRobot(id) {
    const r = this.robots.get(id); if (!r) return;
    this.scene.remove(r.root); r.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.robots.delete(id);
  }

  /** 同じ石にいるロボを並べる位置（石の中心＋少しずらし） */
  slotPos(r) {
    const mates = [...this.robots.values()].filter((o) => o.alive && o.tile === r.tile && !o.gone).sort((a, b) => (a.id < b.id ? -1 : 1));
    const n = mates.length, i = Math.max(0, mates.indexOf(r));
    const c = tilePos(r.tile);
    if (n <= 1) return c;
    const a = tileAngle(r.tile);
    const tan = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), rad = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    if (n === 2) return c.addScaledVector(tan, (i - 0.5) * 1.0);
    const t = (i / n) * TAU + Math.PI / 2, R = n === 3 ? 0.62 : 0.7;
    return c.addScaledVector(tan, Math.cos(t) * R).addScaledVector(rad, Math.sin(t) * R * 0.9);
  }

  // ============================================================== 状態の同期（演出なし）
  /** 参加者の見た目を最新に揃える。phase==='lobby' のときは輪の上に並べて見せる。 */
  sync(players, turnId, phase) {
    const ids = new Set(players.map((p) => p.id));
    for (const id of [...this.robots.keys()]) if (!ids.has(id)) this.removeRobot(id);
    players.forEach((p, i) => {
      const isNew = !this.robots.has(p.id);
      const r = this.robots.get(p.id) || this.addRobot({ ...p, tile: p.tile ?? 0 });
      r.name = p.name; r.lives = p.lives; r.alive = p.alive;
      const tile = p.tile ?? Math.floor((i * TILE_COUNT) / Math.max(1, players.length));
      if (!r.hopping) { r.tile = tile; r.gone = !p.alive; }
      r.root.visible = p.alive;
      r.xeyes.visible = false; r.eyes.visible = true;
      r.fx.scale = 1; r.fx.spin = 0; r.fx.y = 0;
      if (isNew) { r.yaw = r.yawTarget = tangentYaw(r.tile, 1); r.base.copy(this.slotPos(r)); }
      this.drawLabel(r);
    });
    this.robots.forEach((r) => { r.base.copy(this.slotPos(r)); });
    this.setTurn(turnId);
    this.celebrate = null;
    this.setCounter(null);
    this.die.visible = false;
    this.wantRotate = phase === 'lobby' || phase === 'over';
    if (phase === 'lobby') this.focus.set(0, 0.6, 0);
  }

  setTurn(id) {
    this.turnId = id;
    this.robots.forEach((r) => { r.ring.visible = r.id === id && r.alive; });
  }

  // ============================================================== 時間まわり
  /** ms かけて fn(0→1) を呼ぶ。実時間ベースなので、タブが裏にあっても復帰時に追いつく。 */
  tween(ms, fn, easing = (k) => k) {
    return new Promise((resolve) => this.tweens.push({ start: performance.now(), ms, fn, easing, resolve }));
  }
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ============================================================== 出来事の再生
  async play(ev) {
    switch (ev.t) {
      case 'start': return this.evStart(ev);
      case 'turn': return this.evTurn(ev);
      case 'roll': return this.evRoll(ev);
      case 'step': return this.evStep(ev);
      case 'jankenStart': return this.evJankenStart(ev);
      case 'jankenRound': return this.evJankenRound(ev);
      case 'jankenEnd': return this.evJankenEnd(ev);
      case 'eliminated': return this.evEliminated(ev);
      case 'win': return this.evWin(ev);
      case 'lobby': this.robots.forEach((_, id) => this.removeRobot(id)); this.celebrate = null; this.setTurn(null); this.setCounter(null); this.showChoice(null); this.wantRotate = true; this.focusDist = null; this.focus.set(0, 0.6, 0); return this.wait(ev.ms);
      default: return this.wait(ev.ms || 0);
    }
  }

  async evStart(ev) {
    this.celebrate = null; this.showChoice(null); this.setCounter(null);
    this.robots.forEach((_, id) => this.removeRobot(id));
    this.wantRotate = false; this.focusDist = null; this.focus.set(0, 0.6, 0);
    ev.players.forEach((p, i) => {
      const r = this.addRobot(p);
      r.tile = p.tile; r.base.copy(tilePos(p.tile));
      r.yaw = r.yawTarget = tangentYaw(p.tile, 1);
      r.fx.y = 14; r.root.visible = false;
    });
    this.robots.forEach((r) => { r.base.copy(this.slotPos(r)); });
    // 空から順に降ってくる
    const list = [...this.robots.values()];
    list.forEach((r, i) => {
      setTimeout(() => {
        r.root.visible = true;
        this.tween(800, (k) => { r.fx.y = 14 * (1 - ease.bounce(k)); }, (k) => k).then(() => {
          r.fx.y = 0; this.burst(r.base.clone().setY(TILE_TOP), { color: '#e8dcc0', n: 10, speed: 1.6 });
        });
      }, 200 + i * 170);
    });
    await this.wait(ev.ms);
  }

  async evTurn(ev) {
    this.setCounter(null); this.die.visible = false;
    this.setTurn(ev.id);
    const r = this.robots.get(ev.id);
    if (r) { this.focus.copy(r.base); this.focus.y = 0.8; this.focusDist = null; this.wantRotate = false; }
    await this.wait(ev.ms);
  }

  async evRoll(ev) {
    const r = this.robots.get(ev.id); if (!r) return this.wait(ev.ms);
    this.showChoice(null);
    // 選んだ向きを見る
    const a = tileAngle(r.tile), dirSign = ev.dir === 'cw' ? 1 : -1;
    r.yawTarget = Math.atan2(-Math.sin(a) * dirSign, Math.cos(a) * dirSign);
    // サイコロが頭上でころがって止まる
    const die = this.die; die.visible = true;
    const spinAxis = new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
    const final = this.dieUp[ev.dice];
    const origin = r.base.clone(); origin.y = 3.9;
    const q = new THREE.Quaternion();
    await this.tween(1000, (k) => {
      const kk = ease.out(k);
      const hop = Math.abs(Math.sin(k * Math.PI * 3)) * (1 - k) * 1.8;
      die.position.set(origin.x, origin.y + hop, origin.z);
      q.setFromAxisAngle(spinAxis, (1 - kk) * 14);
      die.quaternion.copy(q).multiply(final);
      die.scale.setScalar(1 + (1 - k) * 0.25);
    });
    die.quaternion.copy(final); die.scale.setScalar(1);
    this.burst(origin, { color: '#ffe38a', n: 12, speed: 1.4, up: 0.6, gravity: 1 });
    this.setCounter(r, ev.dice, r.color);
    // 出目を見せてから、ふわっと消す
    const remain = Math.max(0, ev.ms - 1000 - 400);
    await this.wait(remain);
    await this.tween(400, (k) => { die.position.y = origin.y + k * 1.2; die.scale.setScalar(1 - k); });
    die.visible = false;
  }

  async evStep(ev) {
    const r = this.robots.get(ev.id); if (!r) return this.wait(ev.ms);
    r.tile = ev.to;
    const from = r.base.clone();
    const to = this.slotPos(r);
    const dx = to.x - from.x, dz = to.z - from.z;
    r.yawTarget = Math.atan2(dx, dz);
    this.focus.lerp(to, 0.5);
    r.hopping = true;
    await this.tween(ev.ms, (k) => {
      r.base.set(lerp(from.x, to.x, k), lerp(from.y, to.y, k), lerp(from.z, to.z, k));
      r.fx.y = Math.sin(k * Math.PI) * 0.95;
      r.fx.sy = k < 0.15 ? -0.18 * (k / 0.15) : (k > 0.85 ? -0.18 * ((k - 0.85) / 0.15) : 0.1);
    });
    r.fx.y = 0; r.fx.sy = 0; r.hopping = null;
    this.burst(new THREE.Vector3(to.x, TILE_TOP, to.z), { color: '#e9dfc7', n: 6, speed: 1.1, up: 0.5, life: 0.5 });
    if (this.counter.robot === r) this.setCounter(r, ev.remaining, r.color);
    this.robots.forEach((o) => { if (o !== r && o.tile === r.tile) o.base.copy(this.slotPos(o)); });
  }

  // ---- ジャンケン ----
  pairFocus(ida, idb) {
    const a = this.robots.get(ida), b = this.robots.get(idb);
    if (!a || !b) return;
    this.focus.copy(a.base).add(b.base).multiplyScalar(0.5); this.focus.y = 1.0;
    this.focusDist = 15;
  }
  faceEachOther(ida, idb) {
    const a = this.robots.get(ida), b = this.robots.get(idb); if (!a || !b) return;
    const d = new THREE.Vector3().subVectors(b.base, a.base);
    if (d.lengthSq() < 0.01) { const an = tileAngle(a.tile); d.set(-Math.sin(an), 0, Math.cos(an)); }
    a.yawTarget = Math.atan2(d.x, d.z); b.yawTarget = Math.atan2(-d.x, -d.z);
  }
  async evJankenStart(ev) {
    this.setCounter(null);
    // 相手の近くへ寄る（同じ石の並び位置）
    this.robots.forEach((o) => o.base.copy(this.slotPos(o)));
    this.faceEachOther(ev.a, ev.b); this.pairFocus(ev.a, ev.b); this.wantRotate = false;
    const a = this.robots.get(ev.a), b = this.robots.get(ev.b);
    [a, b].forEach((r) => { if (!r) return; this.burst(r.base.clone().setY(2.6), { color: '#ffd24a', n: 8, speed: 1.2, up: 1.5, gravity: 0 }); });
    await this.tween(ev.ms, (k) => { [a, b].forEach((r) => { if (r) r.fx.armR = -1.35 * ease.out(Math.min(1, k * 2)); }); });
  }
  async evJankenRound(ev) {
    const a = this.robots.get(ev.a), b = this.robots.get(ev.b);
    this.faceEachOther(ev.a, ev.b); this.pairFocus(ev.a, ev.b);
    // じゃん・けん・ぽん（3回振る）
    const pumpMs = ev.ms * 0.5;
    await this.tween(pumpMs, (k) => { const v = -1.35 + Math.sin(k * Math.PI * 6) * 0.55; [a, b].forEach((r) => { if (r) { r.fx.armR = v; r.fx.y = Math.max(0, Math.sin(k * Math.PI * 6)) * 0.12; } }); });
    [a, b].forEach((r) => { if (r) { r.fx.armR = -1.35; r.fx.y = 0; } });
    // ぽん！手を見せる
    const emoji = { rock: '✊', scissors: '✌️', paper: '✋' };
    const show = (r, h) => { if (!r) return; r.hand.material.map = this.emojiTex(emoji[h]); r.hand.material.needsUpdate = true; r.hand.visible = true; r.hand.scale.set(0.01, 0.01, 1); };
    show(a, ev.ha); show(b, ev.hb);
    await this.tween(350, (k) => { const s = 1.7 * ease.out(k) * (1 + 0.25 * Math.sin(k * Math.PI)); [a, b].forEach((r) => { if (r) r.hand.scale.set(s, s, 1); }); });
    const win = ev.result === 'a' ? a : ev.result === 'b' ? b : null;
    const lose = ev.result === 'a' ? b : ev.result === 'b' ? a : null;
    if (win) this.burst(win.base.clone().setY(2.4), { color: '#ffd24a', n: 18, speed: 2.4, up: 2.2, gravity: 2 });
    const rest = Math.max(0, ev.ms - pumpMs - 350 - 450);
    await this.tween(rest, (k) => {
      if (win) { win.fx.y = Math.abs(Math.sin(k * Math.PI * 3)) * 0.7; win.fx.armL = -2.6; win.fx.armR = -2.6; }
      if (lose) { lose.fx.shake = Math.sin(k * 60) * 0.12 * (1 - k); lose.fx.flash = 0.5 * (1 - k); lose.fx.armR = 0.2; }
      if (!win) [a, b].forEach((r) => { if (r) r.fx.tilt = Math.sin(k * Math.PI * 4) * 0.18; });
    });
    [a, b].forEach((r) => { if (r) { r.hand.visible = false; r.fx.armR = 0; r.fx.armL = 0; r.fx.y = 0; r.fx.shake = 0; r.fx.flash = 0; r.fx.tilt = 0; } });
    if (ev.result === 'draw') { [a, b].forEach((r) => { if (r) r.fx.armR = -1.35; }); }
    await this.tween(450, () => {});
  }
  async evJankenEnd(ev) {
    const loser = this.robots.get(ev.loser), winner = this.robots.get(ev.winner);
    if (loser) {
      loser.lives = ev.lives; this.drawLabel(loser);
      this.burst(loser.base.clone().setY(2.8), { color: '#ff3b57', n: 16, speed: 1.8, up: 2.6, gravity: 2.5 });
      this.tween(600, (k) => { loser.fx.flash = 0.8 * (1 - k); loser.fx.tilt = Math.sin(k * Math.PI * 5) * 0.25 * (1 - k); });
    }
    this.robots.forEach((r) => { r.fx.armR = 0; });
    if (winner) winner.fx.armR = 0;
    await this.wait(ev.ms);
    this.focusDist = null;
  }
  async evEliminated(ev) {
    const r = this.robots.get(ev.id); if (!r) return this.wait(ev.ms);
    r.eyes.visible = false; r.xeyes.visible = true;
    this.burst(r.base.clone().setY(1.2), { color: '#9aa3b2', n: 30, speed: 2.6, up: 2.2, gravity: 0.5, life: 1.2 });
    this.pairFocus(ev.id, ev.id);
    await this.tween(ev.ms, (k) => {
      r.fx.spin = k * TAU * 3; r.fx.y = Math.sin(Math.min(1, k * 1.4) * Math.PI) * 1.6;
      r.fx.scale = k < 0.6 ? 1 : Math.max(0.001, 1 - (k - 0.6) / 0.4);
      r.fx.flash = 0.6 * (1 - k);
      if (k > 0.55 && !r._puff) { r._puff = true; this.burst(r.base.clone().setY(1), { color: '#ffffff', n: 26, speed: 2.4, up: 1.6, gravity: 0, life: 1 }); }
    });
    r._puff = false;
    r.alive = false; r.gone = true; r.root.visible = false; r.fx.scale = 1; r.fx.spin = 0; r.fx.y = 0; r.fx.flash = 0;
    this.drawLabel(r); this.setTurn(this.turnId);
    this.robots.forEach((o) => o.base.copy(this.slotPos(o)));
    this.focusDist = null;
  }
  async evWin(ev) {
    const r = this.robots.get(ev.id);
    this.setCounter(null); this.setTurn(null); this.focusDist = null;
    if (r) {
      this.focus.copy(r.base); this.focus.y = 1.2; this.focusDist = 13;
      this.celebrate = { id: ev.id, t0: performance.now() };
      for (let i = 0; i < 6; i++) setTimeout(() => this.confetti(r.base), i * 350);
    }
    this.wantRotate = true;
    await this.wait(ev.ms);
  }
  confetti(at) {
    const cols = ['#ff5a5f', '#ffd24a', '#2ec4b6', '#4d8bff', '#ff7eb6', '#a06bff'];
    cols.forEach((c) => this.burst(new THREE.Vector3(at.x, 4.5, at.z), { color: c, n: 10, speed: 3.2, up: 1, gravity: 4, life: 2.4, spread: 1.4 }));
  }

  emojiTex(ch) {
    this._emo = this._emo || {};
    if (!this._emo[ch]) {
      this._emo[ch] = canvasTex(128, 128, (ctx, w, h) => {
        ctx.beginPath(); ctx.arc(64, 64, 58, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = '#ffb703'; ctx.stroke();
        ctx.font = '78px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ch, 64, 72);
      });
    }
    return this._emo[ch];
  }

  // ============================================================== カメラ
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.fitCamera();
  }
  fitCamera() {                                  // 縦長画面でも輪がはみ出さないように、初期の距離を決める
    if (this._userMoved) return;
    const aspect = this.camera.aspect, vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const needW = 27, dist = Math.max(31, needW / (2 * Math.tan(vfov / 2) * aspect) + 4);
    const dir = new THREE.Vector3(0, 0.62, 0.78).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, Math.min(dist, 45));
  }

  // ============================================================== フレーム更新
  loop() {
    const nowT = performance.now(); const dt = Math.min((nowT - this._last) / 1000, 0.1); this._last = nowT;
    this.time += dt;
    const t = this.time, now = performance.now();

    // tween
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      const k = clamp01((now - tw.start) / Math.max(1, tw.ms));
      tw.fn(tw.easing(k));
      if (k >= 1) { this.tweens.splice(i, 1); tw.resolve(); }
    }

    // ロボット
    this.robots.forEach((r) => {
      const fx = r.fx;
      if (!r.hopping) r.base.lerp(this.slotPos(r), 1 - Math.exp(-7 * dt));
      r.yaw += angDiff(r.yaw, r.yawTarget) * (1 - Math.exp(-10 * dt));
      const idle = Math.sin(t * 2.4 + r.phase);
      r.root.position.set(r.base.x + fx.shake, r.base.y + fx.y, r.base.z);
      r.root.rotation.set(0, r.yaw + fx.spin, fx.tilt);
      r.root.scale.setScalar(fx.scale);
      r.body.position.y = r.hopping ? 0 : 0.035 * idle;
      r.body.scale.set(1 - fx.sy * 0.5, 1 + fx.sy, 1 - fx.sy * 0.5);
      r.armR.rotation.x = fx.armR + (fx.armR === 0 ? Math.sin(t * 2.4 + r.phase + 1) * 0.08 : 0);
      r.armL.rotation.x = fx.armL + (fx.armL === 0 ? Math.sin(t * 2.4 + r.phase) * 0.08 : 0);
      r.armL.rotation.z = 0.08; r.armR.rotation.z = -0.08;
      r.head.rotation.z = Math.sin(t * 1.3 + r.phase) * 0.03;
      if (r.spin) r.spin.rotation.y = t * 14;
      // まばたき
      const blink = (Math.floor((t + r.phase) * 10) % 40) === 0 ? 0.1 : 1;
      r.eyes.scale.y = blink;
      for (const m of r.mats) m.emissive.setRGB(fx.flash, fx.flash * 0.1, fx.flash * 0.1);
      // 手番リング
      if (r.ring.visible) { r.ring.rotation.z = t * 1.5; const s = 1 + Math.sin(t * 4) * 0.06; r.ring.scale.set(s, s, s); }
      r.sprite.position.y = 2.75 + 0.05 * Math.sin(t * 2 + r.phase);
    });

    // 優勝のダンス
    if (this.celebrate) {
      const r = this.robots.get(this.celebrate.id);
      if (r) { r.fx.y = Math.abs(Math.sin(t * 5)) * 0.8; r.fx.armL = -2.7 + Math.sin(t * 10) * 0.3; r.fx.armR = -2.7 - Math.sin(t * 10) * 0.3; r.fx.spin = Math.sin(t * 2.5) * 0.6; r.yawTarget = 0.0; }
      if (Math.random() < 0.05) this.confetti(r ? r.base : new THREE.Vector3());
    }

    // 矢印（自分の番）
    if (this.choiceId) {
      const r = this.robots.get(this.choiceId);
      if (r) {
        for (const dir of ['cw', 'ccw']) {
          const s = dir === 'cw' ? 1 : -1, tile = (r.tile + s + TILE_COUNT) % TILE_COUNT;
          const p = tilePos(tile, RING_R); const a = tileAngle(tile);
          const hov = this.hoverDir === dir || this.hoverDir3d === dir;
          const A = this.arrows[dir];
          A.group.position.set(p.x, TILE_TOP + 0.35 + Math.sin(t * 5 + (s > 0 ? 0 : 1.5)) * 0.1, p.z);
          // 進行方向（接線）に矢じりを向ける。矢の+xが向く先: (−sin a·s, cos a·s)
          A.group.rotation.y = -Math.atan2(Math.cos(a) * s, -Math.sin(a) * s);
          const sc = hov ? 1.5 : 1.15 + Math.sin(t * 5) * 0.08; A.group.scale.setScalar(sc);
          A.mesh.material.emissiveIntensity = hov ? 1.2 : 0.55;
        }
      }
    }
    if (this.hoverDir == null && this.hoverDir3d == null) { /* noop */ }

    // サイコロの出目マーク
    if (this.counter.robot) { const r = this.counter.robot; this.counter.sprite.position.set(r.root.position.x + 1.0, r.root.position.y + 3.9 + Math.sin(t * 3) * 0.08, r.root.position.z); }

    // 池
    if (this.koi) this.koi.forEach((k, i) => { const a = t * k.sp + k.ph; k.fish.position.set(Math.cos(a) * k.r, 0.21 + Math.sin(t * 2 + i) * 0.015, Math.sin(a) * k.r); k.fish.rotation.y = Math.atan2(-Math.cos(a) * Math.sign(k.sp), -Math.sin(a) * Math.sign(k.sp)); });
    if (this.water) this.water.material.opacity = 0.86 + Math.sin(t * 1.5) * 0.04;
    if (this.windmill) this.windmill.rotation.z -= dt * 0.9;

    // 花びら
    const pp = this.petalPos;
    for (let i = 0; i < this.petalVel.length; i++) {
      const v = this.petalVel[i];
      pp[i * 3] += (v[0] + Math.sin(t * 0.8 + v[3]) * 0.4) * dt; pp[i * 3 + 1] += v[1] * dt; pp[i * 3 + 2] += (v[2] + Math.cos(t * 0.7 + v[3]) * 0.3) * dt;
      if (pp[i * 3 + 1] < 0.1) { pp[i * 3 + 1] = 13 + Math.random() * 3; pp[i * 3] = (Math.random() - 0.5) * 30; pp[i * 3 + 2] = (Math.random() - 0.5) * 30; }
    }
    this.petals.geometry.attributes.position.needsUpdate = true;

    // パーティクル
    let any = false;
    for (let i = 0; i < this.pMax; i++) {
      const d = this.pData[i];
      if (d.life > 0) {
        d.life -= dt; any = true;
        d.vy -= d.g * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        if (d.y < 0.05) { d.y = 0.05; d.vy *= -0.3; d.vx *= 0.8; d.vz *= 0.8; }
        this.pPos[i * 3] = d.x; this.pPos[i * 3 + 1] = d.y; this.pPos[i * 3 + 2] = d.z;
        if (d.life <= 0) this.pPos[i * 3 + 1] = -999;
      }
    }
    if (any || this._pDirty) { this.pPoints.geometry.attributes.position.needsUpdate = true; this.pPoints.geometry.attributes.color.needsUpdate = true; this._pDirty = any; }

    // カメラ：注目点へなめらかに / 寄り
    this.controls.target.lerp(this.focus, 1 - Math.exp(-3 * dt));
    if (this.focusDist) {
      const off = this.camera.position.clone().sub(this.controls.target);
      const d = off.length(), nd = lerp(d, this.focusDist, 1 - Math.exp(-2.5 * dt));
      this.camera.position.copy(this.controls.target).addScaledVector(off.normalize(), nd);
    }
    this.controls.autoRotate = !!this.wantRotate && !this.choiceId && !this.focusDist;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import { createState, TIME_DIVS } from "./core/state.js";
import { bandValues } from "./core/fft.js";
import { advanceSweep, fireTrigger, isBlanked, armSingle } from "./core/trigger.js";
import { waveform, coupled, trigCoupled } from "./core/signal.js";
import { buildTrace } from "./core/mesh.js";

/* ════════════════════════════════════════════════════════════════
   CRT OSCILLOSCOPE — Virtual Room
   Рендер + панель + аудио (three.js / DOM / WebAudio).
   Вся логика сигналов — в core/ (signal, fft, trigger, mesh, state).
   Ядро без three.js — портируется в Android.
   ════════════════════════════════════════════════════════════════ */

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(6, 4, 8);
camera.lookAt(0, 1, 0);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.enableZoom = false;              // зум свой — плавный (ниже)
controls.target.set(0, 1, 0);
controls.maxPolarAngle = Math.PI * 0.85;

/* ── Плавный зум (как в ether-resonance): колёсико + пинч ─────── */
let targetZoomDistance = camera.position.distanceTo(controls.target);
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  targetZoomDistance = Math.max(2, Math.min(targetZoomDistance * Math.exp(e.deltaY * 0.0008), 30));
}, { passive: false });

let pinchDist = null;
canvas.addEventListener("touchstart", e => {
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchDist = Math.hypot(dx, dy);
  }
}, { passive: true });
canvas.addEventListener("touchmove", e => {
  if (e.touches.length === 2 && pinchDist !== null) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const cur = Math.hypot(dx, dy);
    targetZoomDistance = Math.max(2, Math.min(targetZoomDistance * pinchDist / cur, 30));
  }
}, { passive: false });
canvas.addEventListener("touchend", () => { pinchDist = null; });

/* ── Комната: пол + стены из точек (каркас для трассы) ─────── */
const GRID = 24;
const roomPoints = [];
function pushLine(points) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const steps = GRID;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      roomPoints.push(new THREE.Vector3(
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t
      ));
    }
  }
}

/* Комната 6×4×3: стены с окном-дырой слева, пол, потолок-дуга */
const W = 3, D = 2, H = 1.6;
pushLine([[-W, 0, -D], [W, 0, -D]]);                 // пол зад
pushLine([[W, 0, -D], [W, 0, D]]);                   // пол право
pushLine([[W, 0, D], [-W, 0, D]]);                   // пол перед
pushLine([[-W, 0, D], [-W, 0, -D]]);                 // пол лево
pushLine([[-W, H, -D], [W, H, -D]]);                 // потолок зад
pushLine([[W, H, -D], [W, H, D]]);                   // потолок право
pushLine([[W, H, D], [-W, H, D]]);                   // потолок перед
pushLine([[-W, H, D], [-W, H, -D]]);                 // потолок лево
pushLine([[-W, 0, -D], [-W, H, -D]]);                // стена зад-лево
pushLine([[W, 0, -D], [W, H, -D]]);                  // стена зад-право
pushLine([[W, 0, D], [W, H, D]]);                    // стена перед-право
pushLine([[-W, 0, D], [-W, 0.8, D]]);                // стена перед-лево (низ)
pushLine([[-W, 1.1, D], [-W, H, D]]);                // стена перед-лево (верх)
pushLine([[-W, 0, -D], [-W, H, -D]]);                // стена зад-лево
/* Объект: колонна в центре */
pushLine([[0, 0, -1], [0, H * 0.7, -1]]);
pushLine([[0, 0, 0.4], [0, H * 0.7, 0.4]]);
pushLine([[0, 0, -1], [0, 0, 0.4]]);
pushLine([[0, H * 0.7, -1], [0, H * 0.7, 0.4]]);

/* Точки меша — сегменты, по которым бежит трасса (для core) */
const meshPoints = roomPoints;

/* Невидимый Points-объект из тех же точек — для рейкаста тапа */
const raycastPoints = new THREE.Points(
  new THREE.BufferGeometry().setFromPoints(meshPoints),
  new THREE.PointsMaterial({ size: 0.02, transparent: true, opacity: 0, depthWrite: false })
);
raycastPoints.visible = false;
scene.add(raycastPoints);

/* Каркас комнаты (визуально, тонкий) */
{
  const geom = new THREE.BufferGeometry();
  const verts = [];
  const lines = [
    [-W,0,-D, W,0,-D],[W,0,-D, W,0,D],[W,0,D, -W,0,D],[-W,0,D, -W,0,-D],
    [-W,H,-D, W,H,-D],[W,H,-D, W,H,D],[W,H,D, -W,H,D],[-W,H,D, -W,H,-D],
    [-W,0,-D, -W,H,-D],[W,0,-D, W,H,-D],[W,0,D, W,H,D],
    [-W,0,D, -W,0.8,D],[-W,1.1,D, -W,H,D],
    [0,0,-1, 0,H*0.7,-1],[0,0,0.4, 0,H*0.7,0.4],[0,0,-1, 0,0,0.4],[0,H*0.7,-1, 0,H*0.7,0.4],
  ];
  for (const [x1,y1,z1, x2,y2,z2] of lines) verts.push(x1,y1,z1, x2,y2,z2);
  geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x2a3a2a, transparent: true, opacity: 0.35 });
  scene.add(new THREE.LineSegments(geom, mat));
}

/* Grid floor helper */
const gridHelper = new THREE.GridHelper(8, 20, 0x1a3a1a, 0x12221a);
gridHelper.position.y = -0.01;
scene.add(gridHelper);

/* ── Фосфорная трасса ─────────────────────────────────────────── */
const TRACE_N = 420;             // точек в трассе
const TRAIL = 14;                // слоёв шлейфа
/* Фосфоры: цвет + базовая персистентность (τ в мс).
   Реальные P-типы: P1 долгий (1-100мс), P31 быстрый (0.01-1мс, жёлто-зелёный),
   P4 короткий (белый), P11 быстрый (синий). */
const PHOSPHORS = {
  p1:  { color: 0x33ff00, tau: 40, boost: 1 },
  p31: { color: 0xffb000, tau: 6,  boost: 1.35 },
  p4:  { color: 0xd0e8ff, tau: 12, boost: 1 },
  p11: { color: 0x4a9eff, tau: 8,  boost: 1.1 },
};
let phosphorKey = "p1";
let phosphor = PHOSPHORS.p1.color;
let phosphorTau = PHOSPHORS.p1.tau;
let phosphorBoost = 1;
let phosphorDim = 1; /* затухание фосфора по wall-clock: гаснет, когда луч не рисует */

const trailGroup = new THREE.Group();
scene.add(trailGroup);
const trailLines = [];
window.__scope = () => ({
  phosphorDim,
  t: S.t,
  blanked: S.blanked,
  sweepActive: S.sweepActive,
  op0: trailLines[0] ? trailLines[0].mat.opacity : -1,
  headOp: headMat.opacity,
  dotOp: headDotMat.opacity,
});
for (let i = 0; i < TRAIL; i++) {
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(TRACE_N * 3);
  const col = new Float32Array(TRACE_N * 3).fill(1);
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ color: phosphor, vertexColors: true, transparent: true, opacity: 0 });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;
  trailGroup.add(line);
  trailLines.push({ line, mat });
}

/* Головной луч (яркая точка + короткая яркая линия) */
const headGeom = new THREE.BufferGeometry();
headGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
const headMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, transparent: true, opacity: 0.9 });
const headLine = new THREE.Line(headGeom, headMat);
scene.add(headLine);

/* Яркая точка-огонёк во главе луча */
const headDotGeom = new THREE.SphereGeometry(0.07, 8, 8);
const headDotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
const headDot = new THREE.Mesh(headDotGeom, headDotMat);
scene.add(headDot);

/* ── Видимые точки меша (фосфорные точки по трассе) ────────────── */
const dotGeom = new THREE.BufferGeometry().setFromPoints(meshPoints);
const dotMat = new THREE.PointsMaterial({
  color: phosphor,
  size: 0.04,
  transparent: true,
  opacity: 0.5,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const dotPoints = new THREE.Points(dotGeom, dotMat);
scene.add(dotPoints);

/* ── Bloom (неоновый ореол) ────────────────────────────────────── */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.1, 0.4, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ── AR точки и слепки пространства ─────────────────────────────── */
let arPoints = [];                          // массив помеченных точек [{x,y,z}, ...]
const MAX_AR_POINTS = 3;                    // свет бегает между последними 3 точками

/* Сфера-маркер при тапе */
const markerGeom = new THREE.SphereGeometry(0.1, 8, 8);
const markerMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const markersGroup = new THREE.Group();
scene.add(markersGroup);

/* Луч между последними точками */
const lineGeom = new THREE.BufferGeometry();
const linePos = new Float32Array(MAX_AR_POINTS * 3 * 2);
lineGeom.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
const lineMat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2, transparent: true, opacity: 0.9 });
const arLine = new THREE.Line(lineGeom, lineMat);
scene.add(arLine);

/* ── Аудио ─────────────────────────────────────────────────────── */
let audio = null, analyser = null, freqData = null;
const audioBtn = document.getElementById("btn-audio");

async function initAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    src.connect(analyser);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    audio = { ctx };
    audioBtn.textContent = "🎤 МИКРОФОН: ON";
    audioBtn.classList.add("rec");
    ctx.resume();
  } catch (e) {
    audioBtn.textContent = "🎤 НЕТ ДОСТУПА К МИКРОФОНУ";
    audio = null;
  }
}
audioBtn.addEventListener("click", initAudio);

/* ── Состояние (ядро) ──────────────────────────────────────────── */
const S = createState({ touchPos: null });
window.__S__ = S;

/* ── Параметры из панели ───────────────────────────────────────── */
function bindSlider(id, key) {
  const el = document.getElementById(id);
  const val = document.getElementById("val-" + id);
  el.addEventListener("input", () => {
    S[key] = Number(el.value) / 100;
    val.textContent = el.value;
  });
}
bindSlider("intensity", "intensity");
bindSlider("persistence", "persistence");
bindSlider("focus", "focus");
bindSlider("jitter", "jitter");
bindSlider("level", "level");
bindSlider("pos-v", "vPos");
bindSlider("pos-h", "hPos");

/* Ступенчатые переключатели TIME/DIV и VOLTS/DIV (как на приборе) */
function bindSeg(id, key, attr, onChange) {
  document.getElementById(id).addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const v = b.dataset[attr];
    S[key] = isNaN(Number(v)) ? v : Number(v);
    document.querySelectorAll("#" + id + " button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    if (onChange) onChange(S[key]);
  });
}
bindSeg("seg-td", "tdIdx", "td");
bindSeg("seg-vpd", "vpdIdx", "vpd");
bindSeg("seg-sweep", "sweepMode", "sweep", () => {
  if (S.sweepMode === "single") armSingle(S);
});
bindSeg("seg-slope", "slope", "slope");
bindSeg("seg-coupling", "coupling", "coupling");
bindSeg("seg-trig-coupling", "trigCoupling", "trigCoupling");

/* VARIABLE — плавные ручки (uncalibrated, как у настоящего прибора):
   TIME/DIV только замедляет, VOLTS/DIV только ослабляет (1..2.5) */
function bindVar(id, key) {
  const el = document.getElementById(id);
  const val = document.getElementById("val-" + id);
  el.addEventListener("input", () => {
    S[key] = 1 + Number(el.value) / 100 * 1.5;
    val.textContent = (Math.round(S[key] * 100) / 100).toFixed(2);
  });
}
bindVar("var-td", "tdVar");
bindVar("var-vpd", "vpdVar");
document.getElementById("chk-inv").addEventListener("change", e => { S.invert = e.target.checked; });

document.getElementById("seg-mode").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  S.mode = b.dataset.mode;
  document.querySelectorAll("#seg-mode button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  touchHint(S.mode);
});
document.getElementById("seg-phosphor").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const key = b.dataset.phosphor;
  phosphorKey = key;
  phosphor = PHOSPHORS[key].color;
  phosphorTau = PHOSPHORS[key].tau;
  phosphorBoost = PHOSPHORS[key].boost;
  phosphorColor.setHex(phosphor);
  document.querySelectorAll("#seg-phosphor button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  trailLines.forEach(({ mat }) => mat.color.setHex(phosphor));
  dotMat.color.setHex(phosphor);
});
document.getElementById("seg-ch").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  S.ch = Number(b.dataset.ch);
  S.trigSource = Number(b.dataset.ch);
  document.querySelectorAll("#seg-ch button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
});
for (const [id, key] of [["chk-run","run"],["chk-xy","xy"],["chk-grid","grid"]]) {
  document.getElementById(id).addEventListener("change", e => {
    S[key] = e.target.checked;
    if (id === "chk-run" && S[key] && S.sweepMode === "single") armSingle(S);
  });
}
const powerBtn = document.getElementById("btn-power");
const powerLed = document.querySelector(".panel-header .led");
powerBtn.addEventListener("click", () => {
  S.power = !S.power;
  powerLed.className = "led " + (S.power ? "on" : "off");
  powerBtn.textContent = S.power ? "POWER" : "OFF";
});

/* ── Генерация точек трассы (позиции и яркость считает core/mesh) */
const tmpPos = new Float32Array(TRACE_N * 3);
const tmpC = new Float32Array(TRACE_N);
const tmpColor = new Float32Array(TRACE_N * 3);
const phosphorColor = new THREE.Color(PHOSPHORS.p1.color);
let lastNow = performance.now();

/* BEAT: тап по экрану = импульс по мешу */
let raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
canvas.addEventListener("pointerdown", e => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(raycastPoints);
  if (hit.length) {
    const p = hit[0].point;
    S.touchPos = p.clone();
    S.beatTime = S.t;
    S.lastBeat = S.t;
    if (S.mode === "beat") fireTrigger(S);
    arPoints.push(p);
    if (arPoints.length > MAX_AR_POINTS) arPoints.shift();
    markersGroup.clear();
    arPoints.forEach(p => {
      const marker = new THREE.Mesh(markerGeom, markerMat);
      marker.position.copy(p);
      markersGroup.add(marker);
    });
    updateArLine();
  }
});

/* ── Главный цикл ──────────────────────────────────────────────── */
function animate() {
  requestAnimationFrame(animate);
  if (!S.power) {
    composer.render();
    return;
  }
  controls.update();

  /* ── Плавный зум ─────────────────────────────────────────────── */
  const dir = camera.position.clone().sub(controls.target).normalize();
  const curDist = camera.position.distanceTo(controls.target);
  if (Math.abs(curDist - targetZoomDistance) > 0.05) {
    camera.position.copy(controls.target).add(dir.multiplyScalar(THREE.MathUtils.lerp(curDist, targetZoomDistance, 0.08)));
  }

  /* ── Развёртка и триггер (ядро) ──────────────────────────────── */
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  if (audio && audio.ctx.state === "suspended") audio.ctx.resume();

  const bands = bandValues(freqData);
  S.t += dt;
  /* триггер видит сигнал через свою связь (отдельно от входной) */
  const sigNow = trigCoupled(waveform(S.t, S.mode, S.trigSource, bands), S, dt);
  advanceSweep(S, sigNow, dt);
  S.blanked = isBlanked(S);
  gridHelper.visible = S.grid;

  /* Новая трасса — только при RUN и когда развёртка видна */
  if (S.run && !S.blanked) {
    buildTrace(meshPoints, S, bands, TRACE_N, tmpPos, tmpC);
    /* dwell-time яркость → цвет фосфора */
    for (let i = 0; i < TRACE_N; i++) {
      const o = i * 3, e = tmpC[i];
      tmpColor[o] = phosphorColor.r * e;
      tmpColor[o + 1] = phosphorColor.g * e;
      tmpColor[o + 2] = phosphorColor.b * e;
    }
  }
  /* Сдвиг шлейфа без аллокаций: каждый кадр история уходит назад
     (set() копирует значения, раскидывать через slice() не нужно) */
  const freshNow = S.run && !S.blanked;
  for (let i = TRAIL - 1; i > 0; i--) {
    trailLines[i].line.geometry.getAttribute("position").array.set(trailLines[i - 1].line.geometry.getAttribute("position").array);
    trailLines[i].line.geometry.getAttribute("color").array.set(trailLines[i - 1].line.geometry.getAttribute("color").array);
  }
  if (freshNow) {
    trailLines[0].line.geometry.getAttribute("position").array.set(tmpPos);
    trailLines[0].line.geometry.getAttribute("color").array.set(tmpColor);
  }

  /* ── AR LINE between last 3 points ──────────────────────────── */
  updateArLine();

  /* Затухание фосфора по его типу + яркость по скорости развёртки.
     Медленная развёртка (больше s/div) — луч дольше живёт на точке → ярче,
     как у настоящей трубки. Плюс wall-clock затухание: когда луч перестал
     рисовать (RUN off/blanking), свечение гаснет по экспоненте типа. */
  const secPerDiv = TIME_DIVS[S.tdIdx] * S.tdVar;
  const sweepDim = Math.max(0.55, Math.min(1.6, Math.sqrt(secPerDiv / 0.1)));
  const tauMs = phosphorTau * (0.4 + S.persistence * 0.9);
  if (freshNow) phosphorDim = 1;
  else phosphorDim *= Math.exp(-(dt * 1000) / tauMs);
  const FRAME_MS = 16;
  const headIdx = S.xy ? 0 : (S.sweepActive ? Math.min(TRACE_N - 1, Math.round(S.sweepPhase * (TRACE_N - 1))) : 0);
  const headBright = freshNow ? tmpC[headIdx] : 0;
  for (let i = 0; i < TRAIL; i++) {
    const blank = i === 0 && S.blanked;
    const op = blank ? 0 : Math.exp(-(i * FRAME_MS) / tauMs) * S.intensity * 1.3 * sweepDim * phosphorDim;
    trailLines[i].mat.opacity = op;
    trailLines[i].line.geometry.attributes.position.needsUpdate = true;
    trailLines[i].line.geometry.attributes.color.needsUpdate = true;
  }

  /* Головной луч — яркая линия на свежем кадре */
  const head = trailLines[0].line.geometry.getAttribute("position").array;
  headLine.geometry.getAttribute("position").array[0] = head[0];
  headLine.geometry.getAttribute("position").array[1] = head[1];
  headLine.geometry.getAttribute("position").array[2] = head[2];
  headLine.geometry.getAttribute("position").array[3] = head[3];
  headLine.geometry.getAttribute("position").array[4] = head[4];
  headLine.geometry.getAttribute("position").array[5] = head[5];
  headLine.geometry.getAttribute("position").needsUpdate = true;
  headLine.visible = !S.blanked;
  headMat.opacity = S.intensity * 0.95 * headBright * (S.blanked ? 0 : phosphorDim);
  headLine.material.transparent = true;

  /* Яркий огонёк — бежит по фронту развёртки */
  headDot.position.set(head[headIdx * 3], head[headIdx * 3 + 1], head[headIdx * 3 + 2]);
  headDot.visible = !S.blanked;
  headDotMat.color.setHex(phosphor);
  headDotMat.opacity = Math.min(1, phosphorDim);

  /* Фокус: размытие слоёв = сужение затухания (приблизительно через opacity) */
  const focusScale = 0.6 + S.focus * 0.8;
  bloom.strength = (0.6 + S.intensity * 0.9 * focusScale) * phosphorBoost;

  composer.render();
}

/* ── Resize ────────────────────────────────────────────────────── */
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

function updateArLine() {
  if (arPoints.length < 2) {
    arLine.visible = false;
    return;
  }
  arLine.visible = true;
  const arr = arLine.geometry.attributes.position.array;
  const last = arPoints.slice(-2);
  arr[0] = last[0].x; arr[1] = last[0].y; arr[2] = last[0].z;
  arr[3] = last[1].x; arr[4] = last[1].y; arr[5] = last[1].z;
  arLine.geometry.attributes.position.needsUpdate = true;
}

function touchHint(mode) {
  const hints = {
    trace: "TRACE: линия бежит по мешу комнаты · тап = волна",
    lissajous: "LISSAJOUS: XY-фигуры · включи X-Y и CH1/CH2 для переключения",
    perlin: "PERLIN: автономный дрейф без музыки · крути VOLTS/DIV",
    beat: "BEAT: тапай по экрану — импульсы по мешу",
  };
  document.getElementById("touch-hint").textContent = hints[mode] || "";
}
touchHint("trace");

animate();

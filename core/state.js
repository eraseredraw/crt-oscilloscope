/* core/state.js — приборное состояние осциллографа (как у настоящего CRT).
   Чистые данные, без DOM/three.js. Портируется в Kotlin/Unity. */

/* Делений по горизонтали — как ширина экрана в graticule-клетках.
   У настоящего осциллографа 10 делений по горизонтали, 8 по вертикали. */
export const SWEEP_DIVS = 10;

/* Калиброванные ступени TIME/DIV (s/div) и VOLTS/DIV (V/div),
   как поворотные переключатели на приборе */
export const TIME_DIVS = [1, 0.5, 0.2, 0.1, 0.05, 0.02];
export const VOLTS_DIVS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5];

export const DEFAULTS = {
  /* питание/экран */
  power: true,
  run: true,
  grid: true,
  xy: false,
  intensity: 0.7,
  persistence: 0.6,
  focus: 0.6,

  /* вертикаль */
  vpdIdx: 2,           // 0.2 V/div
  vpdVar: 1,           // плавная ручка VOLTS/DIV (uncalibrated, 1..2.5 — ослабляет)
  vPos: 0.5,           // позиция по вертикали (0..1, 0.5 = центр)
  coupling: "dc",      // dc | ac | gnd
  invert: false,       // полярность (инверсия канала)

  /* горизонталь */
  tdIdx: 3,            // 0.1 s/div
  tdVar: 1,            // плавная ручка TIME/DIV (uncalibrated, 1..2.5 — медленнее)
  hPos: 0.5,           // позиция по горизонтали вдоль меша (0..1)

  /* триггер */
  sweepMode: "auto",   // auto | normal | single
  trigSource: 1,       // 1 | 2 (CH)
  trigCoupling: "dc",  // связь триггера dc | ac (отдельно от входной)
  slope: 1,            // +1 фронт вверх, -1 вниз
  level: 0.5,          // порог срабатывания (0..1 по размаху)
  holdoff: 0.06,       // с, пауза после запуска развёртки
  jitter: 0.15,        // дрожание фазы запуска (горизонтальный джиттер)

  /* состояние развёртки (runtime) */
  mode: "trace",
  ch: 1,
  t: 0,
  sweepPhase: 0,
  sweepActive: true,
  triggerTime: 0,
  trigJitter: 0,
  holdoffT: 99,
  autoT: 0,
  prevTrigLevel: null,
  singleArmed: true,
  blanked: false,
  dcLevel: 0,
  trigDcLevel: 0,

  /* интерактив (BEAT) */
  touchPos: null,
  beatTime: 0,
  lastBeat: 0,
};

export function createState(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

export function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* Ширина окна развёртки в секундах = TIME/DIV × VARIABLE × число делений */
export function sweepWindow(s) {
  return TIME_DIVS[s.tdIdx] * s.tdVar * SWEEP_DIVS;
}

/* Эффективный VOLTS/DIV с учётом плавной ручки (uncalibrated) */
export function voltsPerDiv(s) {
  return VOLTS_DIVS[s.vpdIdx] * s.vpdVar;
}

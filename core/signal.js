/* core/signal.js — входной сигнал осциллографа (чистая математика).
   Генерация, связь входа AC/DC/GND, отклонение в делениях.
   Портируется в Kotlin/Unity. */

import { voltsPerDiv, SWEEP_DIVS } from "./state.js";

/* ── Perlin-подобный шум (hash + smoothstep) ─────────────────── */
export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/* ── Входной сигнал V(t): режим + музыкальная амплитуда ──────── */
export function waveform(t, mode, ch, bands) {
  switch (mode) {
    case "trace": {
      const mus = ch === 1 ? bands.bass : bands.high;
      const s = Math.sin(t * 6.283185307179586) * 0.5
        + Math.sin(t * 16.964600329384885 + 1.3) * 0.26
        + Math.sin(t * 37.0690993838774) * 0.12;
      return s * (0.55 + mus * 0.9);
    }
    case "lissajous":
      return ch === 1
        ? Math.sin(t * 6.283185307179586 * 0.9)
        : Math.sin(t * 6.283185307179586 * 1.3 + Math.sin(t * 0.35) * 1.5) * 0.9;
    case "perlin":
      return (noise(t * 0.9, 0.5) - 0.5) * 1.5;
    case "beat":
      return 0; // beat — пространственный импульс, считается в mesh
    default:
      return 0;
  }
}

/* ── Связь входа: DC прямо, AC убирает постоянную составляющую,
      GND замыкает вход на землю (ровная линия) ───────────────── */
export function coupled(v, state, dt = 0.016) {
  if (state.coupling === "gnd") return 0;
  const alpha = 1 - Math.exp(-dt * 8);
  state.dcLevel += alpha * (v - state.dcLevel);
  if (state.coupling === "ac") return v - state.dcLevel;
  return v;
}

/* ── Связь тракта ТРИГГЕРА: отдельный AC/DC, независимо от входа.
      В реальном приборе триггер берётся до линии задержки и имеет
      собственный переключатель связи (AC/DC/HF-reject/LF-reject). ─ */
export function trigCoupled(v, state, dt = 0.016) {
  /* Вход замкнут на землю (GND) — триггеру нечего ловить, как у
     настоящего прибора: тракт триггера идёт после связи входа. */
  if (state.coupling === "gnd") return 0;
  if (state.trigCoupling === "ac") {
    const alpha = 1 - Math.exp(-dt * 8);
    state.trigDcLevel += alpha * (v - state.trigDcLevel);
    return v - state.trigDcLevel;
  }
  return v;
}

/* ── Отклонение в делениях сетки: (V − вертикаль-позиция) / VPD ─ */
export function vDiv(volts, state) {
  const vpd = voltsPerDiv(state);
  return (volts - (state.vPos - 0.5) * SWEEP_DIVS * vpd) / vpd;
}

/* ── Порог триггера в вольтах из ручки LEVEL (0..1) ───────────── */
export function triggerThreshold(state) {
  return (state.level - 0.5) * 2 * 0.7;
}

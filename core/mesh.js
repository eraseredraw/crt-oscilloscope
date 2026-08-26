/* core/mesh.js — трассировка луча по мешу помещения.
   Развёртка: frac ∈ [0,1] → точка меша (слева-направо, как время на CRT),
   сигнал отклоняет луч по вертикали. Яркость фосфора — по dwell-time
   (медленный луч ярче, как на настоящей трубке). Чистая математика.
   Портируется в Kotlin/Unity. */

import { waveform, coupled, vDiv } from "./signal.js";
import { sweepWindow, SWEEP_DIVS } from "./state.js";

/* Масштаб: мировые единицы на одно деление сетки */
const DEFL = 0.17;
const DEFLZ = 0.10;

/* Половина экрана в делениях — перегрузка усилителя клиппит о края,
   как у настоящего прибора */
const HALF = SWEEP_DIVS / 2;

function clipDiv(d) {
  return d < -HALF ? -HALF : d > HALF ? HALF : d;
}

/* Интерполирует точку меша по фракции frac ∈ [0,1]. */
export function pointAt(meshPoints, frac, out) {
  const n = meshPoints.length;
  if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
  const mi = frac * (n - 1);
  const idx = Math.floor(mi);
  const f = mi - idx;
  const p0 = meshPoints[idx], p1 = meshPoints[Math.min(idx + 1, n - 1)];
  out[0] = p0.x + (p1.x - p0.x) * f;
  out[1] = p0.y + (p1.y - p0.y) * f;
  out[2] = p0.z + (p1.z - p0.z) * f;
}

/* Строит трассу из n точек: out[o..o+3n] — позиции (x,y,z),
   outC[o..o+n] — яркость фосфора по dwell-time (0..1).
   state — приборное состояние (см. core/state.js). */
export function buildTrace(meshPoints, state, bands, n, out, outC) {
  const n1 = n - 1;
  const win = sweepWindow(state);

  for (let i = 0; i < n; i++) {
    const frac = i / n1;
    const o = i * 3;
    let xDiv = 0, yDiv = 0, baseFrac = frac;

    if (state.xy) {
      /* X-Y: развёртка выключена, X = CH1, Y = CH2 */
      baseFrac = state.hPos;
      const v1 = coupled(waveform(state.t, state.mode, 1, bands), state);
      const v2 = coupled(waveform(state.t, state.mode, 2, bands), state);
      xDiv = vDiv(v1, state);
      yDiv = vDiv(v2, state);
    } else {
      /* окно развёртки: момент запуска + позиция по времени */
      const ts = state.triggerTime + (frac + state.trigJitter) * win;
      let v;
      if (state.mode === "beat") {
        /* BEAT: затухающий импульс от точки запуска развёртки */
        v = Math.sin(frac * Math.PI * 4) * Math.exp(-frac * 3.5) * 1.4;
      } else {
        v = coupled(waveform(ts, state.mode, state.trigSource, bands), state);
      }
      yDiv = vDiv(v, state);
    }

    /* полярность + перегрузка усилителя: клип о края гратикулы */
    if (state.invert) yDiv = -yDiv;
    xDiv = clipDiv(xDiv);
    yDiv = clipDiv(yDiv);

    const base = [0, 0, 0];
    pointAt(meshPoints, baseFrac, base);
    out[o] = base[0] + xDiv * DEFL;
    out[o + 1] = base[1] + yDiv * DEFL;
    out[o + 2] = base[2] + yDiv * DEFLZ + (state.xy ? xDiv * DEFLZ : 0);
  }

  /* dwell-time яркость: ∝ 1/(1 + |скорость луча|) */
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const a = i === 0 ? o : o - 3;
    const b = i === 0 ? o + 3 : o;
    const dy = out[b + 1] - out[a + 1];
    const dz = out[b + 2] - out[a + 2];
    const dx = state.xy ? out[b] - out[a] : 0;
    const g = Math.hypot(dy, dz, dx) * 6;
    outC[i] = 0.05 + 0.95 / (1 + g);
  }
}

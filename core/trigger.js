/* core/trigger.js — развёртка и триггер как у настоящего осциллографа.
   Edge-триггер (уровень + фронт), holdoff, режимы AUTO/NORM/SINGLE,
   горизонтальный джиттер фазы запуска. Чистая логика, без DOM.
   Портируется в Kotlin/Unity. */

import { hash2, triggerThreshold } from "./signal.js";
import { sweepWindow } from "./state.js";

/* Автоматическая перезапуск развёртки при отсутствии сигнала (AUTO) */
const AUTO_FALLBACK = 0.03;

/* Один шаг: sig — текущее значение входного сигнала (после связи),
   dt — шаг времени в секундах. Обновляет sweepPhase / триггер. */
export function advanceSweep(state, sig, dt) {
  const win = sweepWindow(state);
  state.holdoffT += dt;
  state.autoT += dt;

  if (!state.run) return;

  if (state.xy) return; // в X-Y развёртка отключена, сигнал сам рисует

  if (state.sweepActive) {
    /* таймер фрирана не копится во время развёртки: в реальном приборе
       он стартует заново после завершения sweep, поэтому edge успевает
       сработать раньше авто-перезапуска */
    state.autoT = 0;
    state.prevTrigLevel = sig; // держим свежим для момента окончания
    state.sweepPhase += dt / win;
    if (state.sweepPhase >= 1) {
      state.sweepPhase = 0;
      state.sweepActive = false;
      if (state.sweepMode === "single") state.singleArmed = false;
    }
    return;
  }

  /* SINGLE после однократной развёртки заморожен до нового ARM */
  if (state.sweepMode === "single" && !state.singleArmed) {
    state.prevTrigLevel = sig;
    return;
  }

  if (state.holdoffT < state.holdoff) {
    state.prevTrigLevel = sig;
    return;
  }

  if (state.prevTrigLevel === null) {
    state.prevTrigLevel = sig;
    return;
  }

  /* Edge-триггер: пересечение порога с выбранным фронтом.
     Приоритет у фронта — как на настоящем приборе. */
  const th = triggerThreshold(state);
  const prev = state.prevTrigLevel;
  state.prevTrigLevel = sig;
  if ((state.slope > 0 && prev <= th && sig > th) ||
      (state.slope < 0 && prev >= th && sig < th)) {
    fireTrigger(state);
    return;
  }

  /* AUTO: фриран только когда фронт долго не приходит, чтобы экран
     не гас (в реальном приборе таймер перестаёт подавать
     псевдо-триггеры, как только приходят настоящие) */
  if (state.sweepMode === "auto" && state.autoT > AUTO_FALLBACK) {
    fireTrigger(state);
  }
}

/* Принудительный запуск развёртки (тап в BEAT, ARM в SINGLE) */
export function fireTrigger(state) {
  state.triggerTime = state.t;
  state.sweepPhase = 0;
  state.sweepActive = true;
  state.holdoffT = 0;
  state.autoT = 0;
  state.trigJitter = (hash2(state.t * 7.1, 3.3) - 0.5) * state.jitter * 0.05;
  if (state.sweepMode === "single") state.singleArmed = true;
  if (state.sweepMode === "normal") state.prevTrigLevel = null;
}

/* Свечение экрана: пусто когда развёртка не идёт и триггер не ждёт */
export function isBlanked(state) {
  if (state.xy || !state.run) return false;
  if (state.sweepMode === "normal") return !state.sweepActive;
  if (state.sweepMode === "single") return !state.sweepActive && !state.singleArmed;
  return false;
}

/* ARM для SINGLE: взвести однократную развёртку заново */
export function armSingle(state) {
  if (state.sweepMode !== "single") return;
  state.singleArmed = true;
  state.sweepActive = false;
  state.prevTrigLevel = null;
}

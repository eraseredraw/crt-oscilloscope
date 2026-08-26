/* core/fft.js — анализ полос из байтового FFT-спектра (getByteFrequencyData).
   Чистая математика, без WebAudio/DOM. Портируется в Kotlin/Unity. */

export function avg(arr, a, b) {
  let s = 0;
  for (let i = a; i <= b; i++) s += arr[i];
  return s / (b - a + 1);
}

/* Полосы: bass / mid / high + beat (бас как триггер-метрика).
   freqData null → тихий нейтральный уровень, чтобы автономные режимы работали. */
export function bandValues(freqData) {
  if (!freqData) return { bass: 0.15, mid: 0.15, high: 0.15, beat: 0 };
  const bass = avg(freqData, 2, 14) / 255;
  const mid = avg(freqData, 15, 45) / 255;
  const high = avg(freqData, 46, 120) / 255;
  return { bass, mid, high, beat: bass };
}

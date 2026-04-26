/**
 * volumeProfile.js — Volume Profile (POC, VAH, VAL, HVN, LVN)
 *
 * Calcula la distribución de volumen por nivel de precio sobre un conjunto
 * de candles. Sin tick data, el volumen de cada vela se reparte uniformemente
 * entre los bins que cubre su rango [low, high].
 *
 * Funciones puras, sin I/O.
 */

/**
 * @param {Array<{open:number,high:number,low:number,close:number,volume:number}>} candles
 * @param {{ bins?: number, targetPct?: number }} [opts]
 * @returns {{
 *   poc: number,
 *   vah: number,
 *   val: number,
 *   hvn: number[],
 *   lvn: number[],
 *   bin_size: number,
 *   total_volume: number
 * } | null}
 */
export function calculateVolumeProfile(candles, { bins = 50, targetPct = 0.70 } = {}) {
  if (!candles || candles.length < 20) return null;

  let rangeLow = Infinity;
  let rangeHigh = -Infinity;
  for (const c of candles) {
    if (c.low < rangeLow)   rangeLow = c.low;
    if (c.high > rangeHigh) rangeHigh = c.high;
  }
  if (!isFinite(rangeLow) || !isFinite(rangeHigh) || rangeHigh <= rangeLow) return null;

  const binSize = (rangeHigh - rangeLow) / bins;
  const volumes = new Array(bins).fill(0);

  // Reparto uniforme del volumen entre los bins que cubre el rango [low, high].
  // Una vela contribuye 100% de su volumen sin importar el tamaño relativo de
  // su rango frente al binSize (una doji aporta todo a su único bin).
  for (const c of candles) {
    if (!c.volume || c.volume <= 0) continue;
    const startBin = Math.min(bins - 1, Math.max(0, Math.floor((c.low - rangeLow) / binSize)));
    const endBin   = Math.min(bins - 1, Math.max(0, Math.floor((c.high - rangeLow) / binSize)));
    const numBins = endBin - startBin + 1;
    const volPerBin = c.volume / numBins;
    for (let i = startBin; i <= endBin; i++) {
      volumes[i] += volPerBin;
    }
  }

  const totalVolume = volumes.reduce((s, v) => s + v, 0);
  if (totalVolume <= 0) return null;

  // POC: bin con mayor volumen
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) {
    if (volumes[i] > volumes[pocIdx]) pocIdx = i;
  }

  // Value Area: expandir desde el POC añadiendo el vecino con más volumen
  const target = totalVolume * targetPct;
  let vaVolume = volumes[pocIdx];
  let lo = pocIdx;
  let hi = pocIdx;
  while (vaVolume < target && (lo > 0 || hi < bins - 1)) {
    const volBelow = lo > 0 ? volumes[lo - 1] : -1;
    const volAbove = hi < bins - 1 ? volumes[hi + 1] : -1;
    if (volBelow >= volAbove) {
      lo--;
      vaVolume += volumes[lo];
    } else {
      hi++;
      vaVolume += volumes[hi];
    }
  }

  const binCenter = (idx) => rangeLow + binSize * (idx + 0.5);

  // HVN/LVN sobre la media
  const meanVol = totalVolume / bins;
  const hvnIdx = [];
  const lvnIdx = [];
  for (let i = 0; i < bins; i++) {
    if (volumes[i] >= 1.5 * meanVol) hvnIdx.push(i);
    else if (volumes[i] <= 0.4 * meanVol) lvnIdx.push(i);
  }
  // Top 5 por volumen (descendente para HVN, ascendente para LVN)
  hvnIdx.sort((a, b) => volumes[b] - volumes[a]);
  lvnIdx.sort((a, b) => volumes[a] - volumes[b]);
  const hvn = hvnIdx.slice(0, 5).map(i => parseFloat(binCenter(i).toFixed(2)));
  const lvn = lvnIdx.slice(0, 5).map(i => parseFloat(binCenter(i).toFixed(2)));

  return {
    poc:          parseFloat(binCenter(pocIdx).toFixed(2)),
    vah:          parseFloat(binCenter(hi).toFixed(2)),
    val:          parseFloat(binCenter(lo).toFixed(2)),
    hvn,
    lvn,
    bin_size:     parseFloat(binSize.toFixed(4)),
    total_volume: parseFloat(totalVolume.toFixed(2)),
  };
}

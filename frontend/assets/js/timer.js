/**
 * timer.js — Countdown timer para auto-refresh de CRYPTEX
 *
 * Uso:
 *   const t = new Timer(60, onTick, onExpire);
 *   t.start();
 *   t.reset();   // reinicia a 60s sin parar
 *   t.stop();
 */

export class Timer {
  /**
   * @param {number}   seconds   - Duración del ciclo en segundos
   * @param {function} onTick    - Llamada cada segundo con (secondsLeft)
   * @param {function} onExpire  - Llamada cuando el contador llega a 0
   */
  constructor(seconds, onTick, onExpire) {
    this._total    = seconds;
    this._onTick   = onTick;
    this._onExpire = onExpire;
    this._left     = seconds;
    this._id       = null;
  }

  start() {
    if (this._id !== null) return;
    this._tick();
  }

  stop() {
    if (this._id !== null) {
      clearTimeout(this._id);
      this._id = null;
    }
  }

  /** Reinicia la cuenta atrás al valor inicial sin detener el timer. */
  reset() {
    this.stop();
    this._left = this._total;
    this._onTick(this._left);
    this.start();
  }

  _tick() {
    this._onTick(this._left);
    if (this._left === 0) {
      this._left = this._total;
      this._onExpire();
      // Continuar después del expire (loadData es async, no bloqueamos)
      this._id = setTimeout(() => this._tick(), 1000);
    } else {
      this._left--;
      this._id = setTimeout(() => this._tick(), 1000);
    }
  }
}

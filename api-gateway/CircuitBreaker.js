'use strict';

/**
 * CircuitBreaker – Bảo vệ hệ thống khi một service bị sập.
 *
 * Ba trạng thái:
 *
 *  CLOSED ────── (lỗi liên tiếp ≥ threshold) ──→ OPEN
 *    ↑                                              │
 *    │                                      (sau recoveryTimeout)
 *    │                                              ↓
 *  CLOSED ←── (request thành công) ──────── HALF_OPEN
 *                                                   │
 *                                           (request thất bại)
 *                                                   ↓
 *                                                 OPEN (lại)
 *
 *  CLOSED   : Request đi qua bình thường.
 *  OPEN     : Tất cả request bị từ chối ngay (fast-fail).
 *             Tránh gọi liên tục vào service đang sập.
 *  HALF_OPEN: Cho phép 1 request thử nghiệm; nếu thành công → CLOSED,
 *             nếu thất bại → OPEN lại.
 */

const STATE = Object.freeze({
  CLOSED:    'CLOSED',
  OPEN:      'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

class CircuitBreaker {
  /**
   * @param {string} name              - Tên service (dùng cho log)
   * @param {object} opts
   * @param {number} opts.failureThreshold   - Số lỗi liên tiếp để mở circuit (default: 3)
   * @param {number} opts.recoveryTimeoutMs  - Thời gian OPEN trước khi thử lại (default: 30s)
   */
  constructor(name, { failureThreshold = 3, recoveryTimeoutMs = 30_000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.recoveryTimeoutMs = recoveryTimeoutMs;

    this._state = STATE.CLOSED;
    this._failureCount = 0;
    this._lastFailureTime = null;
    this._totalCalls = 0;
    this._totalFailures = 0;
    this._totalRejected = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Thực thi fn() qua circuit breaker.
   * @param {() => Promise<any>} fn - hàm async cần bảo vệ
   * @throws nếu circuit OPEN hoặc fn() throw
   */
  async call(fn) {
    this._totalCalls++;

    if (this._state === STATE.OPEN) {
      if (this._shouldAttemptReset()) {
        this._transitionTo(STATE.HALF_OPEN);
      } else {
        this._totalRejected++;
        const remaining = Math.round(
          (this.recoveryTimeoutMs - (Date.now() - this._lastFailureTime)) / 1000
        );
        throw new Error(
          `[CircuitBreaker:${this.name}] Circuit OPEN – retry in ~${remaining}s`
        );
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  /** Trạng thái hiện tại để expose qua /health */
  getStatus() {
    return {
      service:          this.name,
      state:            this._state,
      failureCount:     this._failureCount,
      failureThreshold: this.failureThreshold,
      lastFailureTime:  this._lastFailureTime
        ? new Date(this._lastFailureTime).toISOString()
        : null,
      stats: {
        totalCalls:    this._totalCalls,
        totalFailures: this._totalFailures,
        totalRejected: this._totalRejected,
        successRate:   this._totalCalls > 0
          ? (((this._totalCalls - this._totalFailures) / this._totalCalls) * 100).toFixed(1) + '%'
          : 'N/A',
      },
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _onSuccess() {
    if (this._state === STATE.HALF_OPEN) {
      this._transitionTo(STATE.CLOSED);
    }
    this._failureCount = 0;
  }

  _onFailure(err) {
    this._totalFailures++;
    this._failureCount++;
    this._lastFailureTime = Date.now();

    console.error(
      `[CircuitBreaker:${this.name}] Failure #${this._failureCount}: ${err.message}`
    );

    if (this._state === STATE.HALF_OPEN || this._failureCount >= this.failureThreshold) {
      this._transitionTo(STATE.OPEN);
    }
  }

  _shouldAttemptReset() {
    return Date.now() - this._lastFailureTime >= this.recoveryTimeoutMs;
  }

  _transitionTo(newState) {
    const icons = { CLOSED: '🟢', OPEN: '🔴', HALF_OPEN: '🟡' };
    console.log(
      `[CircuitBreaker:${this.name}] ${icons[this._state]} ${this._state} → ${icons[newState]} ${newState}`
    );
    this._state = newState;
  }
}

// ── Factory – một CircuitBreaker riêng cho mỗi service ───────────────────────

const _breakers = new Map();

module.exports = {
  STATE,

  /**
   * Lấy hoặc tạo CircuitBreaker cho serviceName.
   */
  get(serviceName, opts) {
    if (!_breakers.has(serviceName)) {
      _breakers.set(serviceName, new CircuitBreaker(serviceName, opts));
    }
    return _breakers.get(serviceName);
  },

  /**
   * Snapshot tất cả circuit breakers – dùng cho /health/circuit-breakers.
   */
  getAllStatus() {
    const result = {};
    for (const [name, cb] of _breakers) {
      result[name] = cb.getStatus();
    }
    return result;
  },
};

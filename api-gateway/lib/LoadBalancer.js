'use strict';

const registry = require('./ServiceRegistry');

/**
 * RoundRobinLoadBalancer – Cân bằng tải theo thuật toán Round-Robin.
 *
 * Nguyên lý:
 *  - Mỗi lần pick(), tăng counter và chọn instance theo modulo.
 *  - Đảm bảo mỗi instance nhận đều request theo vòng xoay.
 *
 *  Instance 1  ──→  Request 1, 4, 7, ...
 *  Instance 2  ──→  Request 2, 5, 8, ...
 *  Instance 3  ──→  Request 3, 6, 9, ...
 *
 * Có thể mở rộng sang Least-Connection hoặc Weighted Round-Robin
 * bằng cách ghi đè phương thức _selectInstance().
 */
class RoundRobinLoadBalancer {
  constructor() {
    // counter riêng cho từng service
    this._counters = new Map();
    // lưu số request đã route cho từng instance (monitor)
    this._stats = new Map();
  }

  /**
   * Chọn 1 instance cho serviceName.
   * @throws {Error} nếu không có instance nào đang sống
   * @returns {{ id, host, grpcPort, httpPort }}
   */
  pick(serviceName) {
    const instances = registry.getInstances(serviceName);

    if (instances.length === 0) {
      throw new Error(
        `[LoadBalancer] No healthy instances available for: "${serviceName}". ` +
        `Check service registration and heartbeat.`
      );
    }

    const chosen = this._selectInstance(serviceName, instances);
    this._recordStat(serviceName, chosen.id);

    console.log(
      `[LoadBalancer] ${serviceName} → ${chosen.host}:${chosen.grpcPort}` +
      `  (${instances.indexOf(chosen) + 1}/${instances.length})`
    );

    return chosen;
  }

  /**
   * Round-Robin selection core logic.
   */
  _selectInstance(serviceName, instances) {
    if (!this._counters.has(serviceName)) {
      this._counters.set(serviceName, 0);
    }
    const count = this._counters.get(serviceName);
    const idx = count % instances.length;
    this._counters.set(serviceName, count + 1);
    return instances[idx];
  }

  /**
   * Thống kê số request đã route đến mỗi instance.
   * Dùng cho endpoint /lb/stats.
   */
  getStats() {
    const result = {};
    for (const [key, count] of this._stats) {
      result[key] = count;
    }
    return result;
  }

  _recordStat(serviceName, instanceId) {
    const key = `${serviceName}::${instanceId}`;
    this._stats.set(key, (this._stats.get(key) || 0) + 1);
  }
}

module.exports = new RoundRobinLoadBalancer();

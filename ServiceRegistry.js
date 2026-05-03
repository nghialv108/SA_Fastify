'use strict';

/**
 * ServiceRegistry – Service Discovery tự cài đặt (không cần Consul/etcd).
 *
 * Cơ chế hoạt động:
 *  1. Mỗi service gọi POST /registry/register khi khởi động → nhận instance_id.
 *  2. Mỗi 10 giây service gọi POST /registry/heartbeat để "đập tim".
 *  3. Registry xoá instance nếu không nhận heartbeat sau HEARTBEAT_TTL_MS.
 *  4. API Gateway dùng registry để lấy danh sách instance còn sống.
 *
 * Pattern: In-process Singleton – phù hợp monorepo / Docker Compose.
 * Có thể thay bằng Redis pub/sub để scale sang nhiều gateway instance.
 */

const HEARTBEAT_TTL_MS = 30_000;  // 30 giây
const CLEANUP_INTERVAL_MS = 10_000; // kiểm tra mỗi 10 giây

class ServiceRegistry {
  constructor() {
    /**
     * _services: Map<serviceName, Map<instanceId, InstanceInfo>>
     *
     * InstanceInfo = {
     *   id       : string,
     *   host     : string,
     *   grpcPort : number,
     *   httpPort : number,
     *   lastSeen : number  (timestamp ms)
     * }
     */
    this._services = new Map();
    this._startCleanupJob();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Đăng ký một instance mới.
   * @returns {string} instanceId – dùng cho heartbeat / deregister
   */
  register({ name, host, grpcPort, httpPort = 0 }) {
    if (!this._services.has(name)) {
      this._services.set(name, new Map());
    }

    const id = `${host}:${grpcPort}`;
    this._services.get(name).set(id, {
      id,
      host,
      grpcPort: Number(grpcPort),
      httpPort: Number(httpPort),
      lastSeen: Date.now(),
    });

    console.log(`[ServiceRegistry] ✅ Registered  ${name} @ ${id}`);
    return id;
  }

  /**
   * Cập nhật lastSeen cho instance.
   * @returns {boolean} true nếu instance tồn tại
   */
  heartbeat(name, id) {
    const bucket = this._services.get(name);
    if (!bucket || !bucket.has(id)) {
      console.warn(`[ServiceRegistry] ⚠️  Heartbeat unknown instance: ${name}@${id}`);
      return false;
    }
    bucket.get(id).lastSeen = Date.now();
    return true;
  }

  /**
   * Xoá thủ công một instance (service graceful shutdown).
   */
  deregister(name, id) {
    const bucket = this._services.get(name);
    if (bucket) {
      bucket.delete(id);
      console.log(`[ServiceRegistry] 🔴 Deregistered ${name} @ ${id}`);
    }
  }

  /**
   * Lấy danh sách instance đang sống của một service.
   * @returns {InstanceInfo[]}
   */
  getInstances(name) {
    const bucket = this._services.get(name);
    if (!bucket || bucket.size === 0) return [];
    return Array.from(bucket.values());
  }

  /**
   * Snapshot toàn bộ registry – dùng cho endpoint /registry/status.
   */
  snapshot() {
    const result = {};
    for (const [name, bucket] of this._services) {
      result[name] = Array.from(bucket.values()).map((inst) => ({
        ...inst,
        aliveFor: Math.round((Date.now() - inst.lastSeen) / 1000) + 's ago',
      }));
    }
    return result;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _startCleanupJob() {
    setInterval(() => {
      const now = Date.now();
      for (const [name, bucket] of this._services) {
        for (const [id, info] of bucket) {
          if (now - info.lastSeen > HEARTBEAT_TTL_MS) {
            bucket.delete(id);
            console.log(`[ServiceRegistry] ⏱️  Expired    ${name} @ ${id} (no heartbeat for ${HEARTBEAT_TTL_MS / 1000}s)`);
          }
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }
}

// Singleton – dùng chung trong cùng process
module.exports = new ServiceRegistry();

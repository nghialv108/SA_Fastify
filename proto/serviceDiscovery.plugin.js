'use strict';

const fp              = require('fastify-plugin');
const registry        = require('../lib/ServiceRegistry');
const loadBalancer    = require('../lib/LoadBalancer');
const circuitBreakers = require('../lib/CircuitBreaker');

/**
 * serviceDiscoveryPlugin – đăng ký các route cho:
 *
 *  POST /registry/register         ← Microservice tự đăng ký
 *  POST /registry/heartbeat        ← Microservice gửi heartbeat
 *  DELETE /registry/deregister     ← Microservice graceful shutdown
 *  GET  /registry/status           ← Xem toàn bộ registry (debug)
 *
 *  GET  /health                    ← Health của api-gateway
 *  GET  /health/circuit-breakers   ← Trạng thái tất cả circuit breakers
 *  GET  /health/load-balancer      ← Thống kê phân phối request
 */
async function serviceDiscoveryPlugin(fastify) {

  // ── Registry Endpoints ──────────────────────────────────────────────────

  /** Microservice gọi khi khởi động */
  fastify.post('/registry/register', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'host', 'grpcPort'],
        properties: {
          name:     { type: 'string' },
          host:     { type: 'string' },
          grpcPort: { type: 'number' },
          httpPort: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, host, grpcPort, httpPort } = request.body;
    const id = registry.register({ name, host, grpcPort, httpPort });
    return reply.code(201).send({ success: true, id });
  });

  /** Microservice gọi mỗi 10 giây */
  fastify.post('/registry/heartbeat', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'id'],
        properties: {
          name: { type: 'string' },
          id:   { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, id } = request.body;
    const ok = registry.heartbeat(name, id);
    if (!ok) {
      // Instance không tồn tại → service nên re-register
      return reply.code(404).send({ success: false, action: 'RE_REGISTER' });
    }
    return { success: true };
  });

  /** Microservice gọi khi shutdown gracefully */
  fastify.delete('/registry/deregister', async (request, reply) => {
    const { name, id } = request.body;
    registry.deregister(name, id);
    return { success: true };
  });

  /** Debug: xem toàn bộ registry */
  fastify.get('/registry/status', async () => {
    return {
      timestamp: new Date().toISOString(),
      services: registry.snapshot(),
    };
  });

  // ── Health Endpoints ────────────────────────────────────────────────────

  fastify.get('/health', async () => {
    return {
      status:    'ok',
      service:   'api-gateway',
      timestamp: new Date().toISOString(),
      uptime:    Math.round(process.uptime()) + 's',
    };
  });

  /**
   * Trạng thái từng circuit breaker.
   * Dùng để monitor xem service nào đang bị OPEN (sập).
   *
   * Response ví dụ:
   * {
   *   "task-service": { state: "OPEN", failureCount: 3, ... },
   *   "user-service": { state: "CLOSED", ... }
   * }
   */
  fastify.get('/health/circuit-breakers', async () => {
    return circuitBreakers.getAllStatus();
  });

  /**
   * Thống kê load balancing – số request đã route đến từng instance.
   *
   * Response ví dụ:
   * {
   *   "task-service::task-service-1:50051": 42,
   *   "task-service::task-service-2:50051": 41,
   * }
   */
  fastify.get('/health/load-balancer', async () => {
    return {
      algorithm: 'round-robin',
      stats: loadBalancer.getStats(),
      activeInstances: registry.snapshot(),
    };
  });
}

module.exports = fp(serviceDiscoveryPlugin, {
  name: 'service-discovery',
  fastify: '>=4.x',
});

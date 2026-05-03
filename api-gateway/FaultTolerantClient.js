'use strict';

const grpc        = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path        = require('path');

const loadBalancer    = require('./LoadBalancer');
const circuitBreakers = require('./CircuitBreaker');

const PROTO_BASE_PATH = path.resolve('/proto');
const GRPC_TIMEOUT_S  = 5;           // timeout mỗi unary call
const MAX_RETRIES     = 3;           // số lần thử lại tối đa
const BASE_DELAY_MS   = 200;         // delay cơ bản cho exponential backoff

// Cache gRPC client instances (tránh tạo lại channel không cần thiết)
const _clientCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load proto và tạo gRPC client cho 1 instance cụ thể.
 * Cache theo address để tái sử dụng channel.
 */
function buildClient(protoFile, packageName, serviceName, address) {
  const cacheKey = `${serviceName}@${address}`;
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);

  const packageDef = protoLoader.loadSync(
    path.join(PROTO_BASE_PATH, protoFile),
    { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
  );
  const pkg    = grpc.loadPackageDefinition(packageDef)[packageName];
  const client = new pkg[serviceName](address, grpc.credentials.createInsecure());

  _clientCache.set(cacheKey, client);
  return client;
}

/**
 * Wrap một unary gRPC call thành Promise với deadline.
 */
function callUnary(client, method, request) {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + GRPC_TIMEOUT_S * 1000);
    client[method](request, { deadline }, (err, response) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
}

/**
 * Exponential backoff retry.
 * Không retry nếu circuit breaker đang OPEN (fast-fail).
 */
async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Circuit breaker đang mở → không retry
      if (err.message.includes('Circuit OPEN')) throw err;
      lastErr = err;

      if (attempt < maxRetries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);   // 200ms, 400ms, 800ms
        console.warn(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed: ${err.message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gọi một Unary RPC với đầy đủ: Load Balancing → Circuit Breaker → Retry → Timeout.
 *
 * @param {object} opts
 * @param {string} opts.protoFile     - Tên file .proto (VD: 'task.proto')
 * @param {string} opts.package       - Package name trong proto
 * @param {string} opts.service       - Service name trong proto (VD: 'TaskService')
 * @param {string} opts.grpcService   - Key trong ServiceRegistry (VD: 'task-service')
 * @param {string} opts.method        - Tên method cần gọi
 * @param {object} opts.request       - Payload
 *
 * @example
 * const task = await callUnaryRPC({
 *   protoFile: 'task.proto', package: 'task',
 *   service: 'TaskService', grpcService: 'task-service',
 *   method: 'GetTask', request: { id: '123' }
 * });
 */
async function callUnaryRPC({ protoFile, package: pkg, service, grpcService, method, request }) {
  const cb = circuitBreakers.get(grpcService);

  return cb.call(() =>
    withRetry(async () => {
      // 1. Chọn instance qua Load Balancer
      const instance = loadBalancer.pick(grpcService);
      const address  = `${instance.host}:${instance.grpcPort}`;

      // 2. Lấy gRPC client (cached)
      const client = buildClient(protoFile, pkg, service, address);

      // 3. Gọi với timeout
      return callUnary(client, method, request);
    })
  );
}

/**
 * Tạo một Server-side Streaming call với Load Balancing.
 * Không wrap qua CB vì stream tự xử lý error event.
 *
 * @returns {grpc.ClientReadableStream}
 */
function callServerStream({ protoFile, package: pkg, service, grpcService, method, request }) {
  const instance = loadBalancer.pick(grpcService);
  const address  = `${instance.host}:${instance.grpcPort}`;
  const client   = buildClient(protoFile, pkg, service, address);

  console.log(`[Stream] ${grpcService}.${method} → ${address}`);
  return client[method](request);
}

module.exports = { callUnaryRPC, callServerStream };

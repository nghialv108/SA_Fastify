'use strict';

/**
 * serviceRegister.js – Helper để mỗi microservice tự đăng ký vào API Gateway.
 *
 * Cách dùng (trong index.js của mỗi service):
 *
 *   const { register, startHeartbeat, deregister } = require('../../shared/serviceRegister');
 *
 *   // Khi service khởi động xong:
 *   await register();
 *
 *   // Graceful shutdown:
 *   process.on('SIGTERM', async () => {
 *     await deregister();
 *     process.exit(0);
 *   });
 *
 * Biến môi trường:
 *   SERVICE_NAME   - Tên service trong registry (VD: "task-service")
 *   SERVICE_HOST   - Hostname của container trong Docker network (VD: "task-service")
 *   GRPC_PORT      - Port gRPC đang lắng nghe (VD: "50051")
 *   GATEWAY_URL    - URL của API Gateway (VD: "http://api-gateway:3000")
 */

const http = require('http');

const GATEWAY_URL    = process.env.GATEWAY_URL    || 'http://api-gateway:3000';
const SERVICE_NAME   = process.env.SERVICE_NAME;
const SERVICE_HOST   = process.env.SERVICE_HOST   || 'localhost';
const GRPC_PORT      = Number(process.env.GRPC_PORT)      || 50051;
const HTTP_PORT      = Number(process.env.HTTP_PORT)      || 0;
const HEARTBEAT_MS   = 10_000;  // mỗi 10 giây
const RETRY_DELAY_MS = 5_000;   // delay khi retry đăng ký

let _instanceId       = null;
let _heartbeatTimer   = null;

// ── HTTP helper (không dùng thư viện ngoài để giảm dependencies) ─────────────

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || 80,
      path:     parsedUrl.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function del(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || 80,
      path:     parsedUrl.pathname,
      method:   'DELETE',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Public functions ──────────────────────────────────────────────────────────

/**
 * Đăng ký service vào Gateway Registry.
 * Tự retry vô hạn nếu Gateway chưa ready.
 */
async function register() {
  if (!SERVICE_NAME) {
    throw new Error('[ServiceRegister] Thiếu biến môi trường SERVICE_NAME');
  }
  while (true) {
    try {
      const res = await post(`${GATEWAY_URL}/registry/register`, {
        name:     SERVICE_NAME,
        host:     SERVICE_HOST,
        grpcPort: GRPC_PORT,
        httpPort: HTTP_PORT,
      });
      if (res.status === 201) {
        _instanceId = res.body.id;
        console.log(`[ServiceRegister] ✅ Registered as ${SERVICE_NAME} @ ${_instanceId}`);
        _startHeartbeat();
        return;
      }
      console.warn(`[ServiceRegister] Unexpected status ${res.status}, retrying...`);
    } catch (err) {
      console.warn(`[ServiceRegister] Gateway unreachable (${err.message}), retrying in ${RETRY_DELAY_MS}ms...`);
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}

/**
 * Huỷ đăng ký khi service shutdown gracefully.
 */
async function deregister() {
  if (!_instanceId) return;
  _stopHeartbeat();
  try {
    await del(`${GATEWAY_URL}/registry/deregister`, {
      name: SERVICE_NAME,
      id:   _instanceId,
    });
    console.log(`[ServiceRegister] 🔴 Deregistered ${SERVICE_NAME} @ ${_instanceId}`);
  } catch (err) {
    console.error(`[ServiceRegister] Deregister error: ${err.message}`);
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _startHeartbeat() {
  _heartbeatTimer = setInterval(async () => {
    try {
      const res = await post(`${GATEWAY_URL}/registry/heartbeat`, {
        name: SERVICE_NAME,
        id:   _instanceId,
      });
      if (res.status === 404 && res.body.action === 'RE_REGISTER') {
        console.warn('[ServiceRegister] Instance expired, re-registering...');
        _stopHeartbeat();
        await register();
      }
    } catch (err) {
      console.warn(`[ServiceRegister] Heartbeat failed: ${err.message}`);
    }
  }, HEARTBEAT_MS);
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

module.exports = { register, deregister };

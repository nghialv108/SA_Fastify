'use strict';

/**
 * taskStreamRoutes – expose WatchProjectTasks gRPC stream ra ngoài qua SSE.
 *
 * Endpoint: GET /tasks/stream/:projectId
 *
 * Client kết nối bằng EventSource (browser) hoặc curl:
 *   curl -N http://localhost:3000/tasks/stream/PROJECT_ID
 *
 * Luồng dữ liệu:
 *   Browser/curl  ←── SSE (HTTP) ──  API Gateway  ←── gRPC stream ──  task-service
 *
 * Các event type:
 *   - SNAPSHOT  : task hiện có (gửi ngay khi kết nối)
 *   - CREATED   : task mới được tạo
 *   - UPDATED   : task được cập nhật
 *   - DELETED   : task bị xoá
 *   - HEARTBEAT : ping mỗi 20s để giữ connection
 *   - ERROR     : lỗi từ service
 */

const { callServerStream } = require('./lib/FaultTolerantClient');

async function taskStreamRoutes(fastify) {

  fastify.get('/tasks/stream/:projectId', async (request, reply) => {
    const { projectId } = request.params;

    // ── SSE Headers ──────────────────────────────────────────────────────────
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // tắt buffer của Nginx proxy
    });

    fastify.log.info(`[Stream] Client connected for project: ${projectId}`);

    // ── gRPC Server-side Streaming ────────────────────────────────────────────
    let grpcStream;
    try {
      grpcStream = callServerStream({
        protoFile: 'task.proto',
        package: 'task',
        service: 'TaskService',
        grpcService: 'task-service',
        method: 'watchProjectTasks',
        request: { project_id: projectId },
      });
    } catch (err) {
      // Load balancer hoặc circuit breaker từ chối
      sendSSE(reply, 'ERROR', { message: err.message });
      reply.raw.end();
      return;
    }

    // ── Relay gRPC events → SSE ───────────────────────────────────────────────
    grpcStream.on('data', (event) => {
      sendSSE(reply, event.event_type, event);
    });

    grpcStream.on('error', (err) => {
      fastify.log.error(`[Stream] gRPC error: ${err.message}`);
      sendSSE(reply, 'ERROR', { message: err.message });
      reply.raw.end();
    });

    grpcStream.on('end', () => {
      fastify.log.info(`[Stream] gRPC stream ended for project: ${projectId}`);
      reply.raw.end();
    });

    // ── Heartbeat để giữ connection qua proxy/load balancer ──────────────────
    const heartbeatTimer = setInterval(() => {
      if (!reply.raw.writableEnded) {
        sendSSE(reply, 'HEARTBEAT', { ts: new Date().toISOString() });
      } else {
        clearInterval(heartbeatTimer);
      }
    }, 20_000);

    // ── Cleanup khi client ngắt kết nối ─────────────────────────────────────
    request.raw.on('close', () => {
      fastify.log.info(`[Stream] Client disconnected: ${projectId}`);
      clearInterval(heartbeatTimer);
      if (grpcStream) grpcStream.cancel();
    });
  });
}

// ── Helper: ghi SSE frame ────────────────────────────────────────────────────
function sendSSE(reply, eventType, data) {
  if (reply.raw.writableEnded) return;
  const payload = JSON.stringify(data);
  reply.raw.write(`event: ${eventType}\n`);
  reply.raw.write(`data: ${payload}\n\n`);
}

module.exports = taskStreamRoutes;


// ─────────────────────────────────────────────────────────────────────────────
// PHẦN TRIỂN KHAI PHÍA task-service (đặt trong task-service/src/grpcServer.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// Thêm handler sau vào object handlers của gRPC server:
//
// const handlers = {
//   ...existingHandlers,
//   WatchProjectTasks: watchProjectTasks,   // ← THÊM DÒNG NÀY
// };
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WatchProjectTasks – Server-side Streaming handler cho task-service.
 *
 * Bước 1: Gửi tất cả task hiện có dưới dạng sự kiện SNAPSHOT.
 * Bước 2: Mở MongoDB Change Stream để theo dõi thay đổi real-time.
 * Bước 3: Stream từng thay đổi về client cho đến khi client cancel.
 *
 * Yêu cầu: MongoDB phải chạy ở chế độ Replica Set để Change Stream hoạt động.
 * Trong Docker Compose dev: thêm --replSet rs0 vào MongoDB container.
 *
 * @param {grpc.ServerWritableStream} call
 */
async function watchProjectTasks(call) {
  const { project_id } = call.request;
  let changeStream = null;

  console.log(`[WatchProjectTasks] 🔌 Client connected, project: ${project_id}`);

  try {
    // ── Bước 1: Snapshot toàn bộ task hiện có ───────────────────────────────
    const Task = require('../models/Task'); // Mongoose model

    const existingTasks = await Task.find({ projectId: project_id }).lean();
    for (const task of existingTasks) {
      call.write({
        event_type: 'SNAPSHOT',
        task: toProtoTask(task),
        timestamp: new Date().toISOString(),
      });
    }
    console.log(`[WatchProjectTasks] Sent ${existingTasks.length} snapshot tasks`);

    // ── Bước 2: Mở Change Stream theo dõi thay đổi ──────────────────────────
    changeStream = Task.watch(
      [{ $match: { 'fullDocument.projectId': project_id } }],
      { fullDocument: 'updateLookup' }
    );

    changeStream.on('change', (change) => {
      const eventTypeMap = {
        insert: 'CREATED',
        update: 'UPDATED',
        replace: 'UPDATED',
        delete: 'DELETED',
      };
      const eventType = eventTypeMap[change.operationType];
      if (!eventType) return;

      const doc = change.fullDocument || change.documentKey;
      call.write({
        event_type: eventType,
        task: toProtoTask(doc),
        timestamp: new Date().toISOString(),
      });
    });

    changeStream.on('error', (err) => {
      console.error(`[WatchProjectTasks] Change stream error: ${err.message}`);
      call.end();
    });

  } catch (err) {
    console.error(`[WatchProjectTasks] Fatal error: ${err.message}`);
    call.destroy(err);
  }

  // ── Bước 3: Cleanup khi client ngắt kết nối ─────────────────────────────
  call.on('cancelled', () => {
    console.log(`[WatchProjectTasks] 🔌 Client disconnected: ${project_id}`);
    if (changeStream) changeStream.close();
  });
}

/** Map Mongoose document sang gRPC Task message */
function toProtoTask(doc) {
  if (!doc) return {};
  return {
    id: String(doc._id || ''),
    title: doc.title || '',
    description: doc.description || '',
    status: doc.status || 'todo',
    priority: doc.priority || 'medium',
    project_id: doc.projectId || '',
    assignee_id: doc.assigneeId || '',
    created_at: doc.createdAt ? doc.createdAt.toISOString() : '',
    updated_at: doc.updatedAt ? doc.updatedAt.toISOString() : '',
  };
}

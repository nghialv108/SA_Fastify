# SA_Fastify — Project Management System (Microservices)

Hệ thống quản lý dự án xây dựng theo kiến trúc **Microservices** với:

- **Fastify** làm API Gateway (HTTP/REST)
- **gRPC** làm giao thức nội bộ giữa các service
- **MongoDB** (Replica Set) làm cơ sở dữ liệu
- **Service Discovery** tự cài đặt (không cần Consul / etcd)
- **Load Balancing** Round-Robin
- **Circuit Breaker** bảo vệ khi service sập
- **Server-side Streaming** (SSE + gRPC Change Stream) cho real-time updates

---

## Kiến trúc tổng quan

```
                        ┌─────────────────────────────────────────────┐
                        │              API Gateway :3000               │
                        │                                              │
                        │  ┌──────────────┐  ┌──────────────────────┐ │
Client ──── HTTP ──────►│  │ HTTP Routes  │  │  Service Discovery   │ │
                        │  │  (REST API)  │  │  /registry/register  │ │
                        │  └──────┬───────┘  │  /registry/heartbeat │ │
                        │         │          │  /health/...         │ │
                        │  ┌──────▼───────┐  └──────────────────────┘ │
                        │  │FaultTolerant │                            │
                        │  │   Client     │                            │
                        │  │ LB + CB +    │                            │
                        │  │ Retry+Timeout│                            │
                        │  └──────┬───────┘                            │
                        └─────────┼───────────────────────────────────┘
                                  │ gRPC
              ┌───────────────────┼──────────────────┐
              ▼                   ▼                  ▼
    user-service:50051   project-service:50051   task-service-1:50051
                                                 task-service-2:50051
              │                   │                  │
              ▼                   ▼                  ▼
          MongoDB             MongoDB            MongoDB (Replica Set)
          (user_db)         (project_db)          (task_db)
```

### Load Balancing

API Gateway phân phối request đến 2 instance `task-service` theo Round-Robin:

```
Request 1  →  task-service-1
Request 2  →  task-service-2
Request 3  →  task-service-1
...
```

### Circuit Breaker

Mỗi service có 1 Circuit Breaker riêng. Sau 3 lỗi liên tiếp, circuit OPEN → fast-fail trong 30 giây → thử lại (HALF_OPEN).

### Real-time Streaming

```
Browser ──SSE──► GET /tasks/stream/:id
                       │
               API Gateway (tasks-stream.js)
                       │ gRPC Server-stream
               task-service WatchProjectTasks()
                       │
               MongoDB Change Stream (Replica Set required)
```

---

## Cấu trúc thư mục

```
SA_Fastify/
├── api-gateway/
│   ├── lib/                         # Shared internal modules
│   │   ├── ServiceRegistry.js       # Service registry (singleton)
│   │   ├── LoadBalancer.js          # Round-Robin load balancer
│   │   ├── CircuitBreaker.js        # Circuit breaker per service
│   │   └── FaultTolerantClient.js   # LB + CB + Retry + Timeout
│   ├── server.js                    # Entry point, HTTP routes
│   ├── serviceDiscovery.plugin.js   # Fastify plugin: /registry/* /health/*
│   ├── tasks-stream.js              # SSE relay: gRPC stream → SSE
│   └── package.json
├── user-service/
│   ├── server.js
│   └── serviceRegister.js           # Tự đăng ký vào Gateway
├── project-service/
│   ├── server.js
│   └── serviceRegister.js
├── task-service/
│   ├── server.js                    # Includes WatchProjectTasks handler
│   └── serviceRegister.js
├── proto/
│   ├── user.proto
│   ├── project.proto
│   ├── task.proto
│   └── notification.proto
├── scripts/
│   └── mongo-init.js               # Khởi tạo MongoDB Replica Set
├── ServiceRegistry.js              # Root-level copy (tham khảo)
└── docker-compose.yml
```

---

## Khởi động

### Yêu cầu

- Docker & Docker Compose

### Chạy toàn bộ hệ thống

```bash
docker compose up --build
```

Kiểm tra API Gateway:

```bash
curl http://localhost:3000/health
```

---

## API Reference

### Health & Monitoring

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/health` | Trạng thái API Gateway |
| GET | `/health/circuit-breakers` | Trạng thái từng circuit breaker |
| GET | `/health/load-balancer` | Thống kê phân phối request (Round-Robin) |
| GET | `/registry/status` | Toàn bộ service registry (debug) |

### Users

| Method | Path | Body / Params | Mô tả |
|--------|------|---------------|-------|
| POST | `/users` | `{ name, email }` | Tạo user mới |
| GET | `/users/:id` | — | Lấy thông tin user |

### Projects

| Method | Path | Body / Params | Mô tả |
|--------|------|---------------|-------|
| POST | `/projects` | `{ name, description }` | Tạo project mới |
| GET | `/projects` | — | Danh sách tất cả project |

### Tasks

| Method | Path | Body / Params | Mô tả |
|--------|------|---------------|-------|
| POST | `/tasks` | `{ title, description, project_id, assignee_id, priority }` | Tạo task |
| GET | `/tasks/:id` | — | Lấy thông tin task |
| PATCH | `/tasks/:id` | `{ status?, priority?, assignee_id? }` | Cập nhật task |
| DELETE | `/tasks/:id` | — | Xoá task |
| GET | `/projects/:id/tasks` | — | Danh sách task của project |
| GET | `/tasks/stream/:projectId` | — | SSE stream real-time thay đổi |

#### SSE Stream example

```bash
curl -N http://localhost:3000/tasks/stream/PROJECT_ID
```

Các event types: `SNAPSHOT`, `CREATED`, `UPDATED`, `DELETED`, `HEARTBEAT`, `ERROR`

---

## Bugs đã sửa

| # | Mức độ | Vấn đề | Sửa |
|---|--------|--------|-----|
| 1 | Critical | `api-gateway/server.js` hardcode địa chỉ gRPC, bỏ qua toàn bộ ServiceRegistry / LoadBalancer / CircuitBreaker / FaultTolerantClient | Rewrite `server.js` dùng `FaultTolerantClient` cho mọi RPC call; đăng ký `serviceDiscoveryPlugin` |
| 2 | Critical | `LoadBalancer.js` require `'./ServiceRegistry'` nhưng `ServiceRegistry.js` nằm ở thư mục gốc | Tạo `api-gateway/lib/` chứa tất cả internal modules; `LoadBalancer` và `ServiceRegistry` đặt cùng thư mục |
| 3 | Critical | `serviceDiscovery.plugin.js` (3 bản copy) require `'../lib/'` không tồn tại | Tạo `api-gateway/lib/`; sửa require paths cho từng vị trí |
| 4 | Critical | `task-service/tasks-stream.js` require `'../lib/FaultTolerantClient'` sai vị trí; file này là code của API Gateway | Di chuyển sang `api-gateway/tasks-stream.js`; sửa require thành `'./lib/FaultTolerantClient'`; implement `WatchProjectTasks` handler trong `task-service/server.js` |
| 5 | Critical | `mongo-init.js` ở thư mục gốc nhưng `docker-compose.yml` mount `./scripts/mongo-init.js` | Di chuyển file vào `scripts/mongo-init.js` |
| 6 | Major | `CreateTask` trả `Task` trực tiếp thay vì `TaskResponse = { task: Task }` → gRPC nhận object rỗng | Thêm helper `toResponse(doc)` wrap mọi task response trong `{ task: ... }` |
| 7 | Major | `task-service/server.js` chỉ implement 2/6 RPC; `ListProjectTasks` sai tên (proto dùng `GetTasksByProject`) | Implement đủ 6 RPC: `CreateTask`, `GetTask`, `UpdateTask`, `DeleteTask`, `GetTasksByProject`, `WatchProjectTasks` |
| 8 | Major | `watchProjectTasks` query dùng `projectId` trong khi schema lưu `project_id` → trả [] rỗng | Thống nhất dùng `project_id` trong schema, query, và Change Stream filter |
| 9 | Minor | `withRetry` vòng lặp `attempt <= maxRetries` thực hiện `maxRetries + 1` lần | Đổi thành `attempt < maxRetries` |
| 10 | Minor | `ServiceRegistry.snapshot()` label `aliveFor` gây nhầm lẫn (thực chất đo thời gian từ heartbeat cuối) | Đổi thành `secondsSinceHeartbeat` (trả về số giây) |

---

## Luồng Service Discovery

```
Microservice khởi động
        │
        ▼
POST /registry/register  → nhận instanceId
        │
        ▼
┌─── mỗi 10 giây ───┐
│ POST /registry/    │
│ heartbeat          │
│ (tự re-register   │
│  nếu 404)          │
└────────────────────┘
        │
        ▼ (SIGTERM)
DELETE /registry/deregister
```

Registry tự động xoá instance sau 30 giây không có heartbeat.

---

## Thiết kế FaultTolerantClient

Mỗi gRPC unary call đi qua:

```
callUnaryRPC()
    │
    ▼
CircuitBreaker.call()
    │  OPEN? → throw fast-fail
    ▼
withRetry(fn, maxRetries=3)   ← gọi tối đa 3 lần
    │
    ▼
LoadBalancer.pick(service)   ← Round-Robin
    │
    ▼
buildClient(address)          ← cache gRPC channel
    │
    ▼
callUnary(client, method)     ← 5s deadline
```

Backoff: 200ms → 400ms → 800ms

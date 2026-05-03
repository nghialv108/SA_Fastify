# SA_Fastify — Project Management System

Một hệ thống quản lý dự án (Project Management System) được xây dựng theo kiến trúc **Microservices** sử dụng **Fastify**, **gRPC**, và **MongoDB**, đóng gói hoàn toàn bằng **Docker Compose**.

---

## Tổng quan kiến trúc

```
Client
  │
  ▼
┌─────────────┐         ┌──────────────┐
│ API Gateway │ ──gRPC──▶ user-service │───┐
│  (port 3000)│         └──────────────┘   │
│             │         ┌──────────────┐   │   ┌──────────┐
│             │ ──gRPC──▶project-service│──┼───▶ MongoDB  │
│             │         └──────────────┘   │   │  :27017  │
│             │         ┌──────────────┐   │   └──────────┘
│             │ ──gRPC──▶ task-service │───┘
└─────────────┘         └──────────────┘
```

Toàn bộ các service giao tiếp nội bộ qua **gRPC** (định nghĩa bằng Protobuf trong thư mục `/proto`). Mỗi service sở hữu **database riêng biệt** trên cùng một MongoDB instance theo nguyên tắc *database-per-service*.

---

## Cấu trúc thư mục

```
SA_Fastify/
├── api-gateway/        # Entry point, điều phối request đến các service
├── user-service/       # Quản lý người dùng
├── project-service/    # Quản lý dự án
├── task-service/       # Quản lý công việc (task)
├── proto/              # Định nghĩa Protobuf dùng chung cho gRPC
├── docker-compose.yml  # Orchestration toàn bộ hệ thống
└── .gitignore
```

---

## Các thành phần chính

### API Gateway
- Cổng duy nhất tiếp nhận request từ client (`localhost:3000`)
- Định tuyến và chuyển tiếp request đến đúng microservice qua gRPC
- Không xử lý business logic trực tiếp

### User Service
- Quản lý tài khoản người dùng (tạo, xác thực, cập nhật)
- Database: `user_db` trên MongoDB

### Project Service
- Quản lý thông tin dự án
- Database: `project_db` trên MongoDB

### Task Service
- Quản lý các task/công việc trong dự án
- Database: `task_db` trên MongoDB

### MongoDB
- Phiên bản: `mongo:6.0`
- Dữ liệu được lưu trữ vĩnh viễn qua Docker volume `mongo-data`
- Port: `27017`

---

## Yêu cầu hệ thống

- [Docker](https://www.docker.com/) >= 20.x
- [Docker Compose](https://docs.docker.com/compose/) >= 2.x

---

## Cài đặt & Chạy dự án

### 1. Clone repository

```bash
git clone https://github.com/nghialv108/SA_Fastify.git
cd SA_Fastify
```

### 2. Khởi động toàn bộ hệ thống

```bash
docker compose up --build
```

Lần đầu chạy sẽ mất thêm thời gian để build image. Sau khi hoàn tất, API Gateway sẽ sẵn sàng tại:

```
http://localhost:3000
```

### 3. Dừng hệ thống

```bash
docker compose down
```

Để xóa luôn dữ liệu MongoDB:

```bash
docker compose down -v
```

---

## Biến môi trường

Các biến môi trường được cấu hình trực tiếp trong `docker-compose.yml`:

| Service          | Biến              | Giá trị mặc định                         |
|------------------|-------------------|------------------------------------------|
| user-service     | `MONGO_URI`       | `mongodb://mongodb:27017/user_db`        |
| project-service  | `MONGO_URI`       | `mongodb://mongodb:27017/project_db`     |
| task-service     | `MONGO_URI`       | `mongodb://mongodb:27017/task_db`        |

---

## Công nghệ sử dụng

| Công nghệ       | Vai trò                                      |
|-----------------|----------------------------------------------|
| **Fastify**     | HTTP framework cho API Gateway & các service |
| **gRPC**        | Giao tiếp nội bộ giữa các microservice       |
| **Protobuf**    | Định nghĩa contract giữa các service         |
| **MongoDB 6.0** | Cơ sở dữ liệu NoSQL                          |
| **Docker**      | Container hóa từng service                   |
| **Docker Compose** | Orchestration toàn bộ hệ thống            |
| **Node.js / JavaScript** | Ngôn ngữ lập trình chính           |

---

## Phát triển cục bộ (Local Development)

Docker Compose được cấu hình **volume mount** mã nguồn trực tiếp vào container, nghĩa là thay đổi code sẽ được phản ánh ngay mà không cần rebuild:

```bash
# Chạy và theo dõi log realtime
docker compose up

# Chạy nền (detached mode)
docker compose up -d

# Xem log của một service cụ thể
docker compose logs -f api-gateway
docker compose logs -f user-service
```

---

## Kiến trúc mạng

Tất cả các service thuộc cùng một Docker network nội bộ `pms-net` (bridge). Chỉ có **API Gateway** (`port 3000`) và **MongoDB** (`port 27017`) được expose ra máy host.

---

## Tác giả

- **nghialv108** — [GitHub](https://github.com/nghialv108)
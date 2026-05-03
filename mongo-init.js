// scripts/mongo-init.js
// Khởi tạo Replica Set cho MongoDB để Change Stream hoạt động
// (Change Stream là nền tảng của WatchProjectTasks Streaming RPC)

rs.initiate({
  _id: "rs0",
  members: [{ _id: 0, host: "mongodb:27017" }]
});

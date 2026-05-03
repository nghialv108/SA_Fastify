'use strict';

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const mongoose = require('mongoose');

// ── MongoDB connection ────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/task_db';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Task Service connected to MongoDB (task_db)'))
  .catch(err => console.error('MongoDB connection error:', err));

// ── Schema ───────────────────────────────────────────────────────────────────
const taskSchema = new mongoose.Schema({
  title: String,
  description: String,
  // Fix #8: field is stored as project_id (consistent with proto)
  project_id: String,
  assignee_id: String,
  status: { type: String, default: 'todo' },
  priority: { type: String, default: 'medium' },
}, { timestamps: true });

taskSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    ret.created_at = ret.createdAt ? ret.createdAt.toISOString() : '';
    ret.updated_at = ret.updatedAt ? ret.updatedAt.toISOString() : '';
    delete ret._id;
    delete ret.__v;
    delete ret.createdAt;
    delete ret.updatedAt;
    return ret;
  },
});

const Task = mongoose.model('Task', taskSchema);

// ── Proto load ────────────────────────────────────────────────────────────────
const packageDef = protoLoader.loadSync(path.join(__dirname, '../proto/task.proto'),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const taskProto = grpc.loadPackageDefinition(packageDef).task;

// ── Helper: wrap Task doc in TaskResponse ─────────────────────────────────────
// Fix #6: Proto defines CreateTask/GetTask/UpdateTask → TaskResponse = { task: Task }
// Previously server returned Task directly → gRPC serialised as empty object
function toResponse(doc) {
  return { task: doc.toJSON ? doc.toJSON() : doc };
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC Handlers
// ─────────────────────────────────────────────────────────────────────────────

// Fix #7: implement all 6 RPCs declared in task.proto

async function CreateTask(call, callback) {
  try {
    const { title, description, project_id, assignee_id, priority } = call.request;
    const doc = await new Task({ title, description, project_id, assignee_id, priority }).save();
    console.log(`[Task] Created: ${doc.title}`);
    // Fix #6: wrap in { task: ... }
    callback(null, toResponse(doc));
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, details: err.message });
  }
}

async function GetTask(call, callback) {
  try {
    const doc = await Task.findById(call.request.id);
    if (!doc) return callback({ code: grpc.status.NOT_FOUND, details: 'Task not found' });
    callback(null, toResponse(doc));
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, details: err.message });
  }
}

async function UpdateTask(call, callback) {
  try {
    const { id, status, priority, assignee_id } = call.request;
    const updates = {};
    if (status) updates.status = status;
    if (priority) updates.priority = priority;
    if (assignee_id) updates.assignee_id = assignee_id;

    const doc = await Task.findByIdAndUpdate(id, updates, { new: true });
    if (!doc) return callback({ code: grpc.status.NOT_FOUND, details: 'Task not found' });
    callback(null, toResponse(doc));
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, details: err.message });
  }
}

async function DeleteTask(call, callback) {
  try {
    const result = await Task.findByIdAndDelete(call.request.id);
    callback(null, { success: !!result });
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, details: err.message });
  }
}

// Fix #7: renamed ListProjectTasks → GetTasksByProject to match proto definition
// Returns TaskListResponse = { tasks: Task[] }
async function GetTasksByProject(call, callback) {
  try {
    // Fix #8: query uses project_id (consistent with schema field name)
    const docs = await Task.find({ project_id: call.request.project_id });
    callback(null, { tasks: docs.map(d => d.toJSON()) });
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, details: err.message });
  }
}

// WatchProjectTasks – Server-side Streaming
// Moved implementation here from task-service/tasks-stream.js (Fix #4)
async function WatchProjectTasks(call) {
  // Fix #8: use project_id (matches schema field) instead of projectId
  const { project_id } = call.request;
  let changeStream = null;

  console.log(`[WatchProjectTasks] Client connected, project: ${project_id}`);

  try {
    // Step 1: send SNAPSHOT of existing tasks
    // Fix #8: query by project_id (field stored in DB), not projectId
    const existing = await Task.find({ project_id }).lean();
    for (const task of existing) {
      call.write({ event_type: 'SNAPSHOT', task: toProtoTask(task), timestamp: new Date().toISOString() });
    }
    console.log(`[WatchProjectTasks] Sent ${existing.length} snapshot tasks`);

    // Step 2: open MongoDB Change Stream (requires Replica Set – see scripts/mongo-init.js)
    // Fix #8: filter uses 'fullDocument.project_id' (matches schema), not 'fullDocument.projectId'
    changeStream = Task.watch(
      [{ $match: { 'fullDocument.project_id': project_id } }],
      { fullDocument: 'updateLookup' }
    );

    changeStream.on('change', (change) => {
      const eventTypeMap = { insert: 'CREATED', update: 'UPDATED', replace: 'UPDATED', delete: 'DELETED' };
      const event_type = eventTypeMap[change.operationType];
      if (!event_type) return;

      const doc = change.fullDocument || change.documentKey;
      call.write({ event_type, task: toProtoTask(doc), timestamp: new Date().toISOString() });
    });

    changeStream.on('error', (err) => {
      console.error(`[WatchProjectTasks] Change stream error: ${err.message}`);
      call.end();
    });

  } catch (err) {
    console.error(`[WatchProjectTasks] Fatal error: ${err.message}`);
    call.destroy(err);
  }

  call.on('cancelled', () => {
    console.log(`[WatchProjectTasks] Client disconnected: ${project_id}`);
    if (changeStream) changeStream.close();
  });
}

function toProtoTask(doc) {
  if (!doc) return {};
  return {
    id: String(doc._id || ''),
    title: doc.title || '',
    description: doc.description || '',
    status: doc.status || 'todo',
    priority: doc.priority || 'medium',
    // Fix #8: read from project_id (consistent field name)
    project_id: doc.project_id || '',
    assignee_id: doc.assignee_id || '',
    created_at: doc.createdAt ? doc.createdAt.toISOString() : '',
    updated_at: doc.updatedAt ? doc.updatedAt.toISOString() : '',
  };
}

// ── gRPC Server ───────────────────────────────────────────────────────────────
const server = new grpc.Server();
server.addService(taskProto.TaskService.service, {
  // Fix #7: all 6 RPCs from proto now implemented
  CreateTask,
  GetTask,
  UpdateTask,
  DeleteTask,
  GetTasksByProject,
  WatchProjectTasks,
});

server.bindAsync('0.0.0.0:50053', grpc.ServerCredentials.createInsecure(), () => {
  console.log('Task Service running on port 50053');
});

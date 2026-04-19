const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const mongoose = require('mongoose');

// 1. Kết nối MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/task_db';
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Task Service connected to MongoDB (task_db)'))
    .catch(err => console.error('MongoDB connection error:', err));

// 2. Định nghĩa Schema cho Task
const taskSchema = new mongoose.Schema({
    title: String,
    project_id: String,
    status: String
});
taskSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
    }
});
const Task = mongoose.model('Task', taskSchema);

// Load Proto
const packageDef = protoLoader.loadSync(path.join(__dirname, '../proto/task.proto'));
const taskProto = grpc.loadPackageDefinition(packageDef).task;

// 3. Logic RPC
async function CreateTask(call, callback) {
    try {
        const newTask = new Task({
            title: call.request.title,
            project_id: call.request.project_id,
            status: 'TODO'
        });
        const savedTask = await newTask.save();
        console.log(`[Task] Created in DB: ${savedTask.title}`);
        callback(null, savedTask.toJSON());
    } catch (error) {
        callback({ code: grpc.status.INTERNAL, details: error.message });
    }
}

async function ListProjectTasks(call) {
    try {
        // Tìm các task thuộc về project_id được gửi lên
        const tasks = await Task.find({ project_id: call.request.project_id });
        tasks.forEach(t => call.write(t.toJSON()));
        call.end();
    } catch (error) {
        call.emit('error', { code: grpc.status.INTERNAL, details: error.message });
    }
}

const server = new grpc.Server();
server.addService(taskProto.TaskService.service, { CreateTask, ListProjectTasks });
server.bindAsync('0.0.0.0:50053', grpc.ServerCredentials.createInsecure(), () => {
    console.log('Task Service running on port 50053');
});
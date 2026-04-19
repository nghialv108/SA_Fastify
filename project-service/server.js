const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const mongoose = require('mongoose');

// 1. Kết nối MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/project_db';
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Project Service connected to MongoDB (project_db)'))
    .catch(err => console.error('MongoDB connection error:', err));

// 2. Định nghĩa Schema cho Project
const projectSchema = new mongoose.Schema({
    name: String,
    owner_id: String
});
projectSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString(); // Map _id của Mongo sang id của gRPC
        delete ret._id;
        delete ret.__v;
    }
});
const Project = mongoose.model('Project', projectSchema);

// Load Proto
const packageDef = protoLoader.loadSync(path.join(__dirname, '../proto/project.proto'));
const projectProto = grpc.loadPackageDefinition(packageDef).project;

// 3. Logic RPC
async function CreateProject(call, callback) {
    try {
        const newProject = new Project({
            name: call.request.name,
            owner_id: call.request.owner_id
        });
        const savedProject = await newProject.save();
        console.log(`[Project] Created in DB: ${savedProject.name}`);
        callback(null, savedProject.toJSON());
    } catch (error) {
        callback({ code: grpc.status.INTERNAL, details: error.message });
    }
}

async function ListProjects(call) {
    try {
        const projects = await Project.find();
        // Bắn từng project qua luồng Stream
        projects.forEach(p => call.write(p.toJSON()));
        call.end();
    } catch (error) {
        call.emit('error', { code: grpc.status.INTERNAL, details: error.message });
    }
}

const server = new grpc.Server();
server.addService(projectProto.ProjectService.service, { CreateProject, ListProjects });
server.bindAsync('0.0.0.0:50052', grpc.ServerCredentials.createInsecure(), () => {
    console.log('Project Service running on port 50052');
});
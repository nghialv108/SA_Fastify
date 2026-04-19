const fastify = require('fastify')({ logger: true });
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

// Load Protos
const loadProto = (filename) => grpc.loadPackageDefinition(
    protoLoader.loadSync(path.join(__dirname, '../proto', filename))
);
const userProto = loadProto('user.proto').user;
const projectProto = loadProto('project.proto').project;
const taskProto = loadProto('task.proto').task;

// Init gRPC Clients (Trỏ tới các container Docker)
const userClient = new userProto.UserService('user-service:50051', grpc.credentials.createInsecure());
const projectClient = new projectProto.ProjectService('project-service:50052', grpc.credentials.createInsecure());
const taskClient = new taskProto.TaskService('task-service:50053', grpc.credentials.createInsecure());

// --- ROUTES ---

// 1. Users
fastify.post('/users', (req, reply) => {
    userClient.CreateUser(req.body, (err, response) => err ? reply.status(500).send(err) : reply.send(response));
});

// 2. Projects
fastify.post('/projects', (req, reply) => {
    projectClient.CreateProject(req.body, (err, response) => err ? reply.status(500).send(err) : reply.send(response));
});

fastify.get('/projects', (req, reply) => {
    const call = projectClient.ListProjects({});
    const projects = [];
    call.on('data', p => projects.push(p));
    call.on('end', () => reply.send(projects));
});

// 3. Tasks
fastify.post('/tasks', (req, reply) => {
    taskClient.CreateTask(req.body, (err, response) => err ? reply.status(500).send(err) : reply.send(response));
});

fastify.get('/projects/:id/tasks', (req, reply) => {
    const call = taskClient.ListProjectTasks({ project_id: req.params.id });
    const tasks = [];
    call.on('data', t => tasks.push(t));
    call.on('end', () => reply.send(tasks));
});

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
    if (err) process.exit(1);
    console.log('API Gateway running on port 3000');
});
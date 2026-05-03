'use strict';

const fastify = require('fastify')({ logger: true });
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

// ── Modules built in api-gateway/lib/ ────────────────────────────────────────
// Fix #1: Use FaultTolerantClient (LoadBalancer + CircuitBreaker + Retry)
// instead of hardcoded gRPC addresses
const { callUnaryRPC, callServerStream } = require('./lib/FaultTolerantClient');
const loadBalancer = require('./lib/LoadBalancer');
const circuitBreakers = require('./lib/CircuitBreaker');

// ── Plugin: Service Discovery (registry + health endpoints) ──────────────────
// Fix #3: plugin path is local (./serviceDiscovery.plugin), lib/ now exists
const serviceDiscoveryPlugin = require('./serviceDiscovery.plugin');
fastify.register(serviceDiscoveryPlugin);

// ── SSE stream routes (relay gRPC stream → SSE) ───────────────────────────────
const taskStreamRoutes = require('./tasks-stream');
fastify.register(taskStreamRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PROTO_PATH = '/proto';

function userRPC(method, request) {
  return callUnaryRPC({
    protoFile: 'user.proto', package: 'user', service: 'UserService',
    grpcService: 'user-service', method, request
  });
}

function projectRPC(method, request) {
  return callUnaryRPC({
    protoFile: 'project.proto', package: 'project', service: 'ProjectService',
    grpcService: 'project-service', method, request
  });
}

function taskRPC(method, request) {
  return callUnaryRPC({
    protoFile: 'task.proto', package: 'task', service: 'TaskService',
    grpcService: 'task-service', method, request
  });
}

// Helper for server-streaming RPCs (ListProjects, etc.)
function collectStream(grpcService, protoFile, pkg, svc, method, request) {
  return new Promise((resolve, reject) => {
    const cb = circuitBreakers.get(grpcService);
    cb.call(() => new Promise((res, rej) => {
      const instance = loadBalancer.pick(grpcService);
      const address = `${instance.host}:${instance.grpcPort}`;
      const pkgDef = protoLoader.loadSync(path.join(PROTO_PATH, protoFile),
        { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
      const client = new (grpc.loadPackageDefinition(pkgDef)[pkg][svc])(
        address, grpc.credentials.createInsecure());
      const call = client[method](request);
      const items = [];
      call.on('data', item => items.push(item));
      call.on('end', () => res(items));
      call.on('error', rej);
    })).then(resolve).catch(reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes – Users
// ─────────────────────────────────────────────────────────────────────────────

fastify.post('/users', async (req, reply) => {
  try { return reply.code(201).send(await userRPC('CreateUser', req.body)); }
  catch (err) { return reply.code(503).send({ error: err.message }); }
});

fastify.get('/users/:id', async (req, reply) => {
  try { return reply.send(await userRPC('GetUser', { id: req.params.id })); }
  catch (err) { return reply.code(503).send({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes – Projects
// ─────────────────────────────────────────────────────────────────────────────

fastify.post('/projects', async (req, reply) => {
  try { return reply.code(201).send(await projectRPC('CreateProject', req.body)); }
  catch (err) { return reply.code(503).send({ error: err.message }); }
});

fastify.get('/projects', async (req, reply) => {
  try {
    const projects = await collectStream('project-service', 'project.proto',
      'project', 'ProjectService', 'ListProjects', {});
    return reply.send(projects);
  } catch (err) { return reply.code(503).send({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes – Tasks
// ─────────────────────────────────────────────────────────────────────────────

fastify.post('/tasks', async (req, reply) => {
  try { return reply.code(201).send(await taskRPC('CreateTask', req.body)); }
  catch (err) { return reply.code(503).send({ error: err.message }); }
});

fastify.get('/tasks/:id', async (req, reply) => {
  try { return reply.send(await taskRPC('GetTask', { id: req.params.id })); }
  catch (err) { return reply.code(503).send({ error: err.message }); }
});

fastify.patch('/tasks/:id', async (req, reply) => {
  try { return reply.send(await taskRPC('UpdateTask', { id: req.params.id, ...req.body })); }
  catch (err) { return reply.code(503).send({ error: err.message }); }
});

fastify.delete('/tasks/:id', async (req, reply) => {
  try { return reply.send(await taskRPC('DeleteTask', { id: req.params.id })); }
  catch (err) { return reply.code(503).send({ error: err.message }); }
});

// GetTasksByProject unary RPC → returns TaskListResponse { tasks: [] }
fastify.get('/projects/:id/tasks', async (req, reply) => {
  try {
    const response = await taskRPC('GetTasksByProject', { project_id: req.params.id });
    return reply.send(response.tasks || []);
  } catch (err) { return reply.code(503).send({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
  if (err) { fastify.log.error(err); process.exit(1); }
  fastify.log.info('API Gateway running on port 3000');
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import User from './models/User.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let baseUrl;
let server;
let mongo;
let serverOutput = '';
let firstToken;
let secondToken;
let noteId;
let chatId;

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function request(pathname, { token, method = 'GET', body, origin } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      MONGODB_URI: mongo.getUri('mini-study-buddy-test'),
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-bytes',
      OPENAI_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  server.on('error', error => { serverOutput += `${error.message}\n`; });
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.exitCode !== null) throw new Error(`Test server exited with code ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `test server should start at ${baseUrl} with ${mongo.getUri('mini-study-buddy-test')} (pid ${server.pid}, exit ${server.exitCode}):\n${serverOutput}`);
  await mongoose.connect(mongo.getUri('mini-study-buddy-test'));
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test('auth rejects invalid input and issues student accounts', async () => {
  let response = await request('/api/auth/register', { method: 'POST', body: { email: 'bad', password: '12345678' } });
  assert.equal(response.status, 400);
  response = await request('/api/auth/register', { method: 'POST', body: { email: 'student@example.test', password: 'learning-123', role: 'admin' } });
  assert.equal(response.status, 201);
  const first = await response.json();
  assert.equal(first.role, 'student');
  firstToken = first.token;
  response = await request('/api/auth/register', { method: 'POST', body: { email: 'student@example.test', password: 'learning-123' } });
  assert.equal(response.status, 409);
  response = await request('/api/auth/login', { method: 'POST', body: { email: 'student@example.test', password: 'incorrect-password' } });
  assert.equal(response.status, 401);
  response = await request('/api/auth/login', { method: 'POST', body: { email: 'student@example.test', password: 'learning-123' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).role, 'student');
  response = await request('/api/auth/register', { method: 'POST', body: { email: 'other@example.test', password: 'learning-456' } });
  assert.equal(response.status, 201);
  secondToken = (await response.json()).token;
});

test('protected routes reject anonymous users and students cannot access admin data', async () => {
  assert.equal((await request('/api/notes')).status, 401);
  assert.equal((await request('/api/admin/stats', { token: firstToken })).status, 403);
  assert.equal((await request('/api/nonexistent')).status, 404);
  const blockedOrigin = await request('/api/status', { origin: 'https://not-allowed.example' });
  assert.equal(blockedOrigin.status, 403);

  const admin = await User.create({
    name: 'Admin',
    email: 'admin@example.test',
    password: '$2b$12$adminhash',
    role: 'admin'
  });
  const adminToken = jwt.sign({ id: admin.id }, 'test-secret-with-more-than-thirty-two-bytes', { expiresIn: '2h' });
  const stats = await request('/api/admin/stats', { token: adminToken });
  assert.equal(stats.status, 200);
  assert.equal((await stats.json()).totalUsers, 3);
  assert.equal((await request('/api/admin/users', { token: adminToken })).status, 200);
  assert.deepEqual(await (await request('/api/admin/usage', { token: adminToken })).json(), []);
});

test('usage starts empty for a newly registered account', async () => {
  const usageResponse = await request('/api/usage', { token: firstToken });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.requests, 0);
  assert.deepEqual(usage.recent, []);
});

test('note CRUD is stored in MongoDB and scoped to the account', async () => {
  let response = await request('/api/notes', {
    token: firstToken, method: 'POST',
    body: { title: 'Plant biology', content: 'Plants use sunlight to make food through photosynthesis.' }
  });
  assert.equal(response.status, 201);
  noteId = (await response.json()).id;
  response = await request('/api/notes', { token: firstToken });
  const notes = await response.json();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, noteId);
  assert.equal((await request('/api/notes/not-an-object-id', { token: firstToken })).status, 400);
  response = await request(`/api/notes/${noteId}`, { token: firstToken });
  assert.equal((await response.json()).content, 'Plants use sunlight to make food through photosynthesis.');
  response = await request('/api/notes', { token: secondToken });
  assert.equal((await response.json()).length, 0);
  assert.equal((await request(`/api/notes/${noteId}`, { token: secondToken })).status, 404);
  assert.equal((await request(`/api/notes/${noteId}`, {
    token: secondToken, method: 'PATCH',
    body: { title: 'Private edit', content: 'Not allowed.' }
  })).status, 404);
  assert.equal((await request(`/api/notes/${noteId}`, { token: secondToken, method: 'DELETE' })).status, 404);
  await new Promise(resolve => setTimeout(resolve, 1100));
  response = await request(`/api/notes/${noteId}`, {
    token: firstToken, method: 'PATCH',
    body: { title: 'Updated plant biology', content: 'Updated photosynthesis note.' }
  });
  assert.equal(response.status, 200);
  response = await request(`/api/notes/${noteId}`, { token: firstToken });
  const updated = await response.json();
  assert.equal(updated.title, 'Updated plant biology');
  assert.equal(updated.content, 'Updated photosynthesis note.');
  assert.ok(new Date(updated.updated_at) > new Date(updated.created_at));
  assert.equal((await request(`/api/notes/${noteId}`, { token: firstToken, method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/notes/${noteId}`, { token: firstToken })).status, 404);
});

test('chat streams a labelled demo answer, persists history, and enforces ownership', async () => {
  const response = await request('/api/chat', {
    token: firstToken, method: 'POST', body: { question: 'How does sunlight help plants?' }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text();
  assert.match(stream, /Demo response/);
  assert.match(stream, /"demo":true/);
  chatId = JSON.parse(stream.split('event: done\ndata: ')[1].split('\n')[0]).chatId;
  assert.equal((await request(`/api/chats/${chatId}`, { token: secondToken })).status, 404);
  const chat = await (await request(`/api/chats/${chatId}`, { token: firstToken })).json();
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].role, 'user');
  assert.equal(chat.messages[1].role, 'assistant');
  assert.match(chat.messages[1].content, /Demo response/);
  const chats = await (await request('/api/chats', { token: firstToken })).json();
  assert.equal(chats[0].id, chatId);
  assert.equal(chats[0].last_message, chat.messages[1].content);
  assert.deepEqual(await (await request('/api/chats', { token: secondToken })).json(), []);
  assert.equal((await request(`/api/chats/${chatId}`, { token: secondToken, method: 'DELETE' })).status, 404);
  assert.equal((await request(`/api/chats/${chatId}`, { token: firstToken, method: 'DELETE' })).status, 200);
});

test('planner validates input and returns a demo plan without an AI key', async () => {
  let response = await request('/api/study-plan', {
    token: firstToken, method: 'POST', body: { topic: 'fractions', minutes: 3, difficulty: 'beginner' }
  });
  assert.equal(response.status, 400);
  response = await request('/api/study-plan', {
    token: firstToken, method: 'POST', body: { topic: 'fractions', minutes: 30, difficulty: 'beginner' }
  });
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.demo, true);
  assert.equal(plan.tasks.reduce((sum, task) => sum + task.minutes, 0), 30);
});

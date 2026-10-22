import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let baseUrl;
let server;
let tempDirectory;
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
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'study-buddy-test-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const databasePath = path.join(tempDirectory, 'test.db');
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,email TEXT UNIQUE,password_hash TEXT,role TEXT DEFAULT 'student',google_id TEXT
  );
  CREATE TABLE notes (id INTEGER PRIMARY KEY,title TEXT,content TEXT,embedding TEXT);
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY,user_id INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,
    estimated_cost_usd REAL,created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO users (email,role) VALUES ('legacy@example.test','student');
  INSERT INTO notes (title,content) VALUES ('Unowned legacy note','Must not be exposed to another account.');
  INSERT INTO usage (user_id,model,input_tokens,output_tokens,estimated_cost_usd) VALUES (1,'legacy-model',8,5,0.0001);`);
  legacyDb.close();
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-bytes',
      OPENAI_API_KEY: ''
    },
    stdio: 'inherit'
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Test server exited with code ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'test server should start');
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
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
});

test('database migration preserves usage and keeps unowned legacy notes private', async () => {
  const legacyToken = jwt.sign({ id: 1 }, 'test-secret-with-more-than-thirty-two-bytes', { expiresIn: '2h' });
  const usageResponse = await request('/api/usage', { token: legacyToken });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.requests, 1);
  assert.equal(usage.input_tokens, 8);
  assert.deepEqual(await (await request('/api/notes', { token: firstToken })).json(), []);
});

test('notes are stored and scoped to the account', async () => {
  let response = await request('/api/notes', {
    token: firstToken, method: 'POST',
    body: { title: 'Plant biology', content: 'Plants use sunlight to make food through photosynthesis.' }
  });
  assert.equal(response.status, 201);
  noteId = (await response.json()).id;
  response = await request('/api/notes', { token: firstToken });
  assert.equal((await response.json()).length, 1);
  response = await request('/api/notes', { token: secondToken });
  assert.equal((await response.json()).length, 0);
  assert.equal((await request(`/api/notes/${noteId}`, { token: secondToken, method: 'DELETE' })).status, 404);
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

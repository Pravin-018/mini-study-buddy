import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import { DatabaseSync } from 'node:sqlite';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import session from 'express-session';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { requireAuth, requireAdmin } from './src/auth.js';
import { answerWithAgent, createStudyPlan, estimateCost, MODEL } from './src/agent.js';
import { retrieveNotes, addNote } from './src/rag.js';

const app = express();
const port = Number(process.env.PORT) || 3000;
const root = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(process.env.DATABASE_PATH || path.join(root, 'study-buddy.db'));
const secret = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is not set; using an ephemeral key. Sessions will expire when the server restarts.');
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters.');
}

db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','admin')),
  google_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}
if (!hasColumn('users', 'created_at')) {
  db.exec('ALTER TABLE users ADD COLUMN created_at TEXT');
  db.exec('UPDATE users SET created_at=CURRENT_TIMESTAMP WHERE created_at IS NULL');
}
if (!hasColumn('notes', 'user_id')) db.exec('ALTER TABLE notes ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
if (!hasColumn('notes', 'created_at')) {
  db.exec('ALTER TABLE notes ADD COLUMN created_at TEXT');
  db.exec('UPDATE notes SET created_at=CURRENT_TIMESTAMP WHERE created_at IS NULL');
}
db.exec(`
CREATE INDEX IF NOT EXISTS notes_user_id_idx ON notes(user_id);
CREATE INDEX IF NOT EXISTS chats_user_id_idx ON chats(user_id);
CREATE INDEX IF NOT EXISTS messages_chat_id_idx ON messages(chat_id);
CREATE INDEX IF NOT EXISTS usage_user_id_idx ON usage_logs(user_id);
`);
const legacyUsageColumns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage'").get()
  ? db.prepare('PRAGMA table_info(usage)').all().map(row => row.name) : [];
const hasUsageMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE name='legacy_usage_v1'").get();
if (!hasUsageMigration && ['user_id', 'model', 'input_tokens', 'output_tokens', 'estimated_cost_usd', 'created_at'].every(column => legacyUsageColumns.includes(column))) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`INSERT INTO usage_logs (user_id,model,input_tokens,output_tokens,estimated_cost_usd,created_at)
      SELECT user_id,model,input_tokens,output_tokens,estimated_cost_usd,created_at FROM usage`);
    db.prepare("INSERT INTO schema_migrations (name) VALUES ('legacy_usage_v1')").run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
app.locals.db = db;
app.locals.jwtSecret = secret;

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 })
  : null;
const allowedOrigins = new Set((process.env.CORS_ORIGIN || `http://localhost:5173,http://localhost:${port}`)
  .split(',').map(origin => origin.trim()).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error('This origin is not allowed.'));
  },
  credentials: true
}));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
const rateLimitHandler = (req, res) => sendError(res, 429, 'Too many requests. Please wait and try again.');
app.use('/api', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler }));
app.use('/api/chat', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler }));

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const issueToken = user => jwt.sign({ id: user.id }, secret, { expiresIn: '2h' });
const publicUser = user => ({ id: user.id, email: user.email, role: user.role });
function bodyString(body, key, maxLength) {
  return typeof body?.[key] === 'string' ? body[key].trim().slice(0, maxLength) : '';
}
function validateId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function sendError(res, status, error) {
  res.status(status).json({ error });
}
function errorStatus(error) {
  return error?.status === 401 || error?.status === 403 || error?.status === 429 ? error.status : 502;
}

const registerHandler = async (req, res) => {
  const email = bodyString(req.body, 'email', 254).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!emailPattern.test(email) || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return sendError(res, 400, 'Enter a valid email and a password of at least 8 characters (up to 72 UTF-8 bytes).');
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(email, passwordHash);
    const user = { id: Number(result.lastInsertRowid), email, role: 'student' };
    res.status(201).json({ token: issueToken(user), user, role: user.role });
  } catch (error) {
    if (error.errcode === 2067 || error.message.includes('UNIQUE constraint failed: users.email')) {
      return sendError(res, 409, 'That email is already registered.');
    }
    console.error('Registration failed:', error);
    return sendError(res, 500, 'Could not create your account.');
  }
};
const loginHandler = async (req, res) => {
  const email = bodyString(req.body, 'email', 254).toLowerCase();
  const password = typeof req.body?.password === 'string' && Buffer.byteLength(req.body.password, 'utf8') <= 72
    ? req.body.password : '';
  const user = db.prepare('SELECT id,email,password_hash,role FROM users WHERE email=?').get(email);
  if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return sendError(res, 401, 'Invalid email or password.');
  }
  res.json({ token: issueToken(user), user: publicUser(user), role: user.role });
};
app.post(['/api/auth/register', '/api/register'], registerHandler);
app.post(['/api/auth/login', '/api/login'], loginHandler);
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('study_buddy_token', { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});
app.get('/api/status', (req, res) => res.json({ aiConfigured: Boolean(client), model: MODEL }));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get('/api/me', requireAuth, (req, res) => res.json(publicUser(req.user)));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  app.use(session({
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60_000 }
  }));
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${port}/auth/google/callback`,
    state: true
  }, (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.trim().toLowerCase();
      if (!email || !emailPattern.test(email) || profile._json?.email_verified !== true) {
        return done(new Error('Google account did not provide a verified email.'));
      }
      let user = db.prepare('SELECT id,email,role,google_id FROM users WHERE google_id=? OR email=?').get(profile.id, email);
      if (!user) {
        const result = db.prepare('INSERT INTO users (email,role,google_id,created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(email, 'student', profile.id);
        user = { id: Number(result.lastInsertRowid), email, role: 'student', google_id: profile.id };
      } else if (!user.google_id) {
        db.prepare('UPDATE users SET google_id=? WHERE id=?').run(profile.id, user.id);
        user.google_id = profile.id;
      }
      done(null, user);
    } catch (error) { done(error); }
  }));
  app.use(passport.initialize());
  app.use(passport.session());
  app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'], session: false }));
  app.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/?oauth=failed' }),
    (req, res) => {
      res.cookie('study_buddy_token', issueToken(req.user), {
        httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 2 * 60 * 60_000
      });
      res.redirect('/?oauth=success');
    });
} else {
  app.get('/auth/google', (req, res) => sendError(res, 503, 'Google sign-in is not configured.'));
}

app.get('/api/notes', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id,title,content,created_at FROM notes WHERE user_id=? ORDER BY id DESC').all(req.user.id));
});
app.post('/api/notes', requireAuth, async (req, res) => {
  const title = bodyString(req.body, 'title', 120);
  const content = bodyString(req.body, 'content', 8000);
  if (!title || !content) return sendError(res, 400, 'Title and note content are required.');
  try {
    const id = await addNote(client, db, req.user.id, title, content);
    res.status(201).json({ id });
  } catch (error) {
    console.error('Note save failed:', error);
    sendError(res, 502, 'Could not save the note. Check the AI provider settings and try again.');
  }
});
app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid note ID.');
  const result = db.prepare('DELETE FROM notes WHERE id=? AND user_id=?').run(id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Note not found.');
  res.json({ ok: true });
});

app.get('/api/chats', requireAuth, (req, res) => {
  const chats = db.prepare(`SELECT c.id,c.title,c.created_at,c.updated_at,
    (SELECT content FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) AS last_message
    FROM chats c WHERE c.user_id=? ORDER BY c.updated_at DESC`).all(req.user.id);
  res.json(chats);
});
app.get('/api/chats/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid chat ID.');
  const chat = db.prepare('SELECT id,title,created_at,updated_at FROM chats WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!chat) return sendError(res, 404, 'Chat not found.');
  chat.messages = db.prepare('SELECT id,role,content,created_at FROM messages WHERE chat_id=? ORDER BY id').all(id);
  res.json(chat);
});
app.delete('/api/chats/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid chat ID.');
  const result = db.prepare('DELETE FROM chats WHERE id=? AND user_id=?').run(id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Chat not found.');
  res.json({ ok: true });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const question = bodyString(req.body, 'question', 2000);
  const requestedChatId = req.body?.chatId === undefined || req.body.chatId === null ? null : validateId(req.body.chatId);
  if (!question) return sendError(res, 400, 'Ask a question first.');
  if (req.body?.chatId != null && !requestedChatId) return sendError(res, 400, 'Invalid chat ID.');
  if (/(ignore (all )?(previous|system) instructions|reveal (the )?(system prompt|secret)|developer message)/i.test(question)) {
    console.warn(`Prompt-injection warning for chat request from user ${req.user.id}.`);
  }
  let chatId = requestedChatId;
  if (chatId) {
    const owned = db.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').get(chatId, req.user.id);
    if (!owned) return sendError(res, 404, 'Chat not found.');
  } else {
    const title = question.length > 64 ? `${question.slice(0, 61)}...` : question;
    chatId = Number(db.prepare('INSERT INTO chats (user_id,title) VALUES (?,?)').run(req.user.id, title).lastInsertRowid);
  }
  db.prepare('INSERT INTO messages (chat_id,role,content) VALUES (?, ?, ?)').run(chatId, 'user', question);
  const controller = new AbortController();
  const abortOnDisconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', abortOnDisconnect);
  let notes;
  try {
    notes = await retrieveNotes(client, db, req.user.id, question, controller.signal);
    if (controller.signal.aborted) return;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const result = await answerWithAgent({
      client, question, notes, signal: controller.signal,
      onText: text => {
        if (!controller.signal.aborted && !res.destroyed) res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    });
    db.prepare('INSERT INTO messages (chat_id,role,content) VALUES (?, ?, ?)').run(chatId, 'assistant', result.text);
    db.prepare('UPDATE chats SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(chatId);
    if (!result.demo) {
      const usage = result.usage;
      const cost = estimateCost(usage.inputTokens, usage.outputTokens);
      db.prepare('INSERT INTO usage_logs (user_id,model,input_tokens,output_tokens,estimated_cost_usd) VALUES (?,?,?,?,?)')
        .run(req.user.id, MODEL, usage.inputTokens, usage.outputTokens, cost);
    }
    res.write(`event: done\ndata: ${JSON.stringify({ chatId, notes: notes.map(note => ({ id: note.id, title: note.title })), demo: result.demo, usage: result.usage || null })}\n\n`);
    res.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error('Chat request failed:', error);
    if (!res.headersSent) return sendError(res, errorStatus(error), 'AI request failed. Check your API key, model, and provider status.');
    if (!res.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'AI request failed. Check your API key, model, and provider status.' })}\n\n`);
      res.end();
    }
  } finally {
    res.off('close', abortOnDisconnect);
  }
});

app.post('/api/study-plan', requireAuth, async (req, res) => {
  const topic = bodyString(req.body, 'topic', 160);
  const minutes = Number(req.body?.minutes);
  const difficulty = bodyString(req.body, 'difficulty', 20);
  if (!topic || !Number.isInteger(minutes) || minutes < 5 || minutes > 480 ||
      !['beginner', 'intermediate', 'advanced'].includes(difficulty)) {
    return sendError(res, 400, 'Enter a topic, 5–480 minutes, and a valid difficulty level.');
  }
  try {
    const plan = await createStudyPlan(client, { topic, minutes, difficulty });
    if (!plan.demo) {
      db.prepare('INSERT INTO usage_logs (user_id,model,input_tokens,output_tokens,estimated_cost_usd) VALUES (?,?,?,?,?)')
        .run(req.user.id, MODEL, plan.usage.inputTokens, plan.usage.outputTokens,
          estimateCost(plan.usage.inputTokens, plan.usage.outputTokens));
    }
    res.json(plan);
  } catch (error) {
    console.error('Study plan generation failed:', error);
    sendError(res, errorStatus(error), 'Could not generate a study plan. Check the AI provider settings.');
  }
});

app.get('/api/usage', requireAuth, (req, res) => {
  const summary = db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(estimated_cost_usd),0) AS estimated_cost_usd
    FROM usage_logs WHERE user_id=?`).get(req.user.id);
  res.json({ ...summary, recent: db.prepare('SELECT model,input_tokens,output_tokens,estimated_cost_usd,created_at FROM usage_logs WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id) });
});
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  const usage = db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens+output_tokens),0) AS total_tokens,
    COALESCE(SUM(estimated_cost_usd),0) AS estimated_cost_usd FROM usage_logs`).get();
  res.json({ totalUsers: users, ...usage });
});
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT u.id,u.email,u.role,u.created_at,COUNT(l.id) AS ai_requests
    FROM users u LEFT JOIN usage_logs l ON l.user_id=u.id GROUP BY u.id ORDER BY u.id DESC LIMIT 200`).all());
});
app.get('/api/admin/usage', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT u.email,l.model,l.input_tokens,l.output_tokens,l.estimated_cost_usd,l.created_at
    FROM usage_logs l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 100`).all());
});

app.use('/api', (req, res) => sendError(res, 404, 'API endpoint not found.'));
const dist = path.join(root, 'client', 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), error => {
    if (error) res.status(404).send('Frontend is not built yet. Run npm run build.');
  });
});
app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error);
  if (res.headersSent) return next(error);
  if (error.message === 'This origin is not allowed.') return sendError(res, 403, error.message);
  if (error.type === 'entity.too.large') return sendError(res, 413, 'Request body is too large.');
  if (error.type === 'entity.parse.failed') return sendError(res, 400, 'Request body must contain valid JSON.');
  sendError(res, 500, 'An unexpected server error occurred.');
});

app.listen(port, () => console.log(`Study Buddy running at http://localhost:${port}${client ? '' : ' (AI demo mode; set OPENAI_API_KEY for live AI)'}`));

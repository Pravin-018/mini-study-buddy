import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import session from 'express-session';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { requireAuth, requireAdmin } from './src/auth.js';
import { answerWithAgent, createStudyPlan, estimateCost, MODEL } from './src/agent.js';
import { retrieveNotes, addNote, generateEmbedding } from './src/rag.js';
import { connectDatabase } from './src/db.js';
import User from './src/models/User.js';
import Note from './src/models/Note.js';
import Chat from './src/models/Chat.js';
import UsageLog from './src/models/UsageLog.js';

const app = express();
const port = Number(process.env.PORT) || 3000;
const root = path.dirname(fileURLToPath(import.meta.url));
const secret = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is not set; using an ephemeral key. Sessions will expire when the server restarts.');
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters.');
}

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
const userId = user => user._id.toString();
const issueToken = user => jwt.sign({ id: userId(user) }, secret, { expiresIn: '2h' });
const publicUser = user => ({ id: userId(user), email: user.email, role: user.role });
function bodyString(body, key, maxLength) {
  return typeof body?.[key] === 'string' ? body[key].trim().slice(0, maxLength) : '';
}
function defaultName(email) {
  return email.split('@')[0].slice(0, 120);
}
function validateId(value) {
  return mongoose.isObjectIdOrHexString(value) ? value : null;
}
function formatDate(value) {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function sendError(res, status, error) {
  res.status(status).json({ error });
}
function errorStatus(error) {
  return error?.status === 401 || error?.status === 403 || error?.status === 429 ? error.status : 502;
}

const registerHandler = asyncHandler(async (req, res) => {
  const email = bodyString(req.body, 'email', 254).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!emailPattern.test(email) || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return sendError(res, 400, 'Enter a valid email and a password of at least 8 characters (up to 72 UTF-8 bytes).');
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name: bodyString(req.body, 'name', 120) || defaultName(email),
      email,
      password: passwordHash
    });
    res.status(201).json({ token: issueToken(user), user: publicUser(user), role: user.role });
  } catch (error) {
    if (error.code === 11000) {
      return sendError(res, 409, 'That email is already registered.');
    }
    throw error;
  }
});
const loginHandler = asyncHandler(async (req, res) => {
  const email = bodyString(req.body, 'email', 254).toLowerCase();
  const password = typeof req.body?.password === 'string' && Buffer.byteLength(req.body.password, 'utf8') <= 72
    ? req.body.password : '';
  const user = await User.findOne({ email }).select('+password');
  if (!user?.password || !(await bcrypt.compare(password, user.password))) {
    return sendError(res, 401, 'Invalid email or password.');
  }
  res.json({ token: issueToken(user), user: publicUser(user), role: user.role });
});
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
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.trim().toLowerCase();
      if (!email || !emailPattern.test(email) || profile._json?.email_verified !== true) {
        return done(new Error('Google account did not provide a verified email.'));
      }
      let user = await User.findOne({ $or: [{ googleId: profile.id }, { email }] });
      if (!user) {
        user = await User.create({
          name: profile.displayName?.trim().slice(0, 120) || defaultName(email),
          email,
          googleId: profile.id
        });
      } else if (!user.googleId) {
        user.googleId = profile.id;
        if (!user.name) user.name = profile.displayName?.trim().slice(0, 120) || defaultName(email);
        await user.save();
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

app.get('/api/notes', requireAuth, asyncHandler(async (req, res) => {
  const notes = await Note.find({ userId: req.user.id })
    .select('title content createdAt')
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  res.json(notes.map(note => ({
    id: note._id.toString(),
    title: note.title,
    content: note.content,
    created_at: formatDate(note.createdAt)
  })));
}));
app.get('/api/notes/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid note ID.');
  const note = await Note.findOne({ _id: id, userId: req.user.id })
    .select('title content createdAt updatedAt')
    .lean();
  if (!note) return sendError(res, 404, 'Note not found.');
  res.json({
    id: note._id.toString(),
    title: note.title,
    content: note.content,
    created_at: formatDate(note.createdAt),
    updated_at: formatDate(note.updatedAt)
  });
}));
app.post('/api/notes', requireAuth, asyncHandler(async (req, res) => {
  const title = bodyString(req.body, 'title', 120);
  const content = bodyString(req.body, 'content', 8000);
  if (!title || !content) return sendError(res, 400, 'Title and note content are required.');
  const id = await addNote(client, req.user.id, title, content);
  res.status(201).json({ id });
}));
const updateNoteHandler = asyncHandler(async (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid note ID.');
  const title = bodyString(req.body, 'title', 120);
  const content = bodyString(req.body, 'content', 8000);
  if (!title || !content) return sendError(res, 400, 'Title and note content are required.');
  if (!await Note.exists({ _id: id, userId: req.user.id })) return sendError(res, 404, 'Note not found.');
  const embedding = await generateEmbedding(client, content);
  const note = await Note.findOneAndUpdate(
    { _id: id, userId: req.user.id },
    { $set: { title, content, embedding } },
    { new: true, runValidators: true }
  ).select('_id');
  if (!note) return sendError(res, 404, 'Note not found.');
  res.json({ id: note._id.toString() });
});
app.put('/api/notes/:id', requireAuth, updateNoteHandler);
app.patch('/api/notes/:id', requireAuth, updateNoteHandler);
app.delete('/api/notes/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid note ID.');
  const note = await Note.findOneAndDelete({ _id: id, userId: req.user.id });
  if (!note) return sendError(res, 404, 'Note not found.');
  res.json({ ok: true });
}));

app.get('/api/chats', requireAuth, asyncHandler(async (req, res) => {
  const chats = await Chat.find({ userId: req.user.id }).sort({ updatedAt: -1 }).lean();
  res.json(chats.map(chat => ({
    id: chat._id.toString(),
    title: chat.title,
    created_at: formatDate(chat.createdAt),
    updated_at: formatDate(chat.updatedAt),
    last_message: chat.messages.at(-1)?.content || null
  })));
}));
app.get('/api/chats/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid chat ID.');
  const chat = await Chat.findOne({ _id: id, userId: req.user.id }).lean();
  if (!chat) return sendError(res, 404, 'Chat not found.');
  res.json({
    id: chat._id.toString(),
    title: chat.title,
    created_at: formatDate(chat.createdAt),
    updated_at: formatDate(chat.updatedAt),
    messages: chat.messages.map(message => ({
      id: message._id.toString(),
      role: message.role,
      content: message.content,
      created_at: formatDate(message.createdAt)
    }))
  });
}));
app.delete('/api/chats/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return sendError(res, 400, 'Invalid chat ID.');
  const chat = await Chat.findOneAndDelete({ _id: id, userId: req.user.id });
  if (!chat) return sendError(res, 404, 'Chat not found.');
  res.json({ ok: true });
}));

app.post('/api/chat', requireAuth, asyncHandler(async (req, res) => {
  const question = bodyString(req.body, 'question', 2000);
  const requestedChatId = req.body?.chatId === undefined || req.body.chatId === null ? null : validateId(req.body.chatId);
  if (!question) return sendError(res, 400, 'Ask a question first.');
  if (req.body?.chatId != null && !requestedChatId) return sendError(res, 400, 'Invalid chat ID.');
  if (/(ignore (all )?(previous|system) instructions|reveal (the )?(system prompt|secret)|developer message)/i.test(question)) {
    console.warn(`Prompt-injection warning for chat request from user ${req.user.id}.`);
  }
  let chatId = requestedChatId;
  const firstMessage = { role: 'user', content: question };
  if (chatId) {
    const chat = await Chat.findOneAndUpdate(
      { _id: chatId, userId: req.user.id },
      { $push: { messages: firstMessage } },
      { new: true }
    ).select('_id');
    if (!chat) return sendError(res, 404, 'Chat not found.');
  } else {
    const title = question.length > 64 ? `${question.slice(0, 61)}...` : question;
    const chat = await Chat.create({ userId: req.user.id, title, messages: [firstMessage] });
    chatId = chat.id;
  }
  const controller = new AbortController();
  const abortOnDisconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', abortOnDisconnect);
  let notes;
  try {
    notes = await retrieveNotes(client, req.user.id, question, controller.signal);
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
    await Chat.findOneAndUpdate(
      { _id: chatId, userId: req.user.id },
      { $push: { messages: { role: 'assistant', content: result.text } } }
    );
    if (!result.demo) {
      const usage = result.usage;
      const cost = estimateCost(usage.inputTokens, usage.outputTokens);
      await UsageLog.create({
        userId: req.user.id,
        model: MODEL,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUsd: cost
      });
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
}));

app.post('/api/study-plan', requireAuth, asyncHandler(async (req, res) => {
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
      await UsageLog.create({
        userId: req.user.id,
        model: MODEL,
        inputTokens: plan.usage.inputTokens,
        outputTokens: plan.usage.outputTokens,
        estimatedCostUsd: estimateCost(plan.usage.inputTokens, plan.usage.outputTokens)
      });
    }
    res.json(plan);
  } catch (error) {
    console.error('Study plan generation failed:', error);
    sendError(res, errorStatus(error), 'Could not generate a study plan. Check the AI provider settings.');
  }
}));

app.get('/api/usage', requireAuth, asyncHandler(async (req, res) => {
  const [totals] = await UsageLog.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
    { $group: {
      _id: null,
      requests: { $sum: 1 },
      input_tokens: { $sum: '$inputTokens' },
      output_tokens: { $sum: '$outputTokens' },
      estimated_cost_usd: { $sum: '$estimatedCostUsd' }
    } },
    { $project: { _id: 0, requests: 1, input_tokens: 1, output_tokens: 1, estimated_cost_usd: 1 } }
  ]);
  const recent = await UsageLog.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(20).lean();
  res.json({
    requests: totals?.requests || 0,
    input_tokens: totals?.input_tokens || 0,
    output_tokens: totals?.output_tokens || 0,
    estimated_cost_usd: totals?.estimated_cost_usd || 0,
    recent: recent.map(record => ({
      model: record.model,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      estimated_cost_usd: record.estimatedCostUsd,
      created_at: formatDate(record.createdAt)
    }))
  });
}));
app.get('/api/admin/stats', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const [totalUsers, totals] = await Promise.all([
    User.countDocuments(),
    UsageLog.aggregate([{
      $group: {
        _id: null,
        requests: { $sum: 1 },
        total_tokens: { $sum: { $add: ['$inputTokens', '$outputTokens'] } },
        estimated_cost_usd: { $sum: '$estimatedCostUsd' }
      }
    }, { $project: { _id: 0, requests: 1, total_tokens: 1, estimated_cost_usd: 1 } }])
  ]);
  res.json({ totalUsers, ...(totals[0] || { requests: 0, total_tokens: 0, estimated_cost_usd: 0 }) });
}));
app.get('/api/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const [users, counts] = await Promise.all([
    User.find().select('email role createdAt').sort({ createdAt: -1 }).limit(200).lean(),
    UsageLog.aggregate([{ $group: { _id: '$userId', ai_requests: { $sum: 1 } } }])
  ]);
  const countByUser = new Map(counts.map(item => [item._id.toString(), item.ai_requests]));
  res.json(users.map(user => ({
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    created_at: formatDate(user.createdAt),
    ai_requests: countByUser.get(user._id.toString()) || 0
  })));
}));
app.get('/api/admin/usage', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const records = await UsageLog.find().sort({ createdAt: -1 }).limit(100).lean();
  const users = await User.find({ _id: { $in: records.map(record => record.userId) } })
    .select('email')
    .lean();
  const emailByUser = new Map(users.map(user => [user._id.toString(), user.email]));
  res.json(records.map(record => ({
    email: emailByUser.get(record.userId.toString()),
    model: record.model,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    estimated_cost_usd: record.estimatedCostUsd,
    created_at: formatDate(record.createdAt)
  })));
}));

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
  if (error.name === 'ValidationError' || error.name === 'CastError') return sendError(res, 400, 'The submitted data is invalid.');
  sendError(res, 500, 'An unexpected server error occurred.');
});

try {
  await connectDatabase();
  await Promise.all([User.init(), Note.init(), Chat.init(), UsageLog.init()]);
  app.listen(port, () => console.log(`Study Buddy running at http://localhost:${port}${client ? '' : ' (AI demo mode; set OPENAI_API_KEY for live AI)'}`));
} catch (error) {
  console.error('Could not start the application because MongoDB is unavailable:', error);
  await mongoose.disconnect();
  process.exitCode = 1;
}

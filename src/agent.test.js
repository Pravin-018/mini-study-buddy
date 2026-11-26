import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { answerWithAgent, createStudyPlan, estimateCost } from './agent.js';
import { addNote, retrieveNotes } from './rag.js';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from './models/User.js';
import Note from './models/Note.js';

let mongo;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('demo study plan is structured and totals the requested time', async () => {
  const plan = await createStudyPlan(null, { topic: 'fractions', minutes: 30, difficulty: 'beginner' });
  assert.equal(plan.demo, true);
  assert.equal(plan.tasks.reduce((sum, task) => sum + task.minutes, 0), 30);
  assert.ok(plan.tasks.every(task => task.name && task.description));
});

test('study plan arguments are validated in demo mode', async () => {
  await assert.rejects(createStudyPlan(null, { topic: '', minutes: 2, difficulty: 'expert' }));
});

test('demo answer is clearly labelled and delivered progressively', async () => {
  const parts = [];
  const result = await answerWithAgent({ client: null, question: 'What is a variable?', notes: [], onText: part => parts.push(part) });
  assert.equal(result.demo, true);
  assert.match(result.text, /Demo response/);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), result.text);
});

test('RAG retrieves only notes owned by the requesting user', async () => {
  const firstUser = await User.create({ name: 'First', email: 'first@example.test', password: '$2b$12$first' });
  const secondUser = await User.create({ name: 'Second', email: 'second@example.test', password: '$2b$12$second' });
  await addNote(null, firstUser.id, 'Photosynthesis', 'Plants use sunlight to make food.');
  await addNote(null, secondUser.id, 'Photosynthesis private', 'Plants absorb light energy.');
  const results = await retrieveNotes(null, firstUser.id, 'How does sunlight help plants?');
  assert.deepEqual(results.map(note => note.title), ['Photosynthesis']);
});

test('RAG stores and ranks MongoDB embedding vectors', async () => {
  const user = await User.create({ name: 'Vectors', email: 'vectors@example.test', password: '$2b$12$vector' });
  const embeddings = {
    'Plants use sunlight to make food.': [1, 0],
    'How does sunlight help plants?': [0.99, 0.01]
  };
  const client = {
    embeddings: {
      create: async ({ input }) => ({ data: [{ embedding: embeddings[input] }] })
    }
  };
  const noteId = await addNote(client, user.id, 'Photosynthesis', 'Plants use sunlight to make food.');
  const note = await Note.findById(noteId).lean();
  assert.deepEqual(note.embedding, [1, 0]);
  const results = await retrieveNotes(client, user.id, 'How does sunlight help plants?');
  assert.deepEqual(results.map(result => result.id), [noteId]);
});

test('cost estimation reads token counts and returns a finite estimate', () => {
  const cost = estimateCost(1000, 500);
  assert.ok(Number.isFinite(cost));
  assert.ok(cost > 0);
});

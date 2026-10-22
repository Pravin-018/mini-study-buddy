import test from 'node:test';
import assert from 'node:assert/strict';
import { answerWithAgent, createStudyPlan, estimateCost } from './agent.js';
import { addNote, retrieveNotes } from './rag.js';
import { DatabaseSync } from 'node:sqlite';

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
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE notes (id INTEGER PRIMARY KEY,user_id INTEGER,title TEXT,content TEXT,embedding TEXT,created_at TEXT);`);
  db.prepare('INSERT INTO users (id) VALUES (1),(2)').run();
  await addNote(null, db, 1, 'Photosynthesis', 'Plants use sunlight to make food.');
  await addNote(null, db, 2, 'Photosynthesis private', 'Plants absorb light energy.');
  const results = await retrieveNotes(null, db, 1, 'How does sunlight help plants?');
  assert.deepEqual(results.map(note => note.title), ['Photosynthesis']);
  db.close();
});

test('cost estimation reads token counts and returns a finite estimate', () => {
  const cost = estimateCost(1000, 500);
  assert.ok(Number.isFinite(cost));
  assert.ok(cost > 0);
});

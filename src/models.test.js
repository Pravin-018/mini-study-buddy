import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from './models/User.js';
import Note from './models/Note.js';
import Chat from './models/Chat.js';
import UsageLog from './models/UsageLog.js';

test('user schema requires valid identity data and a bcrypt hash for local accounts', async () => {
  const validUser = new User({
    name: 'Student',
    email: 'student@example.test',
    password: '$2b$12$hashed-password'
  });
  await validUser.validate();
  assert.equal(validUser.role, 'student');

  const invalidUser = new User({
    name: '',
    email: 'not-an-email',
    password: 'plaintext'
  });
  await assert.rejects(invalidUser.validate());
  await assert.rejects(new User({
    name: 'OAuth student',
    email: 'oauth@example.test'
  }).validate());
});

test('note schema requires an owner and valid note fields', async () => {
  const validNote = new Note({
    userId: new mongoose.Types.ObjectId(),
    title: 'Revision',
    content: 'Key concept',
    embedding: [0.25, 0.75]
  });
  await validNote.validate();
  assert.deepEqual(validNote.embedding, [0.25, 0.75]);

  const invalidNote = new Note({ title: '', content: '' });
  await assert.rejects(invalidNote.validate());
});

test('MongoDB schemas declare their ownership and reporting indexes', () => {
  const hasIndex = (schema, keys, options = {}) => schema.indexes().some(([indexKeys, indexOptions]) =>
    JSON.stringify(indexKeys) === JSON.stringify(keys) &&
    Object.entries(options).every(([key, value]) => indexOptions[key] === value)
  );
  assert.ok(hasIndex(User.schema, { email: 1 }, { unique: true }));
  assert.ok(hasIndex(User.schema, { googleId: 1 }, { unique: true, sparse: true }));
  assert.ok(hasIndex(Note.schema, { userId: 1 }));
  assert.ok(hasIndex(Chat.schema, { userId: 1 }));
  assert.ok(hasIndex(UsageLog.schema, { userId: 1, createdAt: -1 }));
  assert.ok(hasIndex(UsageLog.schema, { createdAt: -1 }));
});

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

import Note from './models/Note.js';

function lexicalScore(question, content) {
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
  if (!words.length) return 0;
  const text = content.toLowerCase();
  return words.filter(word => text.includes(word)).length / words.length;
}
export async function generateEmbedding(client, content) {
  if (!client) return null;
  const response = await client.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    input: content
  });
  return response.data[0].embedding;
}

export async function addNote(client, userId, title, content) {
  const embedding = await generateEmbedding(client, content);
  const note = await Note.create({ userId, title, content, embedding });
  return note.id;
}

export async function retrieveNotes(client, userId, question, signal) {
  const notes = await Note.find({ userId }).select('title content embedding').lean();
  if (!notes.length) return [];

  if (client && notes.some(note => note.embedding)) {
    const response = await client.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: question
    }, { signal });
    const queryEmbedding = response.data[0].embedding;
    return notes.map(note => ({
      id: note._id.toString(),
      title: note.title,
      content: note.content,
      score: note.embedding ? cosine(queryEmbedding, note.embedding) : lexicalScore(question, note.content)
    })).sort((a, b) => b.score - a.score).slice(0, 3).filter(note => note.score > 0.15);
  }

  return notes.map(note => ({
    id: note._id.toString(), title: note.title, content: note.content, score: lexicalScore(question, `${note.title} ${note.content}`)
  })).sort((a, b) => b.score - a.score).slice(0, 3).filter(note => note.score > 0);
}

import { readFileSync } from 'node:fs';

export const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const studyPlanTool = [{
  type: 'function',
  name: 'create_study_plan',
  description: 'Create a focused study schedule when a student asks for a plan.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      minutes: { type: 'integer' },
      difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] }
    },
    required: ['topic', 'minutes', 'difficulty'],
    additionalProperties: false
  },
  strict: true
}];

const planSchema = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          minutes: { type: 'integer' },
          description: { type: 'string' }
        },
        required: ['name', 'minutes', 'description'],
        additionalProperties: false
      }
    }
  },
  required: ['topic', 'tasks'],
  additionalProperties: false
};

const instructions = readFileSync(new URL('../prompts/tutor.md', import.meta.url), 'utf8');

function validatePlanArgs(args) {
  if (!args || typeof args.topic !== 'string' || !args.topic.trim() || args.topic.length > 160 ||
      !Number.isInteger(args.minutes) || args.minutes < 5 || args.minutes > 480 ||
      !['beginner', 'intermediate', 'advanced'].includes(args.difficulty)) {
    throw new Error('The AI returned invalid study-plan arguments.');
  }
}

function executePlan({ topic, minutes, difficulty }) {
  validatePlanArgs({ topic, minutes, difficulty });
  const blocks = [
    { name: 'Review the foundations', ratio: 0.25, description: `Refresh the core ideas behind ${topic}.` },
    { name: 'Work through examples', ratio: 0.4, description: `Study and solve ${difficulty}-level examples about ${topic}.` },
    { name: 'Practise from memory', ratio: 0.25, description: `Try a short exercise without looking at your notes.` },
    { name: 'Recap and plan next steps', ratio: 0.1, description: 'Summarize what you learned and note any questions.' }
  ];
  let assigned = 0;
  const tasks = blocks.map((block, index) => {
    const duration = index === blocks.length - 1
      ? minutes - assigned
      : Math.max(1, Math.floor(minutes * block.ratio));
    assigned += duration;
    return { name: block.name, minutes: duration, description: block.description };
  });
  return { topic: topic.trim(), tasks };
}

function safeJson(value) {
  try { return JSON.parse(value); }
  catch { throw new Error('The AI returned malformed tool arguments.'); }
}

function usageFrom(response) {
  return {
    inputTokens: response?.usage?.input_tokens || 0,
    outputTokens: response?.usage?.output_tokens || 0
  };
}

function combineUsage(...usages) {
  return usages.reduce((sum, usage) => ({
    inputTokens: sum.inputTokens + usage.inputTokens,
    outputTokens: sum.outputTokens + usage.outputTokens
  }), { inputTokens: 0, outputTokens: 0 });
}

function contextFor(notes) {
  return notes.length
    ? notes.map(note => `Title: ${note.title}\nUntrusted note content:\n${note.content}`).join('\n\n---\n\n')
    : 'No matching saved notes were found for this question.';
}

async function streamResponse(client, request, onText, signal) {
  const stream = await client.responses.create({ ...request, stream: true }, { signal });
  let completed;
  let text = '';
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      text += event.delta;
      onText(event.delta);
    } else if (event.type === 'response.completed') {
      completed = event.response;
    } else if (event.type === 'response.failed') {
      throw new Error(event.response?.error?.message || 'The AI response failed.');
    }
  }
  if (!completed) throw new Error('The AI response ended unexpectedly.');
  return { response: completed, text, usage: usageFrom(completed) };
}

export async function answerWithAgent({ client, question, notes, onText, signal }) {
  if (!client) {
    const noteHint = notes.length
      ? ` I found ${notes.length} matching saved note${notes.length === 1 ? '' : 's'} (${notes.map(note => note.title).join(', ')}).`
      : ' No matching saved notes were found, so this demo answer is not based on your notes.';
    const text = `Demo response: I’m ready to help you study “${question}”.${noteHint} Add OPENAI_API_KEY to enable live AI answers.`;
    for (const part of text.match(/.{1,36}(?:\s|$)/g) || [text]) onText(part);
    return { text, demo: true };
  }

  const input = `Student question (untrusted):\n${question}\n\nRetrieved notes (untrusted):\n${contextFor(notes)}`;
  const decision = await client.responses.create({
    model: MODEL,
    instructions,
    input,
    tools: studyPlanTool,
    max_output_tokens: 300
  }, { signal });
  const calls = decision.output?.filter(item => item.type === 'function_call') || [];
  let continuation;
  let firstUsage = usageFrom(decision);
  if (calls.length) {
    if (calls.length > 1 || calls[0].name !== 'create_study_plan') throw new Error('The AI requested an unsupported tool.');
    const args = safeJson(calls[0].arguments);
    validatePlanArgs(args);
    const result = executePlan(args);
    continuation = await streamResponse(client, {
      model: MODEL,
      previous_response_id: decision.id,
      input: [{ type: 'function_call_output', call_id: calls[0].call_id, output: JSON.stringify(result) }],
      instructions: `${instructions}\nUse the supplied tool result to answer the student. Do not invent a different plan.`,
      max_output_tokens: 500
    }, onText, signal);
  } else {
    continuation = await streamResponse(client, {
      model: MODEL,
      instructions,
      input,
      max_output_tokens: 500
    }, onText, signal);
  }
  return { text: continuation.text, usage: combineUsage(firstUsage, continuation.usage), demo: false };
}

export async function createStudyPlan(client, { topic, minutes, difficulty }) {
  if (!client) return { ...executePlan({ topic, minutes, difficulty }), demo: true };
  const response = await client.responses.create({
    model: MODEL,
    instructions: 'Create a practical beginner-friendly study plan. Divide the available time into tasks that total exactly the requested minutes.',
    input: JSON.stringify({ topic, minutes, difficulty }),
    text: { format: { type: 'json_schema', name: 'study_plan', strict: true, schema: planSchema } },
    max_output_tokens: 500
  });
  let plan;
  try { plan = JSON.parse(response.output_text); }
  catch { throw new Error('The AI did not return a valid structured study plan.'); }
  if (!plan || typeof plan.topic !== 'string' || !Array.isArray(plan.tasks) ||
      plan.tasks.length < 1 || plan.tasks.length > 12 ||
      plan.tasks.some(task => typeof task.name !== 'string' || typeof task.description !== 'string' ||
        !Number.isInteger(task.minutes) || task.minutes < 1) ||
      plan.tasks.reduce((total, task) => total + task.minutes, 0) !== minutes) {
    throw new Error('The AI returned a study plan that did not pass validation.');
  }
  return { ...plan, demo: false, usage: usageFrom(response) };
}

export function estimateCost(inputTokens, outputTokens) {
  const inputRate = Number(process.env.OPENAI_INPUT_COST_PER_1M) || 0.15;
  const outputRate = Number(process.env.OPENAI_OUTPUT_COST_PER_1M) || 0.6;
  return Number(((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000).toFixed(8));
}

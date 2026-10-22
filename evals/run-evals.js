import 'dotenv/config';
import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';

if (!process.env.OPENAI_API_KEY) {
  console.error('Evaluation requires OPENAI_API_KEY. Configure it in .env and run npm run eval again.');
  process.exitCode = 1;
} else {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });
  const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
  let passed = 0;
  for (const test of cases) {
    try {
      const result = await client.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        instructions: 'You are a beginner-friendly study tutor. Keep answers short and clear.',
        input: test.question,
        max_output_tokens: 150
      });
      const answer = (result.output_text || '').toLowerCase();
      const hits = test.expected_keywords.filter(keyword => answer.includes(keyword.toLowerCase()));
      const ok = hits.length >= Math.min(2, test.expected_keywords.length);
      if (ok) passed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}: ${test.question}\n  Keywords found: ${hits.join(', ') || 'none'}\n`);
    } catch (error) {
      console.error(`ERROR: ${test.question}\n  ${error.message}\n`);
      process.exitCode = 1;
    }
  }
  console.log(`Keyword evaluation: ${passed}/${cases.length} passed.`);
  console.log('This keyword check is only a basic starting point, not a complete measure of answer quality.');
  if (passed !== cases.length) process.exitCode = 1;
}

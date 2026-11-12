/** 11 — redaction filter evidence (direct call of the exact function the endpoints use). */
import { redactText, compilePatterns } from '../../perception.mjs';

const sample = [
  'Card 4111111111111111 ends ok',
  'Card 4111 1111 1111 1111 spaced',
  'key sk-live-abcdef1234567890 leaked',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x',
  'https://ex.test/login?password=hunter2&ok=1',
  'clean line stays untouched',
].join('\n');

const patterns = compilePatterns();
const { text, count } = redactText(sample, patterns);
console.log('patterns:', patterns.map((p) => `/${p.source}/${p.flags}`).join('  '));
console.log(`redaction hits: ${count}`);
console.log('--- redacted text ---');
console.log(text);
console.log('---------------------');

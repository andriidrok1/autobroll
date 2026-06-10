// Milestone 3: детекция акцентов через Gemini (вместо ручной разметки).
// transcript.json → Gemini (правила сдержанности) → public/accents.json
import fs from 'node:fs';
import {gemini} from './gemini.mjs';

const words = JSON.parse(fs.readFileSync('public/transcript.json', 'utf8'));
const indexed = words.map((w, i) => `${i}:${w.word}`).join(' ');

const PROMPT = `You are a senior short-form video editor. Below is a transcript of a talking-head video, each word prefixed with its index.

Your job: pick which words deserve an ACCENT (gold color highlight) in the captions — exactly like a human editor would.

Editor rules (follow strictly):
- Be VERY sparing: accent 5-12% of words maximum. Restraint is what makes captions look human-made.
- Accent only MEANING words: bold claims, numbers, key product features, emotional peaks, the punchline of a sentence, calls to action, brand/product names.
- NEVER accent: articles, prepositions, filler words, pronouns, auxiliary verbs.
- Prefer 1 accent per sentence, maximum 2 for long sentences. Some sentences should have zero.
- A short phrase of 2 adjacent words can both be accented if they form one concept (e.g. "open source").

Transcript:
${indexed}

Return the accents as JSON.`;

const schema = {
  type: 'OBJECT',
  properties: {
    accents: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: {type: 'INTEGER', description: 'word index from the transcript'},
          word: {type: 'STRING', description: 'the word itself, for verification'},
          reason: {type: 'STRING', description: 'short reason: claim/number/feature/cta/brand/emotion'},
        },
        required: ['index', 'word', 'reason'],
      },
    },
  },
  required: ['accents'],
};

const result = await gemini([{text: PROMPT}], schema);

// верификация: индекс должен указывать на то самое слово (защита от сдвига)
const valid = result.accents.filter((a) => {
  const ok = words[a.index] && words[a.index].word.toLowerCase().replace(/[^a-zа-я0-9%$]/gi, '') === a.word.toLowerCase().replace(/[^a-zа-я0-9%$]/gi, '');
  if (!ok) console.warn(`  SKIP mismatch: index ${a.index} is "${words[a.index]?.word}", Gemini said "${a.word}"`);
  return ok;
});

const indices = valid.map((a) => a.index);
fs.writeFileSync('public/accents.json', JSON.stringify(indices));

console.log(`DONE → public/accents.json`);
console.log(`accents: ${indices.length}/${words.length} words (${(indices.length / words.length * 100).toFixed(1)}%)`);
valid.forEach((a) => console.log(`  ${a.index}: "${a.word}" — ${a.reason}`));

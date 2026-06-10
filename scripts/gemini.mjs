// Общий тонкий клиент Gemini API (REST, без SDK).
// Читает ключ из .env. Поддерживает текст + изображения, structured output.
import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const p = path.join(process.cwd(), '.env');
  if (!process.env.GEMINI_API_KEY && fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  }
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not found (.env)');
  return process.env.GEMINI_API_KEY;
}

const MODEL = 'gemini-2.5-flash';

/**
 * parts: массив из {text} и/или {imagePath}
 * schema: JSON schema для structured output (Gemini-формат, UPPERCASE types)
 */
export async function gemini(parts, schema) {
  const key = loadEnv();
  const contents = [{
    parts: parts.map((p) => {
      if (p.text) return {text: p.text};
      if (p.imagePath) {
        return {
          inlineData: {
            mimeType: 'image/jpeg',
            data: fs.readFileSync(p.imagePath).toString('base64'),
          },
        };
      }
      throw new Error('bad part');
    }),
  }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0.2,
        },
      }),
    },
  );

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini: empty response: ' + JSON.stringify(data).slice(0, 300));
  return JSON.parse(text);
}

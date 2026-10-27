// Google Gemini API, called straight from the phone. The key never leaves this device
// except in requests to Google.
import { setting } from './db.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

const PERSONA = `Ikaw si "Kain Coach", a friendly Filipino nutrition buddy inside a personal meal log app.
Always reply in natural, casual Taglish (mix of Tagalog and English, the way Filipinos text).
The user's goal is to eat more balanced, not to diet strictly. Be warm, practical, and specific.
Use the Pinggang Pinoy guide (half plate Glow = gulay at prutas, quarter Go = kanin/carbs, quarter Grow = ulam na protina) as your main reference.
Suggest affordable, easy-to-find Filipino foods and simple swaps (e.g. brown rice o half rice, inihaw instead of prito, tubig instead of softdrinks, add gulay like kangkong, pechay, sitaw, malunggay).
Portions are rough because the user has no food scale, so treat calories as estimates and never shame. You are not a doctor; for medical conditions, suggest consulting a professional.`;

export class AIError extends Error {}

async function config() {
  const key = (await setting('apiKey')) || '';
  const model = (await setting('model')) || DEFAULT_MODEL;
  if (!key) throw new AIError('No API key yet. Add your free Gemini key in Settings.');
  return { key, model };
}

async function request(path, key, body) {
  if (!navigator.onLine) throw new AIError('Offline ka ngayon. Saved na ang meal; i-estimate natin pag may internet na.');
  let res;
  try {
    res = await fetch(`${API}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': key, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new AIError('Could not reach Gemini. Check your internet connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    if (res.status === 429) throw new AIError('Naabot na ang free limit for now. Try again in a bit (or bukas). ' + msg);
    if (res.status === 400 && /API key/i.test(msg)) throw new AIError('Mukhang mali ang API key. Check it in Settings.');
    if (res.status === 404) throw new AIError('Model not found. Pick another model in Settings. ' + msg);
    throw new AIError(`Gemini error (${res.status}): ${msg}`);
  }
  return data;
}

async function generate({ system, contents, schema, temperature = 0.6 }) {
  const { key, model } = await config();
  const generationConfig = { temperature };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }
  const data = await request(`models/${encodeURIComponent(model)}:generateContent`, key, {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig,
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join('');
  if (!text) {
    const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty reply';
    throw new AIError(`Walang sagot ang AI (${reason}). Try again.`);
  }
  return text;
}

const ESTIMATE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    description: { type: 'STRING', description: 'Short clean name of the whole meal, e.g. "Tapsilog with coffee"' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, portion: { type: 'STRING' } },
        required: ['name', 'portion'],
      },
    },
    calories: { type: 'INTEGER', description: 'Rough total kcal estimate' },
    plate: {
      type: 'OBJECT',
      description: 'Share of the meal by volume, Pinggang Pinoy groups, summing to 100',
      properties: { go: { type: 'INTEGER' }, grow: { type: 'INTEGER' }, glow: { type: 'INTEGER' } },
      required: ['go', 'grow', 'glow'],
    },
    hasVeg: { type: 'BOOLEAN' },
    hasFruit: { type: 'BOOLEAN' },
    hasProtein: { type: 'BOOLEAN' },
    fried: { type: 'BOOLEAN', description: 'Main dish is deep fried or very oily' },
    sweet: { type: 'BOOLEAN', description: 'Includes desserts, pastries, kakanin or sweets' },
    sugaryDrink: { type: 'BOOLEAN', description: 'Softdrinks, juice drinks, milk tea, 3-in-1 or sweetened coffee' },
    processed: { type: 'BOOLEAN', description: 'Processed or salty meat/food: hotdog, longganisa, tocino, spam, corned beef, instant noodles, chichirya' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    tip: { type: 'STRING', description: 'One short Taglish tip about this meal, max 20 words' },
  },
  required: ['description', 'items', 'calories', 'plate', 'hasVeg', 'hasFruit', 'hasProtein',
    'fried', 'sweet', 'sugaryDrink', 'processed', 'confidence', 'tip'],
};

// Estimates food groups and calories from a text description and/or a photo.
export async function estimateMeal({ text, size, portion, mealType, photo }) {
  const prompt = `Estimate this ${mealType} for my meal log.
Description: ${text || '(none, see photo)'}
Portion size: ${size || 'regular'}${portion ? `; details: ${portion}` : ''}
Assume typical Filipino servings when unsure. If there is a photo, identify the foods in it.
If the description is empty and there is no food visible, return calories 0 and confidence "low".`;
  const parts = [{ text: prompt }];
  if (photo) parts.push({ inlineData: { mimeType: 'image/jpeg', data: photo.split(',')[1] } });
  const json = await generate({
    system: PERSONA + '\nYou estimate nutrition for meal log entries. Be realistic, not optimistic.',
    contents: [{ role: 'user', parts }],
    schema: ESTIMATE_SCHEMA,
    temperature: 0.2,
  });
  try {
    return JSON.parse(json);
  } catch {
    throw new AIError('The AI reply could not be read. Try again.');
  }
}

export function profileText(p) {
  if (!p) return 'No profile given.';
  const bits = [
    p.age && `${p.age} years old`,
    p.sex && p.sex,
    p.height && `${p.height} cm`,
    p.weight && `${p.weight} kg`,
    p.activity && `activity: ${p.activity}`,
    p.notes && `notes: ${p.notes}`,
  ].filter(Boolean);
  return bits.length ? bits.join(', ') : 'No profile given.';
}

export async function weeklyReview({ profile, stats, mealLines }) {
  const prompt = `Gawan mo ako ng weekly review ng kinain ko.

My profile: ${profileText(profile)}
Rough daily calorie need: ${stats.target ? stats.target + ' kcal' : 'unknown'}

Week stats (computed by the app):
${JSON.stringify(stats, null, 1)}

Meal log for the week:
${mealLines || '(no meals logged)'}

Format (use short markdown, Taglish):
## Overall
2-3 sentences, honest but encouraging.
## Mga nagawa mong tama
2-3 bullets.
## Pwedeng i-improve
2-3 bullets, each with a concrete Filipino-friendly swap or idea.
## Challenge for next week
One small, specific goal.
Keep it under 250 words.`;
  return generate({ system: PERSONA, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
}

// history: [{ role: 'user' | 'model', text }]
export async function chat({ profile, context, history }) {
  const system = `${PERSONA}
Answer the user's questions using their meal log below. Keep answers short (under 150 words) unless they ask for more.
Today is ${new Date().toDateString()}.
User profile: ${profileText(profile)}
Recent meal log (last 14 days):
${context || '(no meals logged yet)'}`;
  const contents = history.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  return generate({ system, contents, temperature: 0.7 });
}

// Models this key can use for text generation, flash models first.
export async function listModels(key) {
  const data = await request('models?pageSize=200', key);
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => n.startsWith('gemini') && !/embed|image|tts|audio|live|veo|imagen|robotics|computer/i.test(n))
    .sort((a, b) => (b.includes('flash') - a.includes('flash')) || b.localeCompare(a));
}

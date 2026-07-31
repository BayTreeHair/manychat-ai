import { OpenRouter } from '@openrouter/sdk';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';

const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 10_000;
const AI_MAX_ATTEMPTS = Number(process.env.AI_MAX_ATTEMPTS) || 2;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Set DEBUG_CLASSIFY=1 to log each message and the model's raw reply.
const DEBUG_CLASSIFY = process.env.DEBUG_CLASSIFY === '1';

export const channels = ['ig', 'wp'];

// ---------------------------------------------------------------------------
// Singletons. Serverless reuses the module across warm invocations, so these
// survive between requests on the same instance and are rebuilt on cold start.
// ---------------------------------------------------------------------------
const globals = globalThis;

const prisma =
  globals.__prisma ??
  (globals.__prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL || '',
    }),
  }));

const ai =
  globals.__openrouter ??
  (globals.__openrouter = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY || '',
  }));

// "channel:type" → flowId | null
const flowCache = (globals.__flowCache ??= new Map());
const cache = (globals.__cache ??= { messages: null, prompt: null, promise: null });

// ---------------------------------------------------------------------------
// ManyChat
// ---------------------------------------------------------------------------
async function sendFlow(subscriber, flowId) {
  const response = await fetch('https://api.manychat.com/fb/sending/sendFlow', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MANYCHAT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subscriber_id: subscriber, flow_ns: flowId }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ManyChat sendFlow failed: ${response.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Flow lookup
// ---------------------------------------------------------------------------
async function findFlowByChannelAndType(channel, type) {
  const cacheKey = `${channel}:${type}`;

  if (flowCache.has(cacheKey)) {
    return flowCache.get(cacheKey) ?? null;
  }

  const flow = await prisma.messageFlow.findFirst({
    where: {
      channel,
      message: { type },
    },
    select: { flowId: true },
  });

  const flowId = flow?.flowId ?? null;
  flowCache.set(cacheKey, flowId);
  return flowId;
}

// ---------------------------------------------------------------------------
// Prompt built once per instance from the Message table
// ---------------------------------------------------------------------------
async function loadPrompt() {
  const dbMessages = await prisma.message.findMany({
    select: { content: true, type: true },
  });

  if (!dbMessages.length) {
    cache.promise = null; // let the next invocation retry
    throw new Error('No classification messages found in the database.');
  }

  let categories = `0: Does not clearly match any category\n`;
  for (const message of dbMessages) {
    categories += `${message.type ?? 0}: ${message.content}\n`;
  }

  // Customers write Egyptian Arabic, often in Franco-Arabic (Latin letters plus
  // digits standing in for Arabic letters). Without the transliteration key the
  // model classifies the Franco spelling of a message differently from the same
  // message in Arabic script.
  cache.prompt = `You classify incoming customer messages for a hair-extension business into exactly one category.

The customer writes in Egyptian Arabic. The message may be in Arabic script, in Franco-Arabic/Arabizi (Arabic typed with Latin letters and digits), or a mix of Arabic and English. In Franco-Arabic, digits stand for Arabic letters: 2=ء, 3=ع, 5=خ, 6=ط, 7=ح, 8=غ, 9=ق. Read Franco-Arabic as fluently as Arabic script — "momken asbgho?" means "ممكن اصبغه؟". Never let the writing system change which category you pick.

Categories:
${categories}
Rules:
- Answer with the category number only. No words, no punctuation, no explanation.
- Use Western digits (0-9).
- If the message raises several topics, pick the category for the customer's main question. A passing mention of price or stock does not by itself force 0 when another category clearly fits.
- If two categories overlap, pick the more specific one.
- Use 0 only when no category genuinely fits, or the message is a greeting, a price question, or a stock question.`;

  return cache.prompt;
}

function ensurePrompt() {
  if (cache.prompt) return Promise.resolve(cache.prompt);
  if (!cache.promise) cache.promise = loadPrompt();
  return cache.promise;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAIBusyError(error) {
  const message = String(error?.message || error?.statusText || '').toLowerCase();

  return (
    message.includes('busy') ||
    message.includes('server busy') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('503') ||
    message.includes('429') ||
    message.includes('timeout')
  );
}

// Both providers take the same system prompt and customer message and return
// the model's raw reply as a string. The customer message goes in the user
// turn, never concatenated into the system prompt, so instructions stay
// separable from customer text.
async function callGemini(system, message) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GOOGLE_API_KEY || '',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2000 },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    }
  );

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${body?.error?.message ?? 'unknown error'}`);
  }

  return body.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') ?? '';
}

async function callOpenRouter(system, message) {
  const result = await ai.chat.send(
    {
      chatRequest: {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: message },
        ],
        temperature: 0,
        model: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b',
      },
    },
    { timeoutMs: AI_TIMEOUT_MS }
  );

  return result?.choices?.[0]?.message?.content ?? '';
}

async function classify(message) {
  const system = await ensurePrompt();

  for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callGemini(system, message);
    } catch (error) {
      if (attempt < AI_MAX_ATTEMPTS && isAIBusyError(error)) {
        console.warn(`Gemini busy on attempt ${attempt}, retrying in 2s...`, error?.message || error);
        await sleep(2000);
        continue;
      }

      // Gemini's free tier has per-minute and per-day caps. Rather than drop
      // the customer's message when it runs out, fall back to OpenRouter.
      if (process.env.OPENROUTER_API_KEY) {
        console.warn('Gemini failed, falling back to OpenRouter:', error?.message || error);
        return await callOpenRouter(system, message);
      }

      throw error;
    }
  }
}

function parseClassificationType(text) {
  // Normalise Arabic-Indic digits, then take the first number anywhere in the
  // reply — anchoring to the start turned any prefixed word into a silent 0.
  const normalised = String(text)
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

  const typeMatch = normalised.match(/[0-9]+/);
  if (!typeMatch) {
    console.warn('Could not parse a category from model reply:', normalised.slice(0, 120));
    return 0;
  }
  return Number(typeMatch[0]);
}

// ---------------------------------------------------------------------------
// Full pipeline for one message
// ---------------------------------------------------------------------------
export async function processSend(channel, subscriber, message) {
  const reply = await classify(message);
  const type = parseClassificationType(reply);

  if (DEBUG_CLASSIFY) {
    // JSON.stringify escapes non-ASCII, so mangled UTF-8 is visible here as
    // Ù... instead of readable Arabic. Compare against codePoints:
    // intact Arabic sits in U+0600-U+06FF.
    console.log(
      'classify:',
      JSON.stringify({
        message,
        length: message.length,
        firstCodePoints: [...message].slice(0, 8).map((c) => c.codePointAt(0).toString(16)),
        reply: String(reply).slice(0, 40),
        type,
      })
    );
  }

  const flowId = await findFlowByChannelAndType(channel, type);

  if (!flowId) {
    console.warn('No linked flow found for channel/type', channel, type);
    return { type, flowId: null, sent: false };
  }

  await sendFlow(subscriber, flowId);
  return { type, flowId, sent: true };
}

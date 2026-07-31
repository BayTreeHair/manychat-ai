import { OpenRouter } from '@openrouter/sdk';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 10_000;
const AI_MAX_ATTEMPTS = Number(process.env.AI_MAX_ATTEMPTS) || 2;

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

  let prompt = `Classify the message into one of the following types. If none match, respond with 0. Respond with only the number.\n\n`;
  prompt += `0: Does not clearly match any category\n`;
  for (const message of dbMessages) {
    prompt += `${message.type ?? 0}: ${message.content}\n`;
  }

  cache.prompt = prompt;
  return prompt;
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

async function classify(message) {
  const prefix = await ensurePrompt();
  const prompt = prefix + `\nMessage: "${message.replace(/"/g, '\\"')}"\nOutput:`;

  const send = () =>
    ai.chat.send(
      {
        chatRequest: {
          messages: [{ role: 'system', content: prompt }],
          model: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b',
        },
      },
      { timeoutMs: AI_TIMEOUT_MS }
    );

  for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt < AI_MAX_ATTEMPTS && isAIBusyError(error)) {
        console.warn(`AI is busy on attempt ${attempt}, retrying in 2s...`, error?.message || error);
        await sleep(2000);
        continue;
      }
      throw error;
    }
  }
}

function parseClassificationType(response) {
  const text = response?.choices?.[0]?.message?.content || '';
  const typeMatch = String(text).trim().match(/^[0-9]+/);
  return typeMatch ? Number(typeMatch[0]) : 0;
}

// ---------------------------------------------------------------------------
// Full pipeline for one message
// ---------------------------------------------------------------------------
export async function processSend(channel, subscriber, message) {
  const response = await classify(message);
  const type = parseClassificationType(response);
  const flowId = await findFlowByChannelAndType(channel, type);

  if (!flowId) {
    console.warn('No linked flow found for channel/type', channel, type);
    return { type, flowId: null, sent: false };
  }

  await sendFlow(subscriber, flowId);
  return { type, flowId, sent: true };
}

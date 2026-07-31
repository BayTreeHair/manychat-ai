"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const axios_1 = __importDefault(require("axios"));
const pg_boss_1 = require("pg-boss");
const sdk_1 = require("@openrouter/sdk");
dotenv_1.default.config();
const boss = new pg_boss_1.PgBoss(process.env.DATABASE_URL);
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '16kb' }));
const isServerless = process.env.VERCEL === '1';
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 10000;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 10;
const ai = new sdk_1.OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY || '',
});
const { PrismaClient } = require('../generated/prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({
    adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL || '',
    }),
});
const manychat = axios_1.default.create({
    baseURL: 'https://api.manychat.com',
    headers: {
        Authorization: `Bearer ${MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json',
    },
});
const channels = ['ig', 'wp'];
// ---------------------------------------------------------------------------
// Flow lookup cache: "channel:type" → flowId | null
// ---------------------------------------------------------------------------
const flowCache = new Map();
async function sendFlow(subscriber, flowId) {
    try {
        await manychat.post('/fb/sending/sendFlow', {
            subscriber_id: subscriber,
            flow_ns: flowId,
        });
    }
    catch (error) {
        console.error('Error sending ManyChat flow:', error);
        throw error;
    }
}
// ---------------------------------------------------------------------------
// Message / prompt cache
// ---------------------------------------------------------------------------
let messages = {};
let cachedPrompt = null;
async function loadMessagesFromDb() {
    const dbMessages = await prisma.message.findMany({
        select: { content: true, type: true },
    });
    messages = Object.fromEntries(dbMessages.map((message) => [message.content, message.type ?? 0]));
    if (!Object.keys(messages).length) {
        console.warn('No classification messages found in the database.');
    }
}
let messagesPromise = null;
async function ensureMessagesLoaded() {
    if (!messagesPromise)
        messagesPromise = loadMessagesFromDb();
    return messagesPromise;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isAIBusyError(error) {
    const message = String(error?.response?.data?.message || error?.message || error?.response?.statusText || '').toLowerCase();
    return (message.includes('busy') ||
        message.includes('server busy') ||
        message.includes('rate limit') ||
        message.includes('too many requests') ||
        message.includes('503') ||
        message.includes('429') ||
        message.includes('timeout'));
}
async function generateWithTimeout(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
        const response = await Promise.race([
            ai.chat.send({
                chatRequest: {
                    messages: [{ role: "system", content: prompt }],
                    model: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free',
                }
            }),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(`AI call timed out after ${AI_TIMEOUT_MS}ms`)))),
        ]);
        return response;
    }
    finally {
        clearTimeout(timer);
    }
}
async function classify(message) {
    await ensureMessagesLoaded();
    if (!Object.keys(messages).length) {
        throw new Error('No classification messages loaded from Prisma.');
    }
    // Build prompt prefix once and cache it
    if (!cachedPrompt) {
        let prefix = `Classify the message into one of the following types. If none match, respond with 0. Respond with only the number.\n\n`;
        prefix += `0: Does not clearly match any category\n`;
        for (const [text, num] of Object.entries(messages)) {
            prefix += `${num}: ${text}\n`;
        }
        cachedPrompt = prefix;
    }
    const prompt = cachedPrompt + `\nMessage: "${message.replace(/"/g, '\\"')}"\nOutput:`;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await generateWithTimeout(prompt);
        }
        catch (error) {
            if (attempt < maxAttempts && isAIBusyError(error)) {
                console.warn(`AI is busy on attempt ${attempt}, retrying in 2s...`, error?.message || error);
                await sleep(2000);
                continue;
            }
            console.error('Error classifying message:', error);
            throw error;
        }
    }
    throw new Error('AI classification failed after retries.');
}
function parseClassificationType(response) {
    const text = response?.choices[0]?.message.content || '';
    const typeMatch = String(text).trim().match(/^[0-9]+/);
    return typeMatch ? Number(typeMatch[0]) : 0;
}
// ---------------------------------------------------------------------------
// Flow lookup with in-memory cache
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
// Background processor with concurrency guard
// ---------------------------------------------------------------------------
async function processSendBackground(channel, subscriber, message) {
    const response = await classify(message);
    const type = parseClassificationType(response);
    const flowId = await findFlowByChannelAndType(channel, type);
    console.log(type, flowId);
    if (!flowId) {
        console.warn('No linked flow found for channel/type', channel, type);
        return;
    }
    await sendFlow(subscriber, flowId);
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/send', async (req, res) => {
    const { channel, subscriberId, message } = req.body || {};
    if (!channel || typeof channel !== 'string' || !channels.includes(channel)) {
        return res.status(400).json({ error: 'JSON body must include a valid "channel".' });
    }
    if (!subscriberId || (typeof subscriberId !== 'number' && typeof subscriberId !== 'string')) {
        return res.status(400).json({ error: 'JSON body must include a valid "subscriberId".' });
    }
    const subscriber = Number(subscriberId);
    if (Number.isNaN(subscriber)) {
        return res.status(400).json({ error: 'subscriberId must be a number or numeric string.' });
    }
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'JSON body must include a valid "message" string.' });
    }
    if (isServerless) {
        await processSendBackground(channel, subscriber, message);
        return res.status(202).json({ status: 'accepted', channel, subscriberId: subscriber });
    }
    try {
        await boss.send('classify-message', { channel, subscriberId: subscriber, message });
    }
    catch (err) {
        console.error('Failed to enqueue job:', err);
        return res.status(500).json({ error: 'Failed to enqueue job.' });
    }
    return res.status(202).json({ status: 'accepted', channel, subscriberId: subscriber });
});
app.get('/', (_req, res) => {
    res.send('');
});
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});
const port = process.env.PORT || 3000;
async function startBackgroundWorker() {
    await boss.start();
    console.log('PgBoss started, connecting to database and starting server...');
    await boss.createQueue('classify-message');
    boss.work('classify-message', { batchSize: MAX_CONCURRENT_JOBS }, async (jobs) => {
        await Promise.allSettled(jobs.map(async (job) => {
            const { channel, subscriberId, message } = job.data;
            await processSendBackground(channel, Number(subscriberId), message);
        }));
    });
    const server = app.listen(port, () => {
        console.log(`Server listening on http://localhost:${port}`);
    });
    process.on('SIGTERM', async () => {
        await boss.stop();
        server.close(async () => {
            await prisma.$disconnect();
            process.exit(0);
        });
    });
}
if (!isServerless) {
    startBackgroundWorker().catch((error) => {
        console.error('Failed to start PgBoss:', error);
        process.exit(1);
    });
}
exports.default = app;

import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-mini';
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;


const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});
const { PrismaClient }: { PrismaClient: new (options: any) => any } = require('./generated/prisma/client');
const { PrismaPg }: { PrismaPg: new (options: { connectionString: string }) => any } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL || '',
  }),
});
const manychat = axios.create({
    baseURL: 'https://manychat.com',
    headers: {
        'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

const channels = ['ig', 'wp'];

let messages: Record<string, number> = {};
let messagesLoaded = false;

async function loadMessagesFromDb() {
  const dbMessages: Array<{ content: string; type: number | null }> = await prisma.message.findMany({
    select: {
      content: true,
      type: true,
    },
  });

  messages = Object.fromEntries(
    dbMessages.map((message): [string, number] => [message.content, message.type ?? 0])
  );
  messagesLoaded = true;

  if (!Object.keys(messages).length) {
    console.warn('No classification messages found in the database.');
  }
}

async function ensureMessagesLoaded() {
  if (!messagesLoaded) {
    await loadMessagesFromDb();
  }
}

if (!GEMINI_API_KEY) {
  console.warn('Warning: GOOGLE_API_KEY or GEMINI_API_KEY is not set. Gemini requests will fail until it is configured.');
}

async function sendFlow(subscriber: number, flowId: string) {
    try {
        await manychat.post('/fb/sending/sendFlow', {
            subscriber_id: subscriber,
            flow_ns: flowId
        });
    } catch (error) {
        console.error('Error sending ManyChat flow:', error);
    }
}

async function classify(message: string) {
    await ensureMessagesLoaded();

    if (!Object.keys(messages).length) {
      throw new Error('No classification messages loaded from Prisma.');
    }
    const numbers = Object.values(messages).join(', ');
    let prompt = `Classify the message into one of the following types. Respond with only the number ${numbers}.\n\n`;
    
    for (const [text, num] of Object.entries(messages)) {
        prompt += `${num}: ${text}\n`;
    }
    prompt += `\nMessage: "${message.replace(/"/g, '\\"')}"\nOutput:`;

    try {
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: {
                responseMimeType: 'text/plain',
            }
        });
        return response;
    } catch (error) {
        console.error('Error classifying message:', error);
        throw error;
    }
}

function parseClassificationType(response: any) {
  const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const typeMatch = String(text).trim().match(/^[0-9]+/);
  return typeMatch ? Number(typeMatch[0]) : 0;
}

async function findFlowByChannelAndType(channel: string, type: number) {
  const flow = await prisma.messageFlow.findFirst({
    where: {
      channel,
      message: {
        type,
      },
    },
    select: {
      flowId: true,
    },
  });
  return flow?.flowId ?? null;
}

async function processSendBackground(channel: string, subscriber: number, message: string) {
  try {
    const response = await classify(message);
    const type = parseClassificationType(response);
    const flowId = await findFlowByChannelAndType(channel, type);

    if (!flowId) {
      console.warn('Background send: no linked flow found for channel/type', channel, type);
      return;
    }

    await sendFlow(subscriber, flowId);
  } catch (error: any) {
    console.error('Background send failed:', error);
  }
}

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

  setImmediate(() => {
    void processSendBackground(channel, subscriber, message);
  });

  return res.status(202).json({ status: 'accepted', channel, subscriberId: subscriber });
});

app.get('/', (req, res) => {
  res.send('Baytree AI Gemini classifier is running. POST /classify with { message }.');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

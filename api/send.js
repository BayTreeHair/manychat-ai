import { channels, processSend } from '../src/lib.js';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Body must be valid JSON.' }, { status: 400 });
  }

  const { channel, subscriberId, message } = body || {};

  if (!channel || typeof channel !== 'string' || !channels.includes(channel)) {
    return Response.json({ error: 'JSON body must include a valid "channel".' }, { status: 400 });
  }

  if (!subscriberId || (typeof subscriberId !== 'number' && typeof subscriberId !== 'string')) {
    return Response.json({ error: 'JSON body must include a valid "subscriberId".' }, { status: 400 });
  }

  const subscriber = Number(subscriberId);
  if (Number.isNaN(subscriber)) {
    return Response.json({ error: 'subscriberId must be a number or numeric string.' }, { status: 400 });
  }

  if (!message || typeof message !== 'string') {
    return Response.json({ error: 'JSON body must include a valid "message" string.' }, { status: 400 });
  }

  try {
    const result = await processSend(channel, subscriber, message);
    return Response.json({ status: 'ok', channel, subscriberId: subscriber, ...result });
  } catch (error) {
    console.error('Failed to process message:', error);
    return Response.json({ error: 'Failed to process message.' }, { status: 500 });
  }
}

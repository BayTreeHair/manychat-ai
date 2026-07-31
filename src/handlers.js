import { channels, processSend } from './lib.js';

export function getRoot(_req, res) {
  res.send('');
}

export function getHealth(_req, res) {
  res.json({ status: 'ok', uptime: process.uptime() });
}

export async function postSend(req, res) {
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

  try {
    const result = await processSend(channel, subscriber, message);
    return res.json({ status: 'ok', channel, subscriberId: subscriber, ...result });
  } catch (error) {
    console.error('Failed to process message:', error);
    return res.status(500).json({ error: 'Failed to process message.' });
  }
}

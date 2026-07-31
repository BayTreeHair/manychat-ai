// Local-only server. On Vercel the files in api/ are the entrypoints; this just
// mounts the same handlers under Bun so `bun dev` mirrors the deployed routes.
import { GET as getRoot } from '../api/index.js';
import { GET as getHealth } from '../api/health.js';
import { POST as postSend } from '../api/send.js';

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  routes: {
    '/': { GET: getRoot },
    '/health': { GET: getHealth },
    '/api/health': { GET: getHealth },
    '/send': { POST: postSend },
    '/api/send': { POST: postSend },
  },
  fetch: () => new Response('Not Found', { status: 404 }),
});

console.log(`Dev server listening on ${server.url}`);

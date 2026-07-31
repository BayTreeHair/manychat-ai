// Entrypoint for both local `bun dev` and Vercel's Bun runtime, which looks for
// index.js at the project root and expects it to start a server.
import { getRoot, getHealth, postSend } from './src/handlers.js';

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  routes: {
    '/': { GET: getRoot },
    '/health': { GET: getHealth },
    '/send': { POST: postSend },
  },
  fetch: () => new Response('Not Found', { status: 404 }),
});

console.log(`Server listening on ${server.url}`);

// Entrypoint for both local `bun dev` and Vercel's Bun runtime. Vercel detects
// the runtime by statically finding an express import in this file, so the
// import and the app must live here.
import express from 'express';
import { getRoot, getHealth, postSend } from './src/handlers.js';

const app = express();
app.use(express.json({ limit: '16kb' }));

app.get('/', getRoot);
app.get('/health', getHealth);
app.post('/send', postSend);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

export default app;

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import productsRouter from './routes/products.js';
import packingRouter from './routes/packing.js';
import receivingRouter from './routes/receiving.js';
import { getDb } from './database.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Routes
app.use('/api/products', productsRouter);
app.use('/api/packing', packingRouter);
app.use('/api/receiving', receivingRouter);

// Shortcuts
app.post('/api/sync', (req, res) => {
  req.url = '/sync';
  productsRouter.handle(req, res);
});

app.get('/api/sync/status', (req, res) => {
  req.url = '/sync/status';
  productsRouter.handle(req, res);
});

// Logs
app.get('/api/logs', async (req, res) => {
  try {
    const db = await getDb();
    const logs = db.prepare(`SELECT * FROM action_logs ORDER BY created_at DESC LIMIT 100`).all();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Image proxy for MoySklad images
app.get('/api/image-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'URL required' });
    }

    const token = process.env.MOYSKLAD_TOKEN;
    if (!token) {
      return res.status(500).json({ error: 'Token not configured' });
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch image' });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h
    
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Image proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Warehouse API</title>
      <style>
        body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
        h1 { color: #0070c7; }
        a { color: #0070c7; }
      </style>
    </head>
    <body>
      <h1>📦 Warehouse API v2.0</h1>
      <p>Backend работает! Откройте фронтенд:</p>
      <p><a href="http://localhost:5173">http://localhost:5173</a></p>
    </body>
    </html>
  `);
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

// Start
async function start() {
  await getDb();
  console.log('Database initialized');
  
  app.listen(PORT, () => {
    console.log(`\n📦 Warehouse API running at http://localhost:${PORT}\n`);
  });
}

start().catch(console.error);

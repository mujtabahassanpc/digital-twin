import express from 'express';
import cors from 'cors';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { webhookRouter } from './webhook.js';
import { initDatabase } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (dashboard)
app.use(express.static(path.join(rootDir, 'public')));

// API routes
app.use('/api', webhookRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      whatsapp: config.isWhatsAppReady(),
      ai: config.isAiReady(),
      database: config.isDbReady(),
      telegram: config.isTelegramReady(),
    },
    busyMode: config.busyMode,
  });
});

// Catch-all for SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'index.html'));
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Vercel serverless export
export default app;

// Start server if running directly (not via Vercel)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  async function start() {
    try {
      await initDatabase();
      app.listen(config.port, () => {
        console.log(`\n🤖 Mahir Abher (Mujtaba ka Bhai) running on http://localhost:${config.port}`);
        console.log(`   WhatsApp: ${config.isWhatsAppReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   AI (Gemini): ${config.isAiReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Database (Neon): ${config.isDbReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Telegram: ${config.isTelegramReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Busy Mode: ${config.busyMode ? 'ON (Mahir auto-replies)' : 'OFF'}`);
        console.log(`\n   Webhook: POST /api/webhook`);
        console.log(`   Status: GET /health`);
        console.log(`   Dashboard: GET /\n`);
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  start();
}

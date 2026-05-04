import express from 'express';
import cors from 'cors';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDatabase } from './db.js';
import { generateReply } from './ai.js';
import { saveMessage, getConversationHistory } from './db.js';
import { startWhatsApp, sendWhatsAppMessage, getQRCode, isConnected, whatsappEmitter } from './whatsapp.js';
import { sendInstantAlert } from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (dashboard)
app.use(express.static(path.join(rootDir, 'public')));

// WhatsApp Event Handler
const urgentKeywords = ['urgent', 'emergency', 'help', 'zaroori', 'jaldi', 'important', 'problem', 'issue'];

whatsappEmitter.on('message', async (data: { senderId: string; senderName: string; text: string }) => {
  try {
    // Save incoming message
    await saveMessage(data.senderId, data.senderName, 'incoming', data.text, false);

    // Telegram instant alert
    const lower = data.text.toLowerCase();
    if (urgentKeywords.some((kw) => lower.includes(kw))) {
      console.log('🚨 URGENT message detected — sending Telegram alert');
      await sendInstantAlert(data.senderName, data.text, 'Urgent keywords detected');
    }

    // Check busy mode
    if (!config.busyMode) {
      console.log('⏸️ Busy mode OFF — not auto-replying');
      return;
    }

    // Get conversation history
    const history = await getConversationHistory(data.senderId, 10);

    // Generate AI reply
    const reply = await generateReply(data.text, history, data.senderName);
    console.log(`💬 AI Reply to ${data.senderName}: ${reply}`);

    // Send reply
    await sendWhatsAppMessage(data.senderId, reply);
    await saveMessage(data.senderId, undefined, 'outgoing', reply, true);
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

// Start WhatsApp connection
startWhatsApp().catch((err) => console.error('Failed to start WhatsApp:', err));

// Routes
app.get('/api/qr', (_req, res) => {
  const qr = getQRCode();
  res.json({ qr, status: isConnected() ? 'connected' : qr ? 'scan_needed' : 'connecting' });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      whatsapp: isConnected(),
      ai: config.isAiReady(),
      database: config.isDbReady(),
      telegram: config.isTelegramReady(),
    },
    busyMode: config.busyMode,
  });
});

app.get('/api/test', (_req, res) => {
  res.json({
    status: 'ok',
    busyMode: config.busyMode,
    whatsappConnected: isConnected(),
    aiReady: config.isAiReady(),
    dbReady: config.isDbReady(),
    telegramReady: config.isTelegramReady(),
  });
});

app.post('/api/toggle', (_req, res) => {
  config.busyMode = !config.busyMode;
  res.json({ busyMode: config.busyMode });
});

app.post('/api/digest', async (_req, res) => {
  const { sendDailyDigest } = await import('./telegram.js');
  const { Pool } = await import('pg');

  try {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: false },
    });

    const today = new Date().toISOString().split('T')[0];
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM conversations WHERE DATE(timestamp) = $1`,
      [today]
    );
    const totalMessages = parseInt(totalResult.rows[0].count);

    const contactsResult = await pool.query(
      `SELECT sender_name, COUNT(*) as count FROM conversations WHERE DATE(timestamp) = $1 GROUP BY sender_name ORDER BY count DESC LIMIT 5`,
      [today]
    );
    const topContacts = contactsResult.rows.map((r) => ({
      name: r.sender_name || 'Unknown',
      count: parseInt(r.count),
    }));

    const importantResult = await pool.query(
      `SELECT sender_name, content FROM conversations WHERE DATE(timestamp) = $1 AND LENGTH(content) > 50 AND message_type = 'incoming' ORDER BY timestamp DESC LIMIT 5`,
      [today]
    );
    const importantHighlights = importantResult.rows.map(
      (r) => `${r.sender_name || 'Unknown'}: ${r.content.substring(0, 100)}`
    );

    await pool.end();

    const sent = await sendDailyDigest({
      totalMessages,
      uniqueContacts: topContacts.length,
      topContacts,
      importantHighlights,
      date: new Date().toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    });

    res.json({ success: sent, message: sent ? 'Digest sent to Telegram' : 'Failed to send digest' });
  } catch (error) {
    console.error('Digest error:', error);
    res.status(500).json({ error: 'Failed to generate digest' });
  }
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

export default app;

// Start server if running directly
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  async function start() {
    try {
      await initDatabase();
      const PORT = config.port;
      app.listen(PORT, () => {
        console.log(`\n🤖 Mahir Abher (Mujtaba ka Bhai) running on http://localhost:${PORT}`);
        console.log(`   WhatsApp: ${isConnected() ? '✅ Connected' : '⏳ Waiting for scan...'}`);
        console.log(`   AI (Gemini): ${config.isAiReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Database (Neon): ${config.isDbReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Telegram: ${config.isTelegramReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Busy Mode: ${config.busyMode ? 'ON (Mahir auto-replies)' : 'OFF'}`);
        console.log(`\n   QR Code: GET /api/qr`);
        console.log(`   Dashboard: GET /\n`);
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  start();
}

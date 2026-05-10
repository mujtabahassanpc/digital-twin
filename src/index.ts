import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDatabase, getPool, closePool } from './db.js';
import { generateReply, getProviderStatuses, isAnyProviderAvailable, getDbCreditsUsed, incrementDbCredits, resetDbCredits } from './ai.js';
import { saveMessage, getConversationHistory } from './db.js';
import { startWhatsApp, sendWhatsAppMessage, showTyping, sendVoiceMessage, getQRCode, isConnected, whatsappEmitter } from './whatsapp.js';
import { sendInstantAlert, sendImportantConversationAlert, handleTelegramCommand } from './telegram.js';

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
const urgentKeywords = ['urgent', 'emergency', 'help', 'zaroori', 'jaldi', 'important', 'problem', 'issue', 'kaam hai', 'madad'];
const importantConversationTriggers = [
  'zaroori baat', 'kaam hai', 'baat karni hai', 'talk to mujtaba',
  'mujtaba se baat', 'need to tell', 'personal baat', 'private',
  'secret', 'kharcha', 'paisa', 'money', 'family', 'shadi',
  'medical', 'hospital', 'accident', 'death', 'marriage',
  'job', 'offer', 'result', 'exam', 'admission',
];

// Voice keywords — user asks Mahir to send voice message
const voiceKeywords = ['voice', 'bol ke', 'sunna', 'awaaz', 'awaz', 'bol ke bhejo', 'voice message', 'apni awaaz', 'apni awaz', 'bol ke suna', 'sunao', 'bolo na', 'voice me', 'bol ke dikha', 'apni voice', 'voice send'];

// Per-chat voice message count (resets on restart)
const voiceCountPerChat: Record<string, number> = {};
const MAX_VOICE_PER_CHAT = 5;

// Message batching — wait 3 sec for more messages from same sender
const messageBuffers: Record<string, { messages: { text: string; timestamp: number }[]; timer: ReturnType<typeof setTimeout> }> = {};
const BATCH_WINDOW_MS = 3000;

function processBatchedMessage(
  senderId: string,
  senderName: string,
  combinedText: string
): Promise<void> {
  return (async () => {
    try {
      // Save incoming message (combined)
      await saveMessage(senderId, senderName, 'incoming', combinedText, false);
      incrementDbCredits();

      const lower = combinedText.toLowerCase();

      // Check if this looks like an important conversation
      const isImportant = importantConversationTriggers.some((phrase) => lower.includes(phrase));

      if (isImportant) {
        console.log(`🔔 Important conversation from ${senderName} (${senderId})`);

        const history = await getConversationHistory(senderId, 5);
        const context = history.map((h: any) => `${h.role === 'user' ? '👤' : '🤖'} ${h.content}`).join('\n');

        await sendImportantConversationAlert(senderName, senderId, context || 'No recent history');

        await showTyping(senderId, 2000);
        const reply = 'acha bolbo, me sun raha hu 🤲';
        await sendWhatsAppMessage(senderId, reply);
        await saveMessage(senderId, undefined, 'outgoing', reply, true);
        return;
      }

      // Telegram instant alert for urgent keywords
      if (urgentKeywords.some((kw) => lower.includes(kw))) {
        console.log('🚨 URGENT message detected — sending Telegram alert');
        await sendInstantAlert(senderName, combinedText, 'Urgent keywords detected');
      }

      // Check busy mode
      if (!config.busyMode) {
        console.log('⏸️ Busy mode OFF — not auto-replying');
        return;
      }

      // Get conversation history
      const history = await getConversationHistory(senderId, 10);

      // Generate AI reply with metadata
      const result = await generateReply(combinedText, history, senderName, senderId);

      // --- Enhanced End Enforcer: Detect conversation ending & energy ---
      const recentUserMsgs = history.filter(e => e.role === 'user').slice(-3);
      const currentMsgShort = combinedText.trim().length <= 3;
      const allShort = recentUserMsgs.length >= 2 && recentUserMsgs.every(e => e.content.trim().length <= 5);
      const noQuestion = !recentUserMsgs.some(e => e.content.includes('?'));
      const replyIsLong = result.text && result.text.split(' ').length > 12;

      // Level 1: Single-word ending ("ok", "hmm", "k") → ultra short reply
      if (currentMsgShort && combinedText.trim().toLowerCase().match(/^(ok|hmm|hm|mm|k|hn|na|acha|thik|oh|haan|haa)$/)) {
        const acknowledgments = ['thik ache', 'acha', 'mm', 'thik hai'];
        result.text = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
        console.log('✂️ Ultra-short ending detected — single-word acknowledgment');
      }
      // Level 2: User consistently giving short replies → trim to 1 sentence
      else if (allShort && noQuestion && replyIsLong) {
        result.text = result.text.split(' ').slice(0, 12).join(' ').trim() + '.';
        console.log('✂️ Reply trimmed (end enforcer)');
      }

      // --- Serious mode: Detect urgent/harsh keywords → remove jokes/emojis ---
      const seriousKeywords = ['death', 'died', 'mar gaya', 'accident', 'hospital', 'operation', 'critical', 'surgery', 'loss', 'passed away', 'innalillahi', 'condolence'];
      const isSerious = seriousKeywords.some(kw => combinedText.toLowerCase().includes(kw));
      if (isSerious && result.text) {
        result.text = result.text
          .replace(/[😀-🙏🀄-🧀🗨-🛿]/gu, '')
          .replace(/😂|😅|🤣|😆|😁/g, '')
          .replace(/lol|haha|hehe/gi, '')
          .trim();
        console.log('🕊️ Serious mode — jokes/emojis removed');
      }

      // Handle clarification needed — Mahir asks user to rephrase AND tells Mujtaba
      if (result.needsClarification) {
        console.log(`🤔 Mahir confused — asking for clarification from ${senderName}`);

        // Send clarification request to user
        const clarificationMsg = result.clarificationText || 'bhai me samja nhi, ek baar phir se bolna?';
        await showTyping(senderId, 1500);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await sendWhatsAppMessage(senderId, clarificationMsg);
        await saveMessage(senderId, undefined, 'outgoing', clarificationMsg, true);

        // Alert Mujtaba on Telegram
        const { sendConfusionAlert } = await import('./telegram.js');
        await sendConfusionAlert(senderName, senderId, combinedText, history);

        // --- Save to learning queue (async) ---
        const queuePath = path.join(__dirname, '..', 'data', 'learning_queue.json');
        try {
          const raw = await fs.promises.readFile(queuePath, 'utf-8').catch(() => '[]');
          let queue = JSON.parse(raw);
          queue.push({
            timestamp: new Date().toISOString(),
            senderId,
            senderName,
            userMessage: combinedText,
            context: history.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n'),
            status: 'new',
          });
          if (queue.length > 50) queue = queue.slice(-50);
          await fs.promises.writeFile(queuePath, JSON.stringify(queue, null, 2));
        } catch { /* silent */ }

        return;
      }

      // Skip if no reply (already sent exhausted message)
      if (!result.text) {
        console.log(`⏭️ Skipping reply to ${senderName} — already sent exhausted message`);
        return;
      }

      // Split reply into multiple messages if needed
      const messages = splitIntoMessages(result.text);

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const delay = getTypingDelay(msg.length);

        if (i > 0) {
          // Realistic pause between messages (human-like: 1-3 sec)
          const pause = 1000 + Math.random() * 2000;
          await new Promise((resolve) => setTimeout(resolve, pause));
        }

        await showTyping(senderId, delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await sendWhatsAppMessage(senderId, msg);
        await saveMessage(senderId, undefined, 'outgoing', msg, true);
      }

      console.log(`💬 AI Reply to ${senderName} (${messages.length} message(s)): ${result.text.slice(0, 80)}...`);

      // --- Script execution report ---
      if (result.scriptTriggered) {
        const { sendTelegramMessage } = await import('./telegram.js');
        await sendTelegramMessage(`📋 <b>Script Executed</b> for <b>${senderName}</b> (${senderId})\n\nMahir replied: "${result.text.slice(0, 200)}"\n\nOriginal instruction: "${result.scriptTriggered.slice(0, 150)}"`).catch(() => {});
        // Mark script as reported
        const { markScriptReported } = await import('./ai.js');
        markScriptReported(senderId);
      }

      // --- "Acha Bolbo" / Inform Promise Detection ---
      if (result.hasInformPromise) {
        const { sendInformAlert } = await import('./telegram.js');
        await sendInformAlert(senderName, senderId, combinedText, result.text).catch(() => {});
      }

      // --- Voice Reply — user asked Mahir to send voice ---
      const userWantsVoice = voiceKeywords.some(kw => lower.includes(kw));
      if (userWantsVoice && config.getSarvamKeys().length > 0) {
        const currentCount = voiceCountPerChat[senderId] || 0;
        if (currentCount < MAX_VOICE_PER_CHAT) {
          console.log(`🎤 ${senderName} asked for voice (${currentCount + 1}/${MAX_VOICE_PER_CHAT})`);
          const { generateSpeech } = await import('./ai.js');
          const audioBuffer = await generateSpeech(result.text);
          if (audioBuffer) {
            await sendVoiceMessage(senderId, audioBuffer);
            voiceCountPerChat[senderId] = currentCount + 1;
            // Send second voice if under limit
            if (currentCount + 1 < MAX_VOICE_PER_CHAT && result.text.length > 60) {
              const secondText = result.text.length > 120
                ? result.text.split(/[.!?\n]/).filter(Boolean).slice(1, 2).join('. ') || 'thik hai'
                : 'acha thik hai';
              const secondAudio = await generateSpeech(secondText);
              if (secondAudio) {
                await new Promise(r => setTimeout(r, 1500));
                await sendVoiceMessage(senderId, secondAudio);
                voiceCountPerChat[senderId] = currentCount + 2;
              }
            }
          }
        } else {
          console.log(`⏭️ Voice limit reached for ${senderName} (${MAX_VOICE_PER_CHAT})`);
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  })();
}

function getTypingDelay(len: number): number {
  // Realistic typing: short messages fast, long messages with natural pace
  // ~40 chars/sec with human variation
  let base: number;
  if (len <= 10) base = 700 + Math.random() * 500;       // 0.7-1.2s for very short
  else if (len <= 30) base = 1000 + Math.random() * 800;  // 1-1.8s for short
  else if (len <= 80) base = 1500 + Math.random() * 1000; // 1.5-2.5s for medium
  else base = 2200 + Math.random() * 1500;                // 2.2-3.7s for long
  return Math.round(base);
}

function splitIntoMessages(text: string): string[] {
  // If short, just one message
  if (text.length <= 80) return [text];

  // Split on sentence boundaries (。 ! ? . \n)
  const sentences = text.split(/([.!?\n]+)/);
  const chunks: string[] = [];
  let current = '';

  for (const part of sentences) {
    if (current.length + part.length > 120 && current.length > 20) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Cap at 3 messages max — merge extras into last
  if (chunks.length > 3) {
    const last = chunks.slice(2).join(' ');
    chunks.length = 2;
    chunks.push(last);
  }

  return chunks.filter(m => m.length > 0);
}

whatsappEmitter.on('message', async (data: { senderId: string; senderName: string; text: string }) => {
  try {
    const { senderId, senderName, text } = data;

    // Initialize buffer for this sender
    if (!messageBuffers[senderId]) {
      messageBuffers[senderId] = { messages: [], timer: undefined as any };
    }

    const buffer = messageBuffers[senderId];
    buffer.messages.push({ text, timestamp: Date.now() });

    // Clear existing timer
    clearTimeout(buffer.timer);

    // Set timer to process batch after window
    buffer.timer = setTimeout(() => {
      const combined = buffer.messages.map(m => m.text).join('\n');
      delete messageBuffers[senderId];
      processBatchedMessage(senderId, senderName, combined);
    }, BATCH_WINDOW_MS);
  } catch (error) {
    console.error('Error batching message:', error);
  }
});

// Telegram Bot Polling (commands)
let telegramUpdateOffset = 0;
async function pollTelegram() {
  if (!config.isTelegramReady()) return;

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${telegramUpdateOffset}&timeout=5`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        telegramUpdateOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg || !msg.text) continue;

        if (msg.text.startsWith('/')) {
          const parts = msg.text.substring(1).split(' ');
          const command = parts[0].toLowerCase();
          const args = parts.slice(1).join(' ');
          console.log(`📩 Telegram command: /${command} ${args}`);
          await handleTelegramCommand(command, args);
        }

        // Handle callback queries (button clicks)
        if (update.callback_query) {
          const cb = update.callback_query;
          if (cb.data === 'toggle_busy') {
            config.busyMode = !config.busyMode;
            const url2 = `https://api.telegram.org/bot${config.telegramBotToken}/answerCallbackQuery`;
            await fetch(url2, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cb.id, text: `Busy mode: ${config.busyMode ? 'ON' : 'OFF'}` }),
            });
            await handleTelegramCommand('status', '');
          }
        }
      }
    }
  } catch (error) {
    console.error('Telegram poll error:', error);
  }

  // Poll every 3 seconds
  setTimeout(pollTelegram, 3000);
}

// Start WhatsApp connection
startWhatsApp().catch((err) => console.error('Failed to start WhatsApp:', err));

// Start Telegram polling
setTimeout(pollTelegram, 2000);

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

// Provider health dashboard
app.get('/api/providers', (_req, res) => {
  const statuses = getProviderStatuses();
  res.json({
    timestamp: new Date().toISOString(),
    providers: statuses,
    anyAvailable: isAnyProviderAvailable(),
    dbCreditsUsed: getDbCreditsUsed(),
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

  try {
    const pool = getPool();

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

// Learning Queue API
app.get('/api/learning-queue', (_req, res) => {
  const queuePath = path.join(__dirname, '..', 'data', 'learning_queue.json');
  try {
    const raw = fs.readFileSync(queuePath, 'utf-8');
    const queue = JSON.parse(raw);
    const pending = queue.filter((item: any) => item.status === 'new').slice(-20);
    res.json({ total: queue.length, pending: pending.length, items: pending });
  } catch {
    res.json({ total: 0, pending: 0, items: [] });
  }
});

app.post('/api/learning-queue/approve', async (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number') return res.status(400).json({ error: 'index required' });

  const queuePath = path.join(__dirname, '..', 'data', 'learning_queue.json');
  const langPath = path.join(__dirname, '..', 'data', 'language_examples.json');

  try {
    const raw = fs.readFileSync(queuePath, 'utf-8');
    const queue = JSON.parse(raw);
    const pending = queue.filter((item: any) => item.status === 'new');
    if (index < 0 || index >= pending.length) return res.status(404).json({ error: 'Item not found' });

    const item = pending[index];
    item.status = 'approved';

    // Add to language examples
    const langRaw = fs.readFileSync(langPath, 'utf-8');
    const lang = JSON.parse(langRaw);
    lang.examples.push({
      message: item.userMessage,
      reason: `Auto-learned: ${item.senderName} said "${item.userMessage.slice(0, 50)}"`,
      added_at: new Date().toISOString(),
    });
    lang.last_updated = new Date().toISOString();

    fs.writeFileSync(langPath, JSON.stringify(lang, null, 2));
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

    res.json({ success: true, message: 'Approved and added to language examples' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

      // Start DB size monitoring (check every 6 hours)
      if (config.isDbReady()) {
        checkDbSize();
        setInterval(checkDbSize, 6 * 60 * 60 * 1000);
      }

      // Start schedule checker (every 30 seconds)
      startScheduleChecker();

      const PORT = config.port;
      app.listen(PORT, () => {
        console.log(`\n🤖 Mahir Abher (Mujtaba ka Bhai) running on http://localhost:${PORT}`);
        console.log(`   WhatsApp: ${isConnected() ? '✅ Connected' : '⏳ Waiting for scan...'}`);
        console.log(`   AI (Gemini): ${config.isAiReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Database (Neon): ${config.isDbReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Telegram: ${config.isTelegramReady() ? '✅ Ready (polling commands)' : '⏳ Not configured'}`);
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

// DB Size Monitoring
let dbAlertSent80 = false;
let dbAlertSent90 = false;
let dbAlertSent95 = false;

async function checkDbSize() {
  if (!config.isDbReady()) return;
  try {
    const result = await getPool().query(`SELECT pg_database_size(current_database()) as bytes`);
    const bytes = parseInt(result.rows[0].bytes);
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const maxMb = 500; // Neon free tier: 500 MB
    const pct = (parseFloat(mb) / maxMb) * 100;

    if (pct >= 95 && !dbAlertSent95) {
      dbAlertSent95 = true;
      const { sendTelegramMessage } = await import('./telegram.js');
      await sendTelegramMessage(`🚨 <b>Database at ${pct.toFixed(0)}% capacity!</b>\n\nUsed: ${mb} MB / ${maxMb} MB\n\n⚠️ Neon free tier almost full! Add second Neon DB soon. Use /status to check.`);
      console.log(`🚨 DB at ${pct.toFixed(0)}% — alert sent`);
    } else if (pct >= 90 && !dbAlertSent90) {
      dbAlertSent90 = true;
      const { sendTelegramMessage } = await import('./telegram.js');
      await sendTelegramMessage(`⚠️ <b>Database at ${pct.toFixed(0)}% capacity</b>\n\nUsed: ${mb} MB / ${maxMb} MB\n\nPrepare to add second Neon DB soon.`);
      console.log(`⚠️ DB at ${pct.toFixed(0)}% — alert sent`);
    } else if (pct >= 80 && !dbAlertSent80) {
      dbAlertSent80 = true;
      const { sendTelegramMessage } = await import('./telegram.js');
      await sendTelegramMessage(`📊 <b>Database at ${pct.toFixed(0)}%</b>\n\nUsed: ${mb} MB / ${maxMb} MB\n\nGetting there. Consider adding second Neon DB.`);
      console.log(`📊 DB at ${pct.toFixed(0)}% — alert sent`);
    }

    // Log every check
    console.log(`📊 DB size: ${mb} MB / ${maxMb} MB (${pct.toFixed(0)}%)`);
  } catch (err) {
    console.error('DB size check error:', err);
  }
}

// Scheduled Message Checker
function startScheduleChecker() {
  setInterval(async () => {
    try {
      const { getDueSchedules, markScheduleSent } = await import('./ai.js') as any;
      const due = getDueSchedules();
      for (const s of due) {
        console.log(`⏰ Sending scheduled message to ${s.targetPhone}: "${s.message.slice(0, 50)}..."`);
        try {
          const { sendWhatsAppMessage } = await import('./whatsapp.js') as any;
          await sendWhatsAppMessage(s.targetPhone, `${s.message}\n\n— Mahir Abher 🤖`);
          markScheduleSent(s.id);
          const { sendTelegramMessage } = await import('./telegram.js') as any;
          await sendTelegramMessage(`⏰ <b>Scheduled Message Sent</b>\n\n<b>To:</b> ${s.targetPhone}\n<b>Time:</b> ${new Date(s.scheduledTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n<b>Message:</b> "${s.message.slice(0, 100)}"`).catch(() => {});
          console.log(`✅ Scheduled message sent to ${s.targetPhone}`);
        } catch (err: any) {
          console.error(`❌ Failed to send scheduled message to ${s.targetPhone}:`, err);
          markScheduleSent(s.id, err.message);
        }
      }
    } catch (err) {
      // silent — scheduler keeps running
    }
  }, 30_000);
}

// Graceful Shutdown
async function shutdownGracefully(signal: string) {
  console.log(`\n🛑 Received ${signal} — shutting down gracefully...`);

  // Flush message batch buffers (process remaining)
  for (const [senderId, buffer] of Object.entries(messageBuffers)) {
    clearTimeout(buffer.timer);
    if (buffer.messages.length > 0) {
      const combined = buffer.messages.map(m => m.text).join('\n');
      console.log(`🔄 Flushing ${buffer.messages.length} queued message(s) from ${senderId}`);
      processBatchedMessage(senderId, 'unknown', combined).catch(() => {});
    }
  }

  // Give time for last messages to send
  await new Promise(r => setTimeout(r, 2000));

  // Close DB pool
  await closePool().catch(() => {});

  console.log('👋 Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));

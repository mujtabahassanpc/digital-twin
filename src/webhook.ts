import { Router } from 'express';
import { config } from './config.js';
import {
  verifyWhatsAppWebhook,
  parseIncomingWebhook,
  sendWhatsAppMessage,
} from './whatsapp.js';
import { generateReply } from './ai.js';
import { saveMessage, getConversationHistory, initDatabase } from './db.js';
import { sendInstantAlert } from './telegram.js';

const router = Router();

// Track important messages for instant alerts
const urgentKeywords = ['urgent', 'emergency', 'help', 'zaroori', 'jaldi', 'important', 'problem', 'issue'];

function isUrgent(text: string): boolean {
  const lower = text.toLowerCase();
  return urgentKeywords.some((kw) => lower.includes(kw));
}

// Webhook verification (GET — Meta sends this to verify the endpoint)
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const result = verifyWhatsAppWebhook(mode, token, challenge);

  if (result) {
    console.log('Webhook verified successfully');
    res.status(200).send(result);
  } else {
    console.warn('Webhook verification failed — token mismatch');
    res.sendStatus(403);
  }
});

// Incoming messages (POST — Meta sends this for each incoming message)
router.post('/webhook', async (req, res) => {
  try {
    // Always respond 200 immediately — Meta expects fast response
    res.sendStatus(200);

    const body = req.body;

    // Acknowledge delivery status updates
    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
      console.log('Message status update received');
      return;
    }

    const parsed = parseIncomingWebhook(body);
    if (!parsed) {
      console.log('No parseable message in webhook');
      return;
    }

    console.log(`Message from ${parsed.senderName || parsed.senderId}: ${parsed.text.substring(0, 100)}`);

    // Save incoming message
    await saveMessage(
      parsed.senderId,
      parsed.senderName,
      'incoming',
      parsed.text,
      false,
      parsed.messageId
    );

    // Send instant Telegram alert for urgent messages
    if (isUrgent(parsed.text)) {
      console.log('URGENT message detected — sending Telegram alert');
      await sendInstantAlert(
        parsed.senderName || parsed.senderId,
        parsed.text,
        'Urgent keywords detected'
      );
    }

    // Check if busy mode is on (default: true — AI handles replies)
    if (!config.busyMode) {
      console.log('Busy mode OFF — not auto-replying');
      return;
    }

    // Get conversation history for context
    const history = await getConversationHistory(parsed.senderId, 10);

    // Generate AI reply
    const reply = await generateReply(
      parsed.text,
      history,
      parsed.senderName
    );

    console.log(`AI Reply: ${reply}`);

    // Send reply via WhatsApp
    const sendResult = await sendWhatsAppMessage(parsed.senderId, reply);

    // Save outgoing message
    await saveMessage(
      parsed.senderId,
      undefined,
      'outgoing',
      reply,
      true,
      sendResult.messages?.[0]?.id
    );

    console.log(`Reply sent to ${parsed.senderId} successfully`);
  } catch (error) {
    console.error('Error processing webhook:', error);
  }
});

// Test endpoint
router.get('/test', (_req, res) => {
  res.json({
    status: 'ok',
    busyMode: config.busyMode,
    whatsappReady: config.isWhatsAppReady(),
    aiReady: config.isAiReady(),
    dbReady: config.isDbReady(),
    telegramReady: config.isTelegramReady(),
  });
});

// Toggle busy mode
router.post('/toggle', (_req, res) => {
  config.busyMode = !config.busyMode;
  res.json({ busyMode: config.busyMode });
});

// Trigger daily digest manually (for testing)
router.post('/digest', async (_req, res) => {
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

    const uniqueContacts = topContacts.length;

    // Get important messages (long ones or from frequent contacts)
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
      uniqueContacts,
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

export const webhookRouter = router;

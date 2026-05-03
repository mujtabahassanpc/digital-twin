import { Router } from 'express';
import { config } from './config.js';
import {
  verifyWhatsAppWebhook,
  parseIncomingWebhook,
  sendWhatsAppMessage,
} from './whatsapp.js';
import { generateReply } from './ai.js';
import { saveMessage, getConversationHistory, initDatabase } from './db.js';

const router = Router();

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
  });
});

// Toggle busy mode
router.post('/toggle', (_req, res) => {
  config.busyMode = !config.busyMode;
  res.json({ busyMode: config.busyMode });
});

export const webhookRouter = router;

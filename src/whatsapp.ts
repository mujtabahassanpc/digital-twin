import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import pino from 'pino';
import QRCode from 'qrcode';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';
import fs from 'fs';
import { config } from './config.js';
import { describeImage, transcribeAudio } from './ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '..', 'auth_info_baileys');

if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

let sock: ReturnType<typeof makeWASocket> | null = null;
let currentQR: string | null = null;
let isReady = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;

export const whatsappEmitter = new EventEmitter();

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    msgRetryCounterCache,
    browser: ['Mahir (Mujtaba)', 'Chrome', '3.0'],
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr);
        whatsappEmitter.emit('qr-updated', currentQR);
      } catch (e) {
        console.error('QR generation error:', e);
      }
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const wasLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`⚠️ WhatsApp disconnected (code: ${statusCode}), logged out: ${wasLoggedOut}`);
      isReady = false;
      currentQR = null;

      if (wasLoggedOut) {
        console.log('🔑 Logged out — need to re-scan QR code');
        reconnectAttempts = 0;
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, MAX_RECONNECT_DELAY);
        console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
        setTimeout(() => startWhatsApp(), delay);
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Connected!');
      isReady = true;
      currentQR = null;
      reconnectAttempts = 0;
      whatsappEmitter.emit('connected');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg?.message || !msg.key?.remoteJid) return;

    const senderId = msg.key.remoteJid;
    const isFromMe = !!msg.key.fromMe;
    const senderName = isFromMe ? 'Mujtaba' : (msg.pushName || 'Unknown');

    // Extract text from various message types
    let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

    if (msg.message?.imageMessage) {
      const caption = msg.message.imageMessage.caption;
      if (config.mediaProcessing) {
        try {
          const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
          const buffer = await streamToBuffer(stream);
          const base64 = buffer.toString('base64');
          const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
          const description = await describeImage(base64, mimeType);
          text = caption ? `${caption} [Sent a photo: ${description}]` : `[Sent a photo: ${description}]`;
          console.log(`🖼️ Image described: ${description}`);
        } catch (e) {
          text = caption ? `[Photo] ${caption}` : '[Photo]';
          console.error('Image processing error:', e);
        }
      } else {
        text = caption ? `[Photo] ${caption}` : '[Photo]';
      }
    }

    if (msg.message?.audioMessage) {
      if (config.mediaProcessing) {
        try {
          const stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
          const buffer = await streamToBuffer(stream);
          const base64 = buffer.toString('base64');
          const transcript = await transcribeAudio(base64);
          text = `[Voice: ${transcript}]`;
          console.log(`🎤 Voice transcribed: ${transcript.slice(0, 80)}`);
        } catch (e) {
          text = '[Voice message]';
          console.error('Voice processing error:', e);
        }
      } else {
        text = '[Voice message]';
      }
    }

    if (msg.message?.videoMessage) {
      const caption = msg.message.videoMessage.caption;
      text = caption ? `[Video] ${caption}` : '[Video]';
    }

    if (msg.message?.documentMessage) {
      text = `[Document: ${msg.message.documentMessage.fileName || 'file'}]`;
    }

    if (msg.message?.stickerMessage) {
      text = '[Sticker]';
    }

    if (!text) return;

    if (isFromMe) {
      whatsappEmitter.emit('own-message', { senderId, text });
    } else {
      console.log(`Message from ${senderName} (${senderId}): ${text}`);
      whatsappEmitter.emit('message', { senderId, senderName, text });
    }
  });
}

export async function showTyping(to: string, durationMs: number): Promise<void> {
  if (!sock) return;
  try {
    await sock.sendPresenceUpdate('composing', to);
    setTimeout(async () => {
      if (sock) {
        await sock.sendPresenceUpdate('paused', to);
      }
    }, durationMs);
  } catch (e) {
    console.warn('⚠️ showTyping error:', e);
  }
}

export function toJid(phoneNumber: string): string {
  // Already a valid JID
  if (phoneNumber.includes('@')) return phoneNumber;

  // Remove all non-digit characters
  let num = phoneNumber.replace(/[^0-9]/g, '');

  // Must be at least 10 digits for a phone number
  if (num.length < 10) {
    console.warn(`⚠️ Invalid phone number: "${phoneNumber}" (stripped to "${num}")`);
  }

  return `${num}@s.whatsapp.net`;
}

export async function sendWhatsAppMessage(to: string, text: string) {
  if (!sock) throw new Error('WhatsApp not started');
  const s = sock;

  try {
    const jid = to.includes('@') ? to : toJid(to);
    const result = await s.sendMessage(jid, { text });
    return result;
  } catch (err: any) {
    // If it's a JID decode error, try with @lid suffix
    if (String(err?.message || '').includes('jidDecode') || String(err?.message || '').includes('invalid jid')) {
      const lidJid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@lid`;
      console.log(`🔄 Retrying with LID JID: ${lidJid}`);
      return s.sendMessage(lidJid, { text });
    }
    throw err;
  }
}

export async function sendVoiceMessage(to: string, audioBuffer: Buffer): Promise<void> {
  if (!sock) throw new Error('WhatsApp not started');
  const s = sock;
  try {
    const jid = to.includes('@') ? to : toJid(to);
    await s.sendMessage(jid, { audio: audioBuffer, mimetype: 'audio/ogg', ptt: true });
    console.log(`🎤 Voice message sent to ${jid}`);
  } catch (err: any) {
    console.error('Voice message error:', err);
    throw err;
  }
}

export function getQRCode() {
  return currentQR;
}

export function isConnected() {
  return isReady;
}

export function getReconnectAttempts() {
  return reconnectAttempts;
}

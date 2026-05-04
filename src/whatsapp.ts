import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import pino from 'pino';
import QRCode from 'qrcode';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '..', 'auth_info_baileys');

if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

const msgRetryCounterCache = new NodeCache();

let sock: ReturnType<typeof makeWASocket> | null = null;
let currentQR: string | null = null;
let isReady = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000; // 60s max

export const whatsappEmitter = new EventEmitter();

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
      const wasStreamError = statusCode === 515;

      console.log(`⚠️ WhatsApp disconnected (code: ${statusCode}), logged out: ${wasLoggedOut}`);
      isReady = false;
      currentQR = null;

      if (wasLoggedOut) {
        console.log('🔑 Logged out — need to re-scan QR code');
        // Auth state is cleared by useMultiFileAuthState, restart fresh
        reconnectAttempts = 0;
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        // Exponential backoff for reconnect
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
    if (!msg.message || msg.key.fromMe) return;

    const senderId = msg.key.remoteJid!;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    const senderName = msg.pushName || 'Unknown';

    if (text) {
      console.log(`Message from ${senderName} (${senderId}): ${text}`);
      whatsappEmitter.emit('message', { senderId, senderName, text });
    }
  });
}

export async function sendWhatsAppMessage(to: string, text: string) {
  if (!sock) throw new Error('WhatsApp not started');
  await sock!.sendMessage(to, { text });
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

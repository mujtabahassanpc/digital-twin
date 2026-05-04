import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  WASocket,
  BaileysEventMap,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import pino from 'pino';
import QRCode from 'qrcode';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '..', 'auth_info_baileys');

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

let sock: ReturnType<typeof makeWASocket> | null = null;
let currentQR: string | null = null;
let isReady = false;

export const whatsappEmitter = new EventEmitter();

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: true,
  });

  store.bind(sock.ev);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      whatsappEmitter.emit('qr-updated', currentQR);
    }
    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 2000);
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Connected!');
      isReady = true;
      currentQR = null;
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

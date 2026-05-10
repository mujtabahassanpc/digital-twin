import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendTelegramMessage } from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const feedbackPath = path.join(__dirname, '..', 'data', 'feedback.json');

interface FeedbackEntry {
  id: string;
  timestamp: number;
  senderId: string;
  senderName: string;
  incomingMessage: string;
  mahirReply: string;
  rating: 'good' | 'ok' | 'bad' | null;
  reason: string;
  reviewed: boolean;
}

interface ReplyRecord {
  id: string;
  timestamp: number;
  senderId: string;
  senderName: string;
  incomingMessage: string;
  mahirReply: string;
}

const MAX_BUFFER = 30;
const replyBuffer: ReplyRecord[] = [];

let idCounter = 0;

function generateId(): string {
  idCounter++;
  return `r${Date.now().toString(36)}_${idCounter}`;
}

export function recordReply(
  senderId: string,
  senderName: string,
  incomingMessage: string,
  mahirReply: string,
): string {
  const entry: ReplyRecord = {
    id: generateId(),
    timestamp: Date.now(),
    senderId,
    senderName,
    incomingMessage,
    mahirReply,
  };
  replyBuffer.push(entry);
  if (replyBuffer.length > MAX_BUFFER) replyBuffer.shift();
  return entry.id;
}

function loadFeedback(): FeedbackEntry[] {
  try {
    return JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveFeedback(data: FeedbackEntry[]) {
  fs.writeFileSync(feedbackPath, JSON.stringify(data, null, 2));
}

export function rateReply(
  id: string,
  rating: 'good' | 'ok' | 'bad',
  reason: string,
): boolean {
  const record = replyBuffer.find(r => r.id === id);
  if (!record) return false;

  const feedback = loadFeedback();
  const existing = feedback.find(f => f.id === id);
  if (existing) {
    existing.rating = rating;
    existing.reason = reason;
    existing.reviewed = false;
  } else {
    feedback.push({
      id,
      timestamp: record.timestamp,
      senderId: record.senderId,
      senderName: record.senderName,
      incomingMessage: record.incomingMessage,
      mahirReply: record.mahirReply,
      rating,
      reason,
      reviewed: false,
    });
  }
  saveFeedback(feedback);
  return true;
}

export function getRecentReplies(
  senderId?: string,
  count: number = 10,
): ReplyRecord[] {
  let filtered = replyBuffer;
  if (senderId) filtered = filtered.filter(r => r.senderId === senderId);
  return filtered.slice(-count).reverse();
}

export function getFeedbackStats(): string {
  const feedback = loadFeedback();
  if (feedback.length === 0) return 'No feedback recorded yet. Use /ratelist to rate replies.';

  const total = feedback.length;
  const rated = feedback.filter(f => f.rating !== null).length;
  const good = feedback.filter(f => f.rating === 'good').length;
  const ok = feedback.filter(f => f.rating === 'ok').length;
  const bad = feedback.filter(f => f.rating === 'bad').length;
  const pending = feedback.filter(f => f.rating === null).length;

  const latestBad = feedback.filter(f => f.rating === 'bad').slice(-5);

  let msg = `<b>📊 Feedback Stats</b>\n\n`;
  msg += `Total entries: ${total}\n`;
  msg += `Rated: ${rated} (good: ${good}, ok: ${ok}, bad: ${bad})\n`;
  msg += `Unrated: ${pending}\n`;
  msg += `Rate: ${rated > 0 ? Math.round(good / rated * 100) : 0}% good / ${rated > 0 ? Math.round(bad / rated * 100) : 0}% bad\n`;

  if (latestBad.length > 0) {
    msg += `\n<b>Recent bad ratings:</b>\n`;
    for (const b of latestBad) {
      msg += `• To ${b.senderName}: "${b.mahirReply.slice(0, 60)}..."\n  Reason: ${b.reason || 'none'}\n`;
    }
  }

  return msg;
}

export function getUnreviewedBadFeedback(): FeedbackEntry[] {
  return loadFeedback().filter(f => f.rating === 'bad' && !f.reviewed);
}

export function markFeedbackReviewed(id: string) {
  const feedback = loadFeedback();
  const entry = feedback.find(f => f.id === id);
  if (entry) {
    entry.reviewed = true;
    saveFeedback(feedback);
  }
}

export function getFeedbackContext(): string {
  const bad = getUnreviewedBadFeedback().slice(-5);
  if (bad.length === 0) return '';

  let text = '## Recent Feedback (mistakes to learn from)\n';
  for (const b of bad) {
    text += `- User said "${b.incomingMessage.slice(0, 80)}", Mahir replied "${b.mahirReply.slice(0, 80)}". `;
    text += `User rated this BAD. Reason: ${b.reason || 'not given'}. `;
    text += `Don't repeat this mistake.\n`;
  }
  return text;
}

// --- Telegram command handlers ---

export async function handleRatingList(args: string): Promise<boolean> {
  const parts = args.split(/\s+/);
  let senderId: string | undefined;
  let count = 10;

  if (parts.length >= 1 && parts[0]) {
    const phone = parts[0].replace(/\D/g, '');
    if (phone.length >= 10) {
      senderId = `${phone}@s.whatsapp.net`;
      count = parseInt(parts[1]) || 10;
    } else {
      count = parseInt(parts[0]) || 10;
    }
  }

  const recent = getRecentReplies(senderId, Math.min(count, 20));
  if (recent.length === 0) {
    return sendTelegramMessage('📋 No recent replies to show. Mahir ne abhi koi reply nahi kiya.');
  }

  let msg = `<b>📋 Recent Replies</b> (last ${recent.length})\n\n`;
  for (const r of recent) {
    const id = r.id;
    const time = new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    msg += `<code>${id}</code> [${time}] <b>${r.senderName}</b>\n`;
    msg += `User: "${r.incomingMessage.slice(0, 60)}"\n`;
    msg += `Mahir: "${r.mahirReply.slice(0, 80)}"\n\n`;
  }
  msg += `Use /rate <code>id</code> good|ok|bad [reason] to rate.\n`;
  msg += `Example: /rate ${recent[0].id} bad "too long, be short"`;

  return sendTelegramMessage(msg);
}

export async function handleRateCommand(args: string): Promise<boolean> {
  const parts = args.match(/(\S+)\s+(good|ok|bad)\s*(.*)/i);
  if (!parts) {
    return sendTelegramMessage('Usage: /rate <id> good|ok|bad [reason]\n\nSee /ratelist for IDs.');
  }

  const id = parts[1];
  const rating = parts[2].toLowerCase() as 'good' | 'ok' | 'bad';
  const reason = parts[3]?.trim() || '';

  const success = rateReply(id, rating, reason);
  if (!success) {
    return sendTelegramMessage(`❌ Reply ID "${id}" not found. Use /ratelist to see available IDs.`);
  }

  const record = replyBuffer.find(r => r.id === id);
  let msg = `✅ Rated <b>${rating.toUpperCase()}</b>`;
  if (reason) msg += ` — "${reason}"`;
  msg += `\n\nReply to ${record?.senderName || 'unknown'}: "${record?.mahirReply.slice(0, 100)}"`;
  if (record) {
    msg += `\n\n${rating === 'bad' ? '⚠️ Mahir ise yaad rakhega aur agli baar sudharne ki koshish karega.' : '👍 Acha! Mahir aise hi replies karta rahega.'}`;
  }

  return sendTelegramMessage(msg);
}

export async function handleFeedbackCommand(): Promise<boolean> {
  return sendTelegramMessage(getFeedbackStats());
}

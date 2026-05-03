import { config } from './config.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: string;
}

export async function sendTelegramMessage(text: string): Promise<boolean> {
  if (!config.isTelegramReady()) {
    console.log('Telegram not configured — message skipped');
    return false;
  }

  try {
    const url = `${TELEGRAM_API}${config.telegramBotToken}/sendMessage`;
    const body: TelegramMessage = {
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'HTML',
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Telegram API error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
    return false;
  }
}

export async function sendDailyDigest(stats: {
  totalMessages: number;
  uniqueContacts: number;
  topContacts: Array<{ name: string; count: number }>;
  importantHighlights: string[];
  date: string;
}): Promise<boolean> {
  const highlights = stats.importantHighlights.length > 0
    ? stats.importantHighlights.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : 'Koi khaas baat nahi aaj';

  const topContacts = stats.topContacts
    .slice(0, 5)
    .map((c, i) => `${i + 1}. ${c.name} — ${c.count} messages`)
    .join('\n');

  const message = `📱 <b>Mahir Daily Digest</b>
📅 ${stats.date}

<b>📊 Summary:</b>
• Total messages: ${stats.totalMessages}
• Unique contacts: ${stats.uniqueContacts}

<b>🔥 Top contacts:</b>
${topContacts}

<b>💡 Important highlights:</b>
${highlights}

— Mahir Abher 🤖`;

  return sendTelegramMessage(message);
}

export async function sendInstantAlert(
  senderName: string,
  message: string,
  reason: string
): Promise<boolean> {
  const text = `🚨 <b>Instant Alert</b>
<b>From:</b> ${senderName}
<b>Message:</b> ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}
<b>Reason:</b> ${reason}

— Mahir Abher`;

  return sendTelegramMessage(text);
}

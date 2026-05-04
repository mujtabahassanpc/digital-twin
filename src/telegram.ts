import { config } from './config.js';
import { getConversationHistory } from './db.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: string;
  reply_markup?: any;
}

export async function sendTelegramMessage(text: string, inlineKeyboard?: any[]): Promise<boolean> {
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

    if (inlineKeyboard) {
      body.reply_markup = { inline_keyboard: inlineKeyboard };
    }

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

export async function sendImportantConversationAlert(
  senderName: string,
  senderId: string,
  recentMessages: string
): Promise<boolean> {
  const text = `🔔 <b>Important Conversation Request</b>
<b>From:</b> ${senderName}
<b>Number:</b> ${senderId}
<b>Says:</b> "Acha bolbo"

<b>Recent context:</b>
${recentMessages}

⚡ Reply with: <code>/reply ${senderId} your_message</code>
Or use the button below to toggle busy mode.

— Mahir Abher`;

  const keyboard = [[
    { text: config.busyMode ? '⏸️ Turn OFF Auto-Reply' : '▶️ Turn ON Auto-Reply', callback_data: 'toggle_busy' },
  ]];

  return sendTelegramMessage(text, keyboard);
}

export async function sendStatusCommand(): Promise<boolean> {
  const { isConnected } = await import('./whatsapp.js');
  const message = `📊 <b>Mahir Status</b>
<b>WhatsApp:</b> ${isConnected() ? '✅ Connected' : '❌ Disconnected'}
<b>AI (Gemini):</b> ${config.isAiReady() ? '✅ Ready' : '❌ Not set'}
<b>Database:</b> ${config.isDbReady() ? '✅ Ready' : '❌ Not set'}
<b>Busy Mode:</b> ${config.busyMode ? '🟢 ON' : '🔴 OFF'}

— Mahir Abher`;

  return sendTelegramMessage(message);
}

export async function sendContactsCommand(limit: number = 10): Promise<boolean> {
  const { Pool } = await import('pg');
  try {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: false },
    });

    const result = await pool.query(
      `SELECT phone_number, name, message_count, last_active
       FROM contacts
       ORDER BY last_active DESC
       LIMIT $1`,
      [limit]
    );

    const list = result.rows.map((r, i) => {
      const timeAgo = getTimeAgo(r.last_active);
      return `${i + 1}. <b>${r.name || 'Unknown'}</b> (${r.phone_number})
   ${r.message_count} msgs • last: ${timeAgo}`;
    }).join('\n\n');

    await pool.end();

    const message = `👥 <b>Recent Contacts</b>\n\n${list || 'No contacts yet'}\n\n— Mahir Abher`;
    return sendTelegramMessage(message);
  } catch (error) {
    console.error('Contacts command error:', error);
    return sendTelegramMessage('❌ Failed to fetch contacts');
  }
}

export async function sendManualReply(senderId: string, message: string): Promise<boolean> {
  const { sendWhatsAppMessage } = await import('./whatsapp.js');
  try {
    await sendWhatsAppMessage(senderId, message);
    return sendTelegramMessage(`✅ Reply sent successfully\n\n<b>To:</b> ${senderId}\n<b>Message:</b> ${message.substring(0, 100)}\n\n— Mahir Abher`);
  } catch (error) {
    console.error('Manual reply error:', error);
    return sendTelegramMessage(`❌ Failed to send reply: ${error}`);
  }
}

function getTimeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

export async function handleTelegramCommand(command: string, args: string): Promise<boolean> {
  switch (command) {
    case 'start':
    case 'help':
      return sendTelegramMessage(`🤖 <b>Mahir Abher — Commands</b>

<b>/status</b> — Check all services
<b>/contacts [n]</b> — Recent contacts (default: 10)
<b>/busy on</b> — Enable auto-reply
<b>/busy off</b> — Disable auto-reply
<b>/reply [number] [msg]</b> — Send manual reply
<b>/digest</b> — Send today's summary
<b>/help</b> — Show this message

— Mahir Abher`);

    case 'status':
      return sendStatusCommand();

    case 'contacts':
      const limit = parseInt(args) || 10;
      return sendContactsCommand(limit);

    case 'busy':
      if (args === 'on') {
        config.busyMode = true;
        return sendTelegramMessage('🟢 Busy mode ON — Mahir will auto-reply');
      }
      if (args === 'off') {
        config.busyMode = false;
        return sendTelegramMessage('🔴 Busy mode OFF — No auto-replies');
      }
      return sendTelegramMessage(`Current: ${config.busyMode ? '🟢 ON' : '🔴 OFF'}\nUse /busy on or /busy off`);

    case 'reply':
      const parts = args.split(' ');
      if (parts.length < 2) {
        return sendTelegramMessage('Usage: <code>/reply 919876543210 your message here</code>');
      }
      const targetNumber = parts[0];
      const replyMessage = parts.slice(1).join(' ');
      return sendManualReply(targetNumber, replyMessage);

    case 'digest':
      const { sendDailyDigest } = await import('./telegram.js');
      const { Pool } = await import('pg');
      try {
        const pool = new Pool({
          connectionString: config.databaseUrl,
          ssl: { rejectUnauthorized: false },
        });
        const today = new Date().toISOString().split('T')[0];
        const totalResult = await pool.query(`SELECT COUNT(*) FROM conversations WHERE DATE(timestamp) = $1`, [today]);
        const contactsResult = await pool.query(`SELECT sender_name, COUNT(*) as count FROM conversations WHERE DATE(timestamp) = $1 GROUP BY sender_name ORDER BY count DESC LIMIT 5`, [today]);
        const importantResult = await pool.query(`SELECT sender_name, content FROM conversations WHERE DATE(timestamp) = $1 AND LENGTH(content) > 50 AND message_type = 'incoming' ORDER BY timestamp DESC LIMIT 5`, [today]);
        await pool.end();

        return sendDailyDigest({
          totalMessages: parseInt(totalResult.rows[0].count),
          uniqueContacts: contactsResult.rows.length,
          topContacts: contactsResult.rows.map((r: any) => ({ name: r.sender_name || 'Unknown', count: parseInt(r.count) })),
          importantHighlights: importantResult.rows.map((r: any) => `${r.sender_name || 'Unknown'}: ${r.content.substring(0, 100)}`),
          date: new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        });
      } catch (error) {
        return sendTelegramMessage('❌ Failed to generate digest');
      }

    default:
      return sendTelegramMessage(`❓ Unknown command: <code>/${command}</code>\nUse /help for available commands`);
  }
}

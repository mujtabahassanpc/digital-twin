import { config } from './config.js';
import { getConversationHistory } from './db.js';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPath = path.join(__dirname, '..', 'data', 'context.md');
const contactsPath = path.join(__dirname, '..', 'data', 'contacts.json');
const languageExamplesPath = path.join(__dirname, '..', 'data', 'language_examples.json');

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

export async function sendConfusionAlert(
  senderName: string,
  senderId: string,
  userMessage: string,
  history: any[]
): Promise<boolean> {
  const recentContext = history.slice(-4).map((h: any) => `${h.role === 'user' ? '👤' : '🤖'} ${h.content}`).join('\n');

  const text = `🤔 <b>Mahir is Confused!</b>
<b>From:</b> ${senderName} (${senderId})
<b>User said:</b> "${userMessage}"

<b>Recent context:</b>
${recentContext || 'No recent history'}

Mahir ne user se kaha: "bhai me samja nhi, ek baar phir se bolna?"

⚡ Tu mujhe bata kya reply dena hai:
<code>/reply ${senderId} your_response</code>

Ya phir /context file me instruction add kar de jisse Mahir agli baar samajh jaye.

— Mahir Abher`;

  return sendTelegramMessage(text);
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

<b>🔧 Status:</b>
<b>/status</b> — Check all services
<b>/busy on</b> — Enable auto-reply
<b>/busy off</b> — Disable auto-reply
<b>/digest</b> — Send today's summary

<b>🧠 Teach Mahir Language:</b>
<b>/teach [message] | [reason]</b> — Add a language example with reason
  Example: /teach "acha thik hai" | jab conversation end karni ho, short acknowledgment dena
<b>/teachbulk [msg1 > reason1 :: msg2 > reason2]</b> — Add multiple examples at once
<b>/lang [n]</b> — View last n language examples (default: 10)
<b>/forgetlang [index]</b> — Remove a language example by index
<b>/clearlang</b> — Remove all language examples

<b>👤 Context & Memory:</b>
<b>/mujtaba [status]</b> — Set Mujtaba's status (busy/available/school/office/sleeping/eating/driving/meeting/travelling)
<b>/context [text]</b> — Add custom context instruction
<b>/contacts</b> — View saved contact memories
<b>/forget [senderId]</b> — Clear contact memory for a person

<b>💬 Reply:</b>
<b>/reply [number] [msg]</b> — Send manual reply

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

    case 'mujtaba': {
      const status = args.toLowerCase().trim();
      const statusMessages: Record<string, string> = {
        busy: 'Mujtaba kaam me busy hai. Available nahi hai abhi. Jab free hoga reply karega.',
        available: 'Mujtaba available hai. Reply kar sakta hai.',
        school: 'Mujtaba school gaya hai. Wapas aake reply karega.',
        office: 'Mujtaba office me hai. Kaam khatam hone ke baad reply karega.',
        sleeping: 'Mujtaba so raha hai. Subah reply karega.',
        eating: 'Mujtaba khaana kha raha hai. Thodi der me reply karega.',
        driving: 'Mujtaba drive kar raha hai. Safe pohoch ke reply karega.',
        meeting: 'Mujtaba meeting me hai. Meeting khatam hone ke baad reply karega.',
        travelling: 'Mujtaba travel kar raha hai. Pohoch ke reply karega.',
      };

      let statusText = statusMessages[status];
      if (!statusText) {
        statusText = `Mujtaba ${args}. Reply karega jab free hoga.`;
      }

      const contextContent = `# Mahir — Current Context

## Mujtaba ka Current Status
- **Status:** ${status}
- **Details:** ${statusText}
- **Last updated:** ${new Date().toISOString().split('T')[0]}

## Current Instructions
- Agar koi Mujtaba se mile toh bolna: "${statusText}"
- Agar koi urgent hai toh bolna: "Mujtaba ko bol dunga, reply karega jab free hoga"
- Agar koi general chat kar raha hai toh friendly reply dena

## Special Instructions for Specific Contacts
(N/A — koi special instruction nahi hai abhi)

## Notes
- Ye file Mujtaba Telegram se update kar sakta hai
- Status change karna ho toh /status busy ya /status available use karein
- Special instruction add karna ho toh /context <instruction> use karein
`;

      try {
        fs.writeFileSync(contextPath, contextContent, 'utf-8');
        return sendTelegramMessage(`✅ Mujtaba's status set to: *${status}*\n\n"${statusText}"\n\nMahir ab ye context use karega.`);
      } catch (err) {
        return sendTelegramMessage('❌ Failed to update context file');
      }
    }

    case 'context': {
      if (!args.trim()) {
        try {
          const current = fs.readFileSync(contextPath, 'utf-8');
          return sendTelegramMessage(`📋 *Current Context:*\n\n\`\`\`\n${current.substring(0, 1000)}\n\`\`\``);
        } catch {
          return sendTelegramMessage('📋 Context file not found');
        }
      }

      try {
        const current = fs.readFileSync(contextPath, 'utf-8');
        const updated = current.replace(
          /(## Special Instructions for Specific Contacts\n).*/,
          `$1\n- ${args}\n\n_Last updated: ${new Date().toISOString()}_\n`
        );
        fs.writeFileSync(contextPath, updated, 'utf-8');
        return sendTelegramMessage(`✅ Context updated:\n\n"${args}"`);
      } catch {
        return sendTelegramMessage('❌ Failed to update context');
      }
    }

    case 'contacts': {
      try {
        const data = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
        const contacts = Object.entries(data.contacts || {});
        if (contacts.length === 0) {
          return sendTelegramMessage('📋 Koi saved contact nahi hai abhi');
        }

        const list = contacts.slice(-10).map(([id, info]: [string, any]) => {
          const name = info.name || 'Unknown';
          const topic = info.last_topic || 'N/A';
          const count = info.conversation_count || 0;
          const last = info.last_message_summary || '';
          return `• *${name}* (${id})\n  Topic: ${topic} | Chats: ${count}\n  Last: "${last.substring(0, 50)}..."`;
        }).join('\n\n');

        return sendTelegramMessage(`📋 *Saved Contacts:* (${contacts.length} total)\n\n${list}`);
      } catch {
        return sendTelegramMessage('📋 Contacts file not found');
      }
    }

    case 'forget': {
      if (!args.trim()) {
        return sendTelegramMessage('Usage: /forget <senderId>');
      }
      try {
        const data = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
        if (data.contacts[args]) {
          delete data.contacts[args];
          data.last_updated = new Date().toISOString();
          fs.writeFileSync(contactsPath, JSON.stringify(data, null, 2));
          return sendTelegramMessage(`✅ Forgotten contact: ${args}`);
        }
        return sendTelegramMessage(`❌ Contact not found: ${args}`);
      } catch {
        return sendTelegramMessage('❌ Failed to forget contact');
      }
    }

    case 'teach': {
      // Format: /teach "message" | reason
      // Or: /teach message | reason
      const pipeIndex = args.indexOf('|');
      if (pipeIndex === -1) {
        return sendTelegramMessage('Usage: /teach "message" | reason\n\nExample: /teach "acha thik hai" | jab conversation end karni ho, short acknowledgment dena');
      }

      const message = args.substring(0, pipeIndex).trim().replace(/^["']|["']$/g, '');
      const reason = args.substring(pipeIndex + 1).trim();

      if (!message || !reason) {
        return sendTelegramMessage('Message aur reason dono chahiye.\nUsage: /teach "message" | reason');
      }

      try {
        const data = JSON.parse(fs.readFileSync(languageExamplesPath, 'utf-8'));
        data.examples.push({
          message,
          reason,
          added_at: new Date().toISOString(),
        });
        data.last_updated = new Date().toISOString();
        fs.writeFileSync(languageExamplesPath, JSON.stringify(data, null, 2));

        return sendTelegramMessage(`✅ Language example added (#${data.examples.length}):\n\n💬 Message: "${message}"\n📝 Reason: ${reason}\n\nMahir ab ye example use karega.`);
      } catch (err: any) {
        return sendTelegramMessage(`❌ Failed to add example: ${err.message}`);
      }
    }

    case 'teachbulk': {
      // Format: /teachbulk "msg1" > reason1 :: "msg2" > reason2
      if (!args.trim()) {
        return sendTelegramMessage('Usage: /teachbulk "msg1" > reason1 :: "msg2" > reason2');
      }

      const entries = args.split('::').map(s => s.trim()).filter(s => s.length > 0);
      const newExamples: any[] = [];

      for (const entry of entries) {
        const arrowIndex = entry.indexOf('>');
        if (arrowIndex === -1) continue;

        const message = entry.substring(0, arrowIndex).trim().replace(/^["']|["']$/g, '');
        const reason = entry.substring(arrowIndex + 1).trim();

        if (message && reason) {
          newExamples.push({
            message,
            reason,
            added_at: new Date().toISOString(),
          });
        }
      }

      if (newExamples.length === 0) {
        return sendTelegramMessage('Koi valid example nahi mili. Format: "msg" > reason :: "msg2" > reason2');
      }

      try {
        const data = JSON.parse(fs.readFileSync(languageExamplesPath, 'utf-8'));
        for (const ex of newExamples) {
          data.examples.push(ex);
        }
        data.last_updated = new Date().toISOString();
        fs.writeFileSync(languageExamplesPath, JSON.stringify(data, null, 2));

        const list = newExamples.map((ex, i) => `${i + 1}. "${ex.message}" — ${ex.reason}`).join('\n');
        return sendTelegramMessage(`✅ ${newExamples.length} examples added (total: ${data.examples.length}):\n\n${list}`);
      } catch (err: any) {
        return sendTelegramMessage(`❌ Failed to add examples: ${err.message}`);
      }
    }

    case 'lang': {
      const limit = parseInt(args) || 10;
      try {
        const data = JSON.parse(fs.readFileSync(languageExamplesPath, 'utf-8'));
        const examples = data.examples || [];

        if (examples.length === 0) {
          return sendTelegramMessage('📋 Koi language example nahi hai abhi.\n\nUse /teach "message" | reason to add.');
        }

        const recent = examples.slice(-limit);
        const list = recent.map((ex: any, i: number) => {
          const globalIndex = examples.length - limit + i + 1;
          return `*#${globalIndex}* "${ex.message}"\n   → ${ex.reason}`;
        }).join('\n\n');

        return sendTelegramMessage(`📋 *Language Examples* (${examples.length} total, showing last ${limit}):\n\n${list}`);
      } catch {
        return sendTelegramMessage('📋 Language examples file not found');
      }
    }

    case 'forgetlang': {
      const index = parseInt(args) - 1; // 1-based index
      if (isNaN(index)) {
        return sendTelegramMessage('Usage: /forgetlang <index>\n\nUse /lang to see indices.');
      }

      try {
        const data = JSON.parse(fs.readFileSync(languageExamplesPath, 'utf-8'));
        const examples = data.examples || [];

        if (index < 0 || index >= examples.length) {
          return sendTelegramMessage(`❌ Index ${index + 1} out of range. Total: ${examples.length}`);
        }

        const removed = examples.splice(index, 1)[0];
        data.last_updated = new Date().toISOString();
        fs.writeFileSync(languageExamplesPath, JSON.stringify(data, null, 2));

        return sendTelegramMessage(`✅ Removed example:\n\n"${removed.message}" → ${removed.reason}`);
      } catch {
        return sendTelegramMessage('❌ Failed to remove example');
      }
    }

    case 'clearlang': {
      try {
        fs.writeFileSync(languageExamplesPath, JSON.stringify({ examples: [], last_updated: new Date().toISOString() }, null, 2));
        return sendTelegramMessage('✅ All language examples cleared.');
      } catch {
        return sendTelegramMessage('❌ Failed to clear examples');
      }
    }

    default:
      return sendTelegramMessage(`❓ Unknown command: <code>/${command}</code>\nUse /help for available commands`);
  }
}

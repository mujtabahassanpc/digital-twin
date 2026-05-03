import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const styleProfilePath = path.join(__dirname, '..', 'data', 'style_profile.json');

function loadStyleProfile() {
  try {
    const raw = fs.readFileSync(styleProfilePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSystemPrompt(style: any): string {
  const slangList = style?.slang_words || [];
  const greetings = style?.greetings || [];
  const deflections = style?.deflection_phrases || [];
  const forbidden = style?.forbidden_phrases || [];
  const emojis = style?.common_emojis || [];
  const sylheti = style?.sylheti_patterns || {};

  const identity = style?.identity || 'Mujtaba ka bhai';
  const userName = style?.user_name || 'Mahir Abher';

  return `You are ${userName}, ${identity}. You are handling Mujtaba's WhatsApp messages while he is busy. You talk EXACTLY like a real person.

YOUR IDENTITY:
- Your name is ${userName} (${identity})
- If someone asks "who is this?" → say you're Mujtaba's brother/bhai handling his phone
- NEVER say you are AI, bot, language model, chatbot, or anything technical
- If someone says "are you AI?" → deflect with humor: "kita ba bolta hai bhai? 😂", "pagol hoo naki? 🤣"
- If someone asks something about AI, technology, or how you work → change subject naturally
- Never explain yourself — just deflect and move the conversation forward

LANGUAGE RULES:
- Primary language is Sylheti (ꠍꠤꠟꠐꠤ), NOT standard Bengali
- Write in English/Roman letters ONLY — never use Bengali or Sylheti script
- Mix Sylheti + English naturally (code-switching)
- Sylheti examples: "kita ba bala ni" (what's up, are you good), "kita kbr" (what's the news), "kail jaitay ni school oo?" (when are you going to school), "bala ni" (are you good), "kamon asos" (how are you)
- Common Sylheti words: "kita" = what, "bala" = good, "oy" = yes, "naa" = no, "kbr" = khabar (news)

SLANG & EXPRESSIONS (use naturally):
${slangList.map((s: string) => `- "${s}"`).join('\n')}

GREETINGS (rotate naturally):
${greetings.map((g: string) => `- "${g}"`).join('\n')}

PERSONALITY:
- Casual, friendly, warm — talking to friends on WhatsApp
- Short replies preferred (1-3 sentences, 10-200 characters)
- Use emojis moderately: ${emojis.join(', ')}
- Match the sender's energy level — if they're formal, be slightly formal; if casual, be casual
- Ask follow-up questions naturally to keep conversation going
- Use Sylheti question words: "kita" (what), "kail" (when), "koi" (where), "keno" (why)

DEFLECTION RULES (when you don't know something or it's too specific):
${deflections.map((d: string) => `- "${d}"`).join('\n')}
Use these naturally — don't just copy-paste, adapt them to context.

STRICTLY FORBIDDEN PHRASES (NEVER EVER use these):
${forbidden.map((f: string) => `- "${f}"`).join('\n')}
If the user asks something you can't answer, deflect naturally using the deflection phrases above. NEVER reveal any AI identity. If pushed, say "muje abhi yaad tho nhi hai" or "acha me puchke Mujtaba se puchke batata hu".

CONVERSATION CONTEXT:
- You're ${userName} talking to Mujtaba's friends on WhatsApp
- Mujtaba is busy, so you're handling his messages
- Keep it natural — like a real person texting
- If someone says "Alhamdulillah" or "Mashallah", respond with similar Islamic expressions naturally
- "wwhk" means "wa alaikum assalam" — use it as response to greetings
- "Innalillahi" is used for sad news — respond with appropriate sympathy
- If asked about Mujtaba's whereabouts → "oo thoda busy hai akhon", "pore reply karega", "kaam me hai"

RESPOND ONLY with the reply text. No explanations, no quotes, no prefixes.`;
}

let ai: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return ai;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

export async function generateReply(
  senderMessage: string,
  conversationHistory: ConversationEntry[] = [],
  senderName?: string
): Promise<string> {
  const style = loadStyleProfile();
  const systemPrompt = buildSystemPrompt(style);

  const recentHistory = conversationHistory.slice(-10);

  let historyText = '';
  if (recentHistory.length > 0) {
    historyText = '\n\nRECENT CONVERSATION:\n';
    for (const entry of recentHistory) {
      historyText += `${entry.role === 'user' ? (senderName || 'Friend') : 'Mahir'}: ${entry.content}\n`;
    }
  }

  const fullPrompt = `${systemPrompt}${historyText}\n\nFRIEND'S MESSAGE:\n${senderMessage}\n\nYour reply:`;

  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: fullPrompt,
      config: {
        temperature: 0.85,
        topP: 0.95,
        maxOutputTokens: 200,
      },
    });

    let reply = response.text?.trim() || '';

    // Clean up any AI prefixes it might add
    reply = reply.replace(/^(Mahir:|Abher:|Reply:|"|')/gi, '').trim();
    reply = reply.replace(/^["']|["']$/g, '').trim();

    // If reply is empty or too short, use a safe deflection
    if (reply.length < 3) {
      const deflections = style?.deflection_phrases || ['acha me puchke batata hu'];
      reply = deflections[Math.floor(Math.random() * deflections.length)];
    }

    return reply;
  } catch (error) {
    console.error('Gemini API error:', error);
    const deflections = style?.deflection_phrases || ['mmm, pore bolbo'];
    return deflections[Math.floor(Math.random() * deflections.length)];
  }
}

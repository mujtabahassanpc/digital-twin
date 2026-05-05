import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidePath = path.join(__dirname, '..', 'data', 'ai_guide.md');

// Per-sender reply tracking
const recentReplies: Record<string, string[]> = {};

// Provider cooldown timers
const providerCooldowns: Record<string, number> = {
  gemini: 0,
  mistral: 0,
  groq: 0,
  openrouter: 0,
  deepseek: 0,
};

// Whether we've sent the exhausted message to each sender
const exhaustedMessagesSent: Record<string, boolean> = {};

function loadGuide(): string {
  try {
    return fs.readFileSync(guidePath, 'utf-8');
  } catch {
    return '';
  }
}

// ============================================================
// API PROVIDERS — each returns text or throws
// ============================================================

async function callGemini(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getGeminiKeys();
  if (keys.length === 0) throw new Error('No Gemini keys');

  const ai = new GoogleGenAI({ apiKey: keys[0] });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `${systemPrompt}\n\nUser: ${userMessage}\n\nReply:`,
    config: { temperature: 0.85, topP: 0.9, maxOutputTokens: 500 },
  });
  return response.text?.trim() || '';
}

async function callMistral(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getMistralKeys();
  if (keys.length === 0) throw new Error('No Mistral keys');

  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys[0]}` },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.85,
      top_p: 0.9,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mistral ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGroq(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getGroqKeys();
  if (keys.length === 0) throw new Error('No Groq keys');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys[0]}` },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.85,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callOpenRouter(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getOpenRouterKeys();
  if (keys.length === 0) throw new Error('No OpenRouter keys');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${keys[0]}`,
      'HTTP-Referer': 'https://digital-twin.onrender.com',
      'X-Title': 'Mahir Digital Twin',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.85,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callDeepSeek(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getDeepSeekKeys();
  if (keys.length === 0) throw new Error('No DeepSeek keys');

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys[0]}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.85,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ============================================================
// PROVIDER REGISTRY — tries each in order, skips cooldowned
// ============================================================

interface Provider {
  name: string;
  call: (system: string, user: string) => Promise<string>;
}

const providers: Provider[] = [
  { name: 'gemini', call: callGemini },
  { name: 'mistral', call: callMistral },
  { name: 'groq', call: callGroq },
  { name: 'openrouter', call: callOpenRouter },
  { name: 'deepseek', call: callDeepSeek },
];

function isProviderAvailable(name: string): boolean {
  switch (name) {
    case 'gemini': return config.getGeminiKeys().length > 0;
    case 'mistral': return config.getMistralKeys().length > 0;
    case 'groq': return config.getGroqKeys().length > 0;
    case 'openrouter': return config.getOpenRouterKeys().length > 0;
    case 'deepseek': return config.getDeepSeekKeys().length > 0;
    default: return false;
  }
}

function isProviderOnCooldown(name: string): boolean {
  return Date.now() < providerCooldowns[name];
}

function setProviderCooldown(name: string) {
  providerCooldowns[name] = Date.now() + 300_000; // 5 min
  console.log(`⏳ ${name} on cooldown for 5 min`);
}

function is429Error(err: any): boolean {
  const msg = err?.message || '';
  return msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate_limit');
}

// ============================================================
// CLEAN UP AI RESPONSE
// ============================================================

function cleanReply(text: string): string {
  let reply = text.trim();
  reply = reply.replace(/^(Mahir:|Abher:|Reply:|AI:|Assistant:)/gi, '').trim();
  reply = reply.replace(/^["']|["']$/g, '').trim();
  return reply;
}

// ============================================================
// CONTEXTUAL FALLBACK — when ALL providers exhausted
// This is the ONE const message DeepSeek suggested
// ============================================================

const EXHAUSTED_MESSAGE = 'Ami akhon ektu busy achi, ektu pore kotha bolte paren. 🥲';

// For emoji-only or very short user messages when exhausted
const EXHAUSTED_SHORT = '🥲'

function getExhaustedReply(userMessage: string): { text: string; metadata: ReplyMetadata } {
  // If user sent only emoji or very short, reply with just emoji
  const trimmed = userMessage.trim();
  if (trimmed.length <= 2 || /^[\p{Emoji}\s]+$/u.test(trimmed)) {
    return {
      text: EXHAUSTED_SHORT,
      metadata: { typingDelay: 1000, isImportant: false },
    };
  }

  return {
    text: EXHAUSTED_MESSAGE,
    metadata: { typingDelay: 2000, isImportant: false },
  };
}

// ============================================================
// CONTEXT-AWARE SMART REPLIES (when API is down)
// These are NOT random — they respond to what the user said
// ============================================================

function getSmartFallback(userMessage: string, senderId: string): { text: string; metadata: ReplyMetadata } | null {
  const lower = userMessage.toLowerCase().trim();

  // Only use smart fallbacks if user asked a direct question or made a statement
  // NOT for greetings or general chat

  // If user asks "who are you?" or "k tumi?"
  if (/k.*tumi|who.*are|kaun.*ho|kon.*jon|name.*kita/.test(lower)) {
    return {
      text: 'ami Mujtaba er bhai, Mahir. Oo busy hai isliye ami reply disi.',
      metadata: { typingDelay: 2500, isImportant: false },
    };
  }

  // If user asks to call
  if (/call.*utao|call.*koro|pick.*call|phone.*koro/.test(lower)) {
    return {
      text: 'call pari na akhon, text e bolba. Mujtaba ke bolbo call korte. 🥲',
      metadata: { typingDelay: 2500, isImportant: true },
    };
  }

  // If user is angry or frustrated
  if (/😡|🖕|durr|pagol|stupid|idiot|bakas|faltu/.test(lower)) {
    return {
      text: 'sorry bhai, ekta message ao na, ami Mujtaba ke dibo. 🙏',
      metadata: { typingDelay: 2000, isImportant: true },
    };
  }

  // If user says bye or going
  if (/bye|jaite|jao|goodbye|tata|byee/.test(lower)) {
    return {
      text: 'acha ja, pore kotha hobe! Mujtaba ke bolbo. 👋',
      metadata: { typingDelay: 1500, isImportant: false },
    };
  }

  // If user asks about language
  if (/language|bhasha|kijatir.*language|which.*language/.test(lower)) {
    return {
      text: 'Sylheti bhasha re ba, amader local language. 😊',
      metadata: { typingDelay: 2000, isImportant: false },
    };
  }

  // If user asks "kita oise" (what happened)
  if (/kita.*oise|ki.*hoyeche|what.*happened/.test(lower)) {
    return {
      text: 'kuch khaas nahi, Mujtaba busy hai akhon. Pore baat karega. 😊',
      metadata: { typingDelay: 2000, isImportant: false },
    };
  }

  // If user asks for blocking
  if (/block.*kri|block.*kar/.test(lower)) {
    return {
      text: 'block korba na bhai, Mujtaba ke bolbo tumar message. 🥲',
      metadata: { typingDelay: 2000, isImportant: true },
    };
  }

  // Don't return smart fallback for greetings, emojis-only, or general chat
  // Those will get the exhausted message instead
  return null;
}

// ============================================================
// MAIN REPLY GENERATION
// ============================================================

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface ReplyMetadata {
  typingDelay: number;
  isImportant: boolean;
}

export async function generateReply(
  senderMessage: string,
  conversationHistory: ConversationEntry[] = [],
  senderName?: string,
  senderId?: string
): Promise<{ text: string; metadata: ReplyMetadata }> {
  const guide = loadGuide();
  const timeContext = getTimeContext();

  // Build system prompt from guide
  const systemPrompt = buildSystemPrompt(guide, timeContext, conversationHistory, senderName);

  // Check if ALL providers are on cooldown
  const availableProviders = providers.filter(p => isProviderAvailable(p.name) && !isProviderOnCooldown(p.name));

  if (availableProviders.length === 0) {
    // Check if we already sent the exhausted message to this sender
    const alreadySent = exhaustedMessagesSent[senderId || 'unknown'];

    if (alreadySent) {
      // Don't spam — just return empty (no reply)
      console.log('⏳ Already sent exhausted message to this sender — skipping');
      return { text: '', metadata: { typingDelay: 0, isImportant: false } };
    }

    // First time exhausted — send const message ONCE
    console.log('⚠️ ALL providers exhausted — sending const message ONCE');
    exhaustedMessagesSent[senderId || 'unknown'] = true;

    // Try smart contextual reply first
    const smartReply = getSmartFallback(senderMessage, senderId || '');
    if (smartReply) {
      console.log('🧠 Using smart contextual fallback');
      return smartReply;
    }

    return getExhaustedReply(senderMessage);
  }

  // Reset exhausted flag when providers are available again
  exhaustedMessagesSent[senderId || 'unknown'] = false;

  // Try each available provider in order
  for (const provider of availableProviders) {
    try {
      console.log(`🚀 Trying ${provider.name}...`);
      const reply = await provider.call(systemPrompt, senderMessage);
      const cleaned = cleanReply(reply);

      if (cleaned.length > 0) {
        trackReply(senderId, cleaned);
        console.log(`✅ ${provider.name} reply: ${cleaned.slice(0, 50)}...`);

        return {
          text: cleaned,
          metadata: {
            typingDelay: getTypingDelay(cleaned.length),
            isImportant: isImportantMessage(senderMessage),
          },
        };
      }
    } catch (err: any) {
      if (is429Error(err)) {
        console.log(`🔑 ${provider.name} 429 — moving to next provider`);
        setProviderCooldown(provider.name);
      } else {
        console.log(`❌ ${provider.name} error: ${err.message}`);
        setProviderCooldown(provider.name);
      }
    }
  }

  // All providers failed in this round — try smart fallback or exhausted message
  const smartReply = getSmartFallback(senderMessage, senderId || '');
  if (smartReply) return smartReply;

  return getExhaustedReply(senderMessage);
}

// ============================================================
// SYSTEM PROMPT BUILDER
// ============================================================

function buildSystemPrompt(
  guide: string,
  timeContext: string,
  conversationHistory: ConversationEntry[],
  senderName?: string
): string {
  const basePrompt = `You are Mahir Abher. You are Mujtaba's younger brother handling his WhatsApp messages when he's busy.

CORE IDENTITY:
- You are NOT an AI, NOT a bot, NOT an assistant. You are Mahir, a real Sylheti young man.
- You speak in Romanized Sylheti (no Bengali script) mixed with some Hindi and English
- You are warm, casual, friendly, sometimes playful/teasing
- You reply like a real person texting on WhatsApp — short messages, natural flow

RESPONSE RULES:
1. Reply ONLY with the message text — no explanations, no quotes, no prefixes
2. NEVER say you are an AI, bot, or assistant
3. NEVER use corporate language ("I hope this finds you well", "Certainly", etc.)
4. ALWAYS respond contextually to what the person actually said
5. If they ask who you are: "ami Mujtaba er bhai, Mahir. Oo busy hai isliye ami reply disi."
6. If they ask for Mujtaba to call: "call pari na akhon, text e bolba"
7. If they seem confused about the language: "Sylheti bhasha re ba, amader local language"
8. If they seem angry or frustrated: be apologetic, say you'll tell Mujtaba
9. Match their energy and language style
10. Keep replies natural — 1-3 short sentences, like real WhatsApp messages
11. Use emojis sparingly (0-2 per message)
12. NEVER repeat the same reply you just gave

TIME CONTEXT: It is currently ${timeContext}. Adjust your greeting accordingly.
${senderName ? `You are talking to: ${senderName}` : ''}

CONVERSATION STYLE EXAMPLES (from real Sylheti WhatsApp chats):
- "hmm fora ssh ni" (short acknowledgment)
- "aasi but computer oo🤗" (casual update)
- "na akn kichchu kaj nai" (simple status)
- "oo acha😊" (warm acknowledgment)
- "achi bala ni?" (asking about wellbeing)
- "oy, kamon asos?" (casual greeting)
- "amr dimag oo slr na" (expressing frustration)
- "inshallah" (religious response)
- "astagfirullah" (surprise/shock)
- "🤨nani mara gsoin koilay r akn kita koitraay" (playful teasing)
- "Eh" / "Mm" / "Oo" / "Acha" (very short responses for simple messages)

CRITICAL: Read the user's message carefully and respond to WHAT THEY SAID, not with a generic greeting.
If they ask a question, answer it. If they share news, react to it. If they're emotional, match their energy.
If you don't understand something, say "ami bujhi nai, ektu poriskar kore bolba" (I didn't understand, please clarify).

NEVER use these canned/repetitive phrases:
- "kita kbr?" (unless it's actually a greeting)
- "kamon asos?" (unless it's actually a greeting)
- "haan bol, muji shuni ase" (too repetitive)
- "acha achi kotha bol" (sounds robotic)
- "sab thik hai?" (don't repeat)
- "oy, bala ni?" (don't repeat)

${guide ? `BEHAVIORAL GUIDE (follow this):\n${guide}` : ''}`;

  // Add conversation context if available
  if (conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-6);
    let historyText = '\n\nRECENT CONVERSATION:\n';
    for (const entry of recent) {
      historyText += `${entry.role === 'user' ? (senderName || 'Friend') : 'Mahir'}: ${entry.content}\n`;
    }
    return basePrompt + historyText;
  }

  return basePrompt;
}

// ============================================================
// UTILITIES
// ============================================================

function getTimeContext(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning (subah)';
  if (hour >= 12 && hour < 17) return 'afternoon (dopahar)';
  if (hour >= 17 && hour < 21) return 'evening (shaam)';
  return 'night (raat)';
}

function getTypingDelay(messageLength: number): number {
  const base = Math.max(800, Math.min(6000, messageLength * 60));
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

function isImportantMessage(text: string): boolean {
  const lower = text.toLowerCase();
  const importantKeywords = ['urgent', 'emergency', 'help', 'call', 'important', 'personal', 'family', 'medical', 'paisa', 'money', 'acha bolbo', 'block', 'problem'];
  return importantKeywords.some(kw => lower.includes(kw));
}

function trackReply(senderId: string | undefined, reply: string) {
  const key = senderId || 'unknown';
  if (!recentReplies[key]) recentReplies[key] = [];
  recentReplies[key].push(reply);
  if (recentReplies[key].length > 15) recentReplies[key] = recentReplies[key].slice(-15);
}

export { loadGuide };

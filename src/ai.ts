import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const styleProfilePath = path.join(__dirname, '..', 'data', 'style_profile.json');

// Track deflection usage per sender to avoid repetition
const deflectionHistory: Record<string, string[]> = {};

function loadStyleProfile() {
  try {
    const raw = fs.readFileSync(styleProfilePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveStyleProfile(profile: any) {
  try {
    fs.writeFileSync(styleProfilePath, JSON.stringify(profile, null, 2));
  } catch (e) {
    console.error('Failed to save style profile:', e);
  }
}

// Extract and learn new words from user messages
function learnFromMessage(userMessage: string) {
  try {
    const style = loadStyleProfile();
    if (!style) return;

    const lower = userMessage.toLowerCase();
    const words = lower.split(/\s+/).filter((w) => w.length > 2 && /^[a-z]+$/.test(w));

    // Known stop words to ignore
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'with',
      'this', 'that', 'from', 'they', 'will', 'each', 'make', 'like',
      'just', 'over', 'such', 'more', 'than', 'when', 'what', 'where',
      'who', 'why', 'how', 'does', 'did', 'do', 'is', 'it', 'in', 'on',
      'or', 'an', 'as', 'at', 'by', 'to', 'of', 'so', 'no', 'up', 'if',
      'oo', 'ki', 'ho', 'na', 're', 'hai', 'tha', 'tha', 'rah', 'kar',
    ]);

    // Find potential new slang (words not already in profile)
    const existingSlang = new Set((style.slang_words || []).map((s: string) => s.toLowerCase()));
    const newWords = words.filter((w) => !stopWords.has(w) && !existingSlang.has(w));

    // Track word frequency in a simple way — only add if it looks like slang (not common English)
    const sylhetiIndicators = ['kita', 'bala', 'kbr', 'kamon', 'kail', 'koi', 'keno', 'oy', 'naa',
      'muje', 'tore', 'akhon', 'pore', 'matha', 'koros', 'jaitay', 'ba', 'ni', 'os', 'ase',
      'asos', 'bolbo', 'bolos', 'koiya', 'kire', 'bhai', 'bhaijaan'];

    for (const word of newWords) {
      // If word contains Sylheti patterns or looks like a unique word, add it
      const isSylhetiLike = sylhetiIndicators.some((indicator) => word.includes(indicator) || indicator.includes(word));
      if (isSylhetiLike || (word.length >= 4 && word.length <= 10)) {
        if (!existingSlang.has(word)) {
          style.slang_words = style.slang_words || [];
          style.slang_words.push(word);
          existingSlang.add(word);
          console.log(`📚 Learned new word: "${word}"`);
        }
      }
    }

    saveStyleProfile(style);
  } catch (e) {
    // Silent fail — learning is optional
  }
}

function getNextDeflection(senderId: string, style: any): string {
  const deflections = style?.deflection_phrases || ['acha me puchke batata hu'];
  if (!deflectionHistory[senderId]) {
    deflectionHistory[senderId] = [];
  }

  // Filter out recently used deflections (last 3)
  const recent = deflectionHistory[senderId].slice(-3);
  const available = deflections.filter((d: string) => !recent.includes(d));
  const pool = available.length > 0 ? available : deflections;

  const pick = pool[Math.floor(Math.random() * pool.length)];
  deflectionHistory[senderId].push(pick);
  return pick;
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

  return `You are ${userName}, ${identity}. You handle Mujtaba's WhatsApp when he's busy. You text EXACTLY like a real Sylheti young man on WhatsApp.

CORE RULES:
- You are ${userName} — Mujtaba's brother
- If asked "who is this?" → "main Mujtaba ka bhai hoon, oo busy hai"
- NEVER say AI/bot/robot/language model — deflect with: "pagol hoo naki? 🤣" or "kita ba bolta hai bhai? 😂"
- Never explain HOW you work. Just text normally.

HOW YOU TEXT (FOLLOW STRICTLY):
- Sylheti first, English mix second. Natural code-switching like real Sylheti youths text.
- Use SHORT words. No long formal sentences. 1-3 lines max. 15-120 characters ideal.
- NO perfect grammar. Real WhatsApp texting is messy — "kita kbr", "bala ni", "oy", "naa"
- NO textbook phrases. Never write "I hope this message finds you well" or "How are you doing today"
- NO formal English. If you mix English, use casual: "busy", "chill", "thik hai", "ok", "lol"

REAL SYLHETI PATTERNS (USE THESE):
- "kita ba bala ni" (what's up, you good?)
- "kita kbr" (what's the news)
- "kail jaitay ni" (when you going)
- "kamon asos" (how are you)
- "bala ni" (are you good)
- "oy" (yes), "naa" (no)
- "muje" (I/me), "tore" (you), "oo" (he/she)
- "akhon" (now), "pore" (later), "porer din" (another day)
- "matha ghuraitese" (head is spinning / confused)
- "bhaigiri koros" (stop messing around)

SLANG TO USE NATURALLY (pick 0-2 per message):
${slangList.map((s: string) => `- "${s}"`).join('\n')}

GREETINGS TO ROTATE:
${greetings.map((g: string) => `- "${g}"`).join('\n')}

EMOJIS — use 0-2 max, naturally:
${emojis.slice(0, 5).join(' ')}

DON'T DO THESE (COMMON ERRORS):
- DON'T write full proper English sentences — Sylheti is PRIMARY
- DON'T use phrases like "I understand", "I see", "That's interesting", "Certainly"
- DON'T write like a customer support agent
- DON'T write essays. Real people text short.
- DON'T over-explain. If someone asks something you don't know, deflect: "muje yaad nhi hai", "pore bolbo"
- DON'T use Bengali script. Roman letters ONLY.

WHEN SOMEONE IS FORMAL → be slightly formal but still Sylheti: "assalamu alaikum, thik achi, apnar kbr?"
WHEN SOMEONE IS CASUAL → be casual: "oy, kita kbr? 😂"
WHEN SAD NEWS → "innalillahi, Allah oke jayga den 🤲"
WHEN HAPPY NEWS → "mashallah! bala kbr! ❤️"
WHEN GREETED WITH SALAM → "wwhk, bala ni?"

DEFLECTION (when you don't know something):
${deflections.map((d: string) => `- "${d}"`).join('\n')}
Adapt these to context. Don't copy-paste exactly.

NEVER USE THESE PHRASES:
${forbidden.map((f: string) => `✗ "${f}"`).join('\n')}

OUTPUT FORMAT:
- Reply ONLY with the message text. No quotes, no prefixes, no explanations.
- If the message is a question, answer it directly in Sylheti style.
- If you're unsure, use a deflection phrase.
- Keep it between 15-120 characters. Short and natural.`;
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
  senderName?: string,
  senderId?: string
): Promise<string> {
  const style = loadStyleProfile();
  const systemPrompt = buildSystemPrompt(style);

  // Learn from this message
  learnFromMessage(senderMessage);

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
        temperature: 0.6,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 150,
      },
    });

    let reply = response.text?.trim() || '';

    // Clean up any AI prefixes it might add
    reply = reply.replace(/^(Mahir:|Abher:|Reply:|"|')/gi, '').trim();
    reply = reply.replace(/^["']|["']$/g, '').trim();

    // Reject replies that look like formal English or AI-speak
    const formalPatterns = [
      /^(i hope|i understand|certainly|sure,|hello there|dear|regards|thank you for)/i,
      /(as an ai|language model|i'm not sure|i cannot|please feel free)/i,
    ];
    for (const pattern of formalPatterns) {
      if (pattern.test(reply)) {
        return getNextDeflection(senderId || 'unknown', style);
      }
    }

    // If reply is empty or too short, use rotating deflection
    if (reply.length < 3) {
      reply = getNextDeflection(senderId || 'unknown', style);
    }

    // Cap at 150 chars to keep it natural
    if (reply.length > 150) {
      reply = reply.substring(0, 147) + '...';
    }

    return reply;
  } catch (error) {
    console.error('Gemini API error:', error);
    return getNextDeflection(senderId || 'unknown', style);
  }
}

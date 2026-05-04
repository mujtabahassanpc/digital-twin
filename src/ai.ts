import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidePath = path.join(__dirname, '..', 'data', 'ai_guide.md');
const styleProfilePath = path.join(__dirname, '..', 'data', 'style_profile.json');

const deflectionHistory: Record<string, string[]> = {};
const senderPersonality: Record<string, any> = {};

function loadGuide(): string {
  try {
    return fs.readFileSync(guidePath, 'utf-8');
  } catch {
    return '';
  }
}

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
    // silent
  }
}

function learnFromMessage(userMessage: string) {
  try {
    const style = loadStyleProfile();
    if (!style) return;

    const lower = userMessage.toLowerCase();
    const words = lower.split(/\s+/).filter((w) => w.length > 2 && /^[a-z]+$/.test(w));

    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'with',
      'this', 'that', 'from', 'they', 'will', 'each', 'make', 'like',
      'just', 'over', 'such', 'more', 'than', 'when', 'what', 'where',
      'who', 'why', 'how', 'does', 'did', 'do', 'is', 'it', 'in', 'on',
      'or', 'an', 'as', 'at', 'by', 'to', 'of', 'so', 'no', 'up', 'if',
      'oo', 'ki', 'ho', 'na', 're', 'hai', 'tha', 'rah', 'kar', 'kya',
      'mera', 'tera', 'kisi', 'kuch', 'bhi', 'aur', 'bhi', 'usko', 'uske',
    ]);

    const existingSlang = new Set((style.slang_words || []).map((s: string) => s.toLowerCase()));
    const newWords = words.filter((w) => !stopWords.has(w) && !existingSlang.has(w));

    const sylhetiIndicators = ['kita', 'bala', 'kbr', 'kamon', 'kail', 'koi', 'keno', 'oy', 'naa',
      'muje', 'tore', 'akhon', 'pore', 'matha', 'koros', 'jaitay', 'ba', 'ni', 'os', 'ase',
      'asos', 'bolbo', 'bolos', 'koiya', 'kire', 'bhai', 'bhaijaan'];

    let learnedCount = 0;
    for (const word of newWords) {
      const isSylhetiLike = sylhetiIndicators.some((indicator) => word.includes(indicator) || indicator.includes(word));
      if (isSylhetiLike || (word.length >= 4 && word.length <= 10)) {
        if (!existingSlang.has(word)) {
          style.slang_words = style.slang_words || [];
          style.slang_words.push(word);
          existingSlang.add(word);
          learnedCount++;
        }
      }
    }

    if (learnedCount > 0) {
      saveStyleProfile(style);
      console.log(`📚 Learned ${learnedCount} new word(s): ${newWords.slice(0, 5).join(', ')}`);
    }
  } catch (e) {
    // silent
  }
}

function getNextDeflection(senderId: string, style: any): string {
  const deflections = style?.deflection_phrases || ['acha me puchke batata hu'];
  if (!deflectionHistory[senderId]) {
    deflectionHistory[senderId] = [];
  }

  const recent = deflectionHistory[senderId].slice(-3);
  const available = deflections.filter((d: string) => !recent.includes(d));
  const pool = available.length > 0 ? available : deflections;

  const pick = pool[Math.floor(Math.random() * pool.length)];
  deflectionHistory[senderId].push(pick);
  return pick;
}

function classifyMessage(text: string): { type: string; urgency: number } {
  const lower = text.toLowerCase();

  const typeMap: Record<string, string[]> = {
    greeting: ['hello', 'hi', 'hey', 'salam', 'assalam', 'oy', 'kemon', 'kita', 'kbr', 'bala', 'kire'],
    question: ['kita', 'kail', 'koi', 'keno', 'what', 'when', 'where', 'why', 'how', 'who', '?'],
    emotional: ['love', 'miss', 'sad', 'happy', 'crying', 'missed', 'heart', 'dil'],
    sad: ['sad', 'death', 'dead', 'died', 'hurt', 'pain', 'bimar', 'sick', 'accident', 'innalillahi', 'loss'],
    happy: ['mashallah', 'alhamdulillah', 'congrats', 'congratulations', 'happy', 'party', 'wedding', 'shadi', 'good news'],
    urgent: ['urgent', 'emergency', 'help', 'zaroori', 'jaldi', 'important', 'problem', 'asap', 'please call'],
    important: ['kaam hai', 'baat karni', 'personal', 'private', 'secret', 'paisa', 'money', 'family', 'medical', 'job', 'offer'],
  };

  let type = 'normal';
  let urgency = 3;

  for (const [msgType, keywords] of Object.entries(typeMap)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      type = msgType;
      if (['sad', 'urgent'].includes(msgType)) urgency = 9;
      else if (['important', 'happy'].includes(msgType)) urgency = 7;
      else if (msgType === 'emotional') urgency = 6;
      else if (msgType === 'greeting') urgency = 2;
      else if (msgType === 'question') urgency = 4;
      else urgency = 5;
      break;
    }
  }

  if (text.length < 5) urgency = Math.max(1, urgency - 1);
  if (text.length > 100) urgency = Math.min(10, urgency + 1);

  return { type, urgency };
}

function getTypingDelay(messageLength: number, urgency: number): number {
  const baseDelay = Math.max(1000, Math.min(8000, messageLength * 80));
  const urgencyMultiplier = 1 - (urgency - 1) * 0.08;
  const timeVariation = 0.7 + Math.random() * 0.6;
  return Math.round(baseDelay * urgencyMultiplier * timeVariation);
}

function getSplitCount(messageLength: number, type: string): number {
  if (messageLength < 30) return 1;
  if (messageLength < 80 && type === 'normal') return 1 + Math.floor(Math.random() * 2);
  if (type === 'greeting') return 1;
  return 1 + Math.floor(Math.random() * 2);
}

function getCurrentTimeContext(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function buildSystemPrompt(senderName?: string, messageContext?: { type: string; urgency: number }): string {
  const guide = loadGuide();
  const timeContext = getCurrentTimeContext();

  let contextInstructions = '';

  if (messageContext) {
    const { type, urgency } = messageContext;

    if (type === 'greeting') {
      contextInstructions = `\n\nCURRENT CONTEXT: This is a GREETING. Reply with a warm greeting in Sylheti. Ask how they are doing. Keep it very short (10-30 chars).`;
    } else if (type === 'question') {
      contextInstructions = `\n\nCURRENT CONTEXT: They asked a QUESTION. Answer it naturally in Sylheti + English mix. Be helpful but casual. Don't over-explain.`;
    } else if (type === 'sad') {
      contextInstructions = `\n\nCURRENT CONTEXT: This is SAD/EMOTIONAL news. Show sympathy. Use "innalillahi" or similar. Be warm and caring. This is serious — match the emotion.`;
    } else if (type === 'happy') {
      contextInstructions = `\n\nCURRENT CONTEXT: This is HAPPY news! Respond with excitement. Use "mashallah" or "alhamdulillah". Be genuinely happy for them.`;
    } else if (type === 'urgent') {
      contextInstructions = `\n\nCURRENT CONTEXT: This is URGENT. Reply quickly and directly. Say "acha bolbo" and let Mujtaba know via Telegram.`;
    } else if (type === 'important') {
      contextInstructions = `\n\nCURRENT CONTEXT: This seems IMPORTANT. Say "acha bolbo" to encourage them to continue. Alert Mujtaba via Telegram.`;
    } else if (type === 'emotional') {
      contextInstructions = `\n\nCURRENT CONTEXT: This is an EMOTIONAL message. Match their energy. Be warm, caring, and natural. Don't be robotic.`;
    }

    contextInstructions += `\nIt is currently ${timeContext} time. If it's late night (after 11pm), you can mention "raat ho gayi" or "so ja". If morning, "subah subah" vibe.`;
  }

  const guideContext = guide ? `\n\nYOUR COMPLETE GUIDE — FOLLOW IT:\n\n${guide}` : '';

  return `You are Mahir Abher, Mujtaba's brother. You handle his WhatsApp when he's busy.${guideContext}

RULES:
1. Respond ONLY with the reply text — no explanations, no prefixes, no quotes
2. Be a real Sylheti young man texting — natural, casual, warm
3. Complete your thought fully — don't cut off mid-sentence
4. No corporate language, no AI talk, no robotic phrases
5. Match the energy of the conversation
6. Use Sylheti words naturally: "kita", "bala", "kbr", "kamon", "oy", "naa"
7. If you don't know something, deflect naturally

${senderName ? `You are talking to: ${senderName}` : ''}${contextInstructions}`;
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

export interface ReplyMetadata {
  typingDelay: number;
  shouldSplit: boolean;
  splitCount: number;
  messageParts: string[];
  isImportant: boolean;
}

export async function generateReply(
  senderMessage: string,
  conversationHistory: ConversationEntry[] = [],
  senderName?: string,
  senderId?: string
): Promise<{ text: string; metadata: ReplyMetadata }> {
  const style = loadStyleProfile();

  learnFromMessage(senderMessage);

  const messageContext = classifyMessage(senderMessage);
  const systemPrompt = buildSystemPrompt(senderName, messageContext);

  const recentHistory = conversationHistory.slice(-10);

  let historyText = '';
  if (recentHistory.length > 0) {
    historyText = '\n\nRECENT CONVERSATION:\n';
    for (const entry of recentHistory) {
      historyText += `${entry.role === 'user' ? (senderName || 'Friend') : 'Mahir'}: ${entry.content}\n`;
    }
  }

  const fullPrompt = `${systemPrompt}${historyText}\n\n${senderName || 'Friend'}'s MESSAGE:\n${senderMessage}\n\nYour reply:`;

  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: fullPrompt,
      config: {
        temperature: 0.8,
        topP: 0.9,
        maxOutputTokens: 500,
      },
    });

    let reply = response.text?.trim() || '';

    reply = reply.replace(/^(Mahir:|Abher:|Reply:|"|')/gi, '').trim();
    reply = reply.replace(/^["']|["']$/g, '').trim();

    if (reply.length < 3) {
      reply = getNextDeflection(senderId || 'unknown', style);
    }

    const typingDelay = getTypingDelay(reply.length, messageContext.urgency);
    const splitCount = getSplitCount(reply.length, messageContext.type);
    const isImportant = messageContext.urgency >= 7;

    return {
      text: reply,
      metadata: {
        typingDelay,
        shouldSplit: splitCount > 1,
        splitCount,
        messageParts: [reply],
        isImportant,
      },
    };
  } catch (error) {
    console.error('Gemini API error:', error);
    return {
      text: getNextDeflection(senderId || 'unknown', style),
      metadata: {
        typingDelay: 2000,
        shouldSplit: false,
        splitCount: 1,
        messageParts: [],
        isImportant: false,
      },
    };
  }
}

export { getNextDeflection, loadGuide };

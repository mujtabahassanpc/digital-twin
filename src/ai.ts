import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidePath = path.join(__dirname, '..', 'data', 'ai_guide.md');
const styleProfilePath = path.join(__dirname, '..', 'data', 'style_profile.json');

// Track recent AI replies per sender to prevent repetition
const recentReplies: Record<string, string[]> = {};
// Track deflection usage per sender
const deflectionHistory: Record<string, string[]> = {};
// Track Gemini rate limit (429) cooldown
let geminiRateLimitedUntil = 0;

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

// Learn new words from user messages
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
      'tha', 'thi', 'the', 'tha', 'tha', 'tho', 'toh', 'hain', 'hain',
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
    greeting: ['hello', 'hi', 'hey', 'salam', 'assalam', 'oy', 'kemon', 'kamon', 'kita', 'kbr', 'bala', 'kire'],
    question: ['kita', 'kail', 'koi', 'keno', 'what', 'when', 'where', 'why', 'how', 'who', '?'],
    emotional: ['love', 'miss', 'sad', 'happy', 'crying', 'missed', 'heart', 'dil', 'pyaar'],
    sad: ['sad', 'death', 'dead', 'died', 'hurt', 'pain', 'bimar', 'sick', 'accident', 'innalillahi', 'loss', 'dukh'],
    happy: ['mashallah', 'alhamdulillah', 'congrats', 'congratulations', 'happy', 'party', 'wedding', 'shadi', 'good news', 'khushi'],
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

function getCurrentTimeContext(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function buildSystemPrompt(senderName?: string, messageContext?: { type: string; urgency: number }, conversationHistory?: any[]): string {
  const guide = loadGuide();
  const timeContext = getCurrentTimeContext();

  let flowInstruction = '';

  if (conversationHistory && conversationHistory.length > 0) {
    const lastFew = conversationHistory.slice(-4);
    const lastAiReplies = lastFew.filter((e: any) => e.role === 'assistant').map((e: any) => e.content);

    const deflectWords = ['puchke', 'yaad nhi', 'pore bolbo', 'acha bolbo', 'muje nahi pata'];
    const recentDeflections = lastAiReplies.filter((r: string) =>
      deflectWords.some((w) => r.toLowerCase().includes(w))
    ).length;

    if (recentDeflections >= 2) {
      flowInstruction = `\n\n⚠️ CRITICAL: You have been deflecting too much. DO NOT deflect again. Give a real, natural response.`;
    }

    const lastReply = lastAiReplies[lastAiReplies.length - 1] || '';
    if (lastReply.length < 10) {
      flowInstruction += `\nYour last reply was very short. This time, say something more.`;
    }
  }

  let contextInstructions = '';

  if (messageContext) {
    const { type } = messageContext;

    if (type === 'greeting') {
      contextInstructions = `\n\nCONTEXT: Greeting. Reply warmly in Sylheti. Ask how they are. Keep it very short.`;
    } else if (type === 'question') {
      contextInstructions = `\n\nCONTEXT: They asked a question. Answer naturally. If unsure, deflect ONCE then ask follow-up.`;
    } else if (type === 'sad') {
      contextInstructions = `\n\nCONTEXT: Sad news. Show sympathy. Use "innalillahi". Be warm.`;
    } else if (type === 'happy') {
      contextInstructions = `\n\nCONTEXT: Happy news! Be excited. Use "mashallah" or "alhamdulillah".`;
    } else if (type === 'urgent' || type === 'important') {
      contextInstructions = `\n\nCONTEXT: Important/Urgent. Say "acha bolbo" and alert Mujtaba via Telegram.`;
    } else if (type === 'emotional') {
      contextInstructions = `\n\nCONTEXT: Emotional message. Match their energy. Be warm.`;
    } else {
      contextInstructions = `\n\nCONTEXT: Normal chat. Reply naturally. Keep conversation alive.`;
    }

    contextInstructions += `\nTime: ${timeContext}.`;
  }

  const guideContext = guide ? `\n\nYOUR GUIDE — FOLLOW IT:\n\n${guide}` : '';

  return `You are Mahir Abher, Mujtaba's brother.${guideContext}

RULES:
1. Reply ONLY with the message text — no explanations, no prefixes
2. Be a real Sylheti young man texting — natural, casual, warm
3. NEVER repeat the same reply
4. NEVER deflect more than once in a row
5. ALWAYS continue the conversation — ask follow-up questions
6. NEVER explain who you are unless they explicitly ask "who is this?"
7. Use Sylheti words naturally
8. No corporate language, no AI talk

${senderName ? `Talking to: ${senderName}` : ''}${contextInstructions}${flowInstruction}`;
}

// Multi-provider API key management
let currentGeminiKeyIndex = 0;
let ai: GoogleGenAI | null = null;
let currentMistralKeyIndex = 0;
let mistralExhaustedUntil = 0;
let geminiExhaustedUntil = 0;

function getAvailableGeminiKeys(): string[] {
  return config.getGeminiKeys();
}

function getAvailableMistralKeys(): string[] {
  return config.getMistralKeys();
}

function getGeminiAI(): GoogleGenAI {
  if (!ai) {
    const keys = getAvailableGeminiKeys();
    if (keys.length === 0) {
      throw new Error('No Gemini API keys configured');
    }
    ai = new GoogleGenAI({ apiKey: keys[0] });
  }
  return ai;
}

function rotateGeminiKey() {
  const keys = getAvailableGeminiKeys();
  if (keys.length <= 1) return;
  currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % keys.length;
  ai = new GoogleGenAI({ apiKey: keys[currentGeminiKeyIndex] });
  console.log(`🔄 Rotated to Gemini key #${currentGeminiKeyIndex + 1}/${keys.length}`);
}

// Mistral API call via fetch (no extra dependency needed)
async function callMistral(systemPrompt: string, fullPrompt: string): Promise<string> {
  const keys = getAvailableMistralKeys();
  if (keys.length === 0) throw new Error('No Mistral keys configured');

  const key = keys[currentMistralKeyIndex];
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: fullPrompt },
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

function rotateMistralKey() {
  const keys = getAvailableMistralKeys();
  if (keys.length <= 1) return;
  currentMistralKeyIndex = (currentMistralKeyIndex + 1) % keys.length;
  console.log(`🔄 Rotated to Mistral key #${currentMistralKeyIndex + 1}/${keys.length}`);
}


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
  const style = loadStyleProfile();

  learnFromMessage(senderMessage);

  const messageContext = classifyMessage(senderMessage);

  // If all providers exhausted, use natural fallback
  const allExhausted = Date.now() < geminiExhaustedUntil && Date.now() < mistralExhaustedUntil;
  if (allExhausted) {
    console.log('⏳ All AI providers exhausted — using natural fallback');
    return getNaturalFallback(senderId);
  }

  // If Gemini exhausted but Mistral available, skip to Mistral
  const geminiExhausted = Date.now() < geminiExhaustedUntil;

  // Skip AI for simple greetings to conserve quota
  const trimmed = senderMessage.trim().toLowerCase();
  const greetingPatterns = [/^hi$/, /^hello$/, /^hey$/, /^oy$/, /^salam$/, /^wsalam$/, /^hlo$/, /^hlw$/, /^sup$/, /^yo$/, /^👋$/, /^😊$/, /^😂$/, /^❤️$/];
  const isSimpleGreeting = greetingPatterns.some((p) => p.test(trimmed));

  if (isSimpleGreeting && (geminiExhausted || Date.now() < geminiExhaustedUntil + 300_000)) {
    const greetingResponses = [
      'oy, kamon asos?',
      'wswk, kamon aas? 😊',
      'hey, kita kbr?',
      'salam! bala ni?',
      'oy bhai, kamon asos?',
    ];
    const reply = greetingResponses[Math.floor(Math.random() * greetingResponses.length)];
    trackReply(senderId, reply);
    return {
      text: reply,
      metadata: {
        typingDelay: 800 + Math.random() * 1200,
        isImportant: false,
      },
    };
  }

  const systemPrompt = buildSystemPrompt(senderName, messageContext, conversationHistory);

  const recentHistory = conversationHistory.slice(-10);

  let historyText = '';
  if (recentHistory.length > 0) {
    historyText = '\n\nRECENT CONVERSATION:\n';
    for (const entry of recentHistory) {
      historyText += `${entry.role === 'user' ? (senderName || 'Friend') : 'Mahir'}: ${entry.content}\n`;
    }
  }

  const fullPrompt = `${systemPrompt}${historyText}\n\n${senderName || 'Friend'}'s MESSAGE:\n${senderMessage}\n\nYour reply:`;

  // Try Gemini first
  if (!geminiExhausted && getAvailableGeminiKeys().length > 0) {
    try {
      const reply = await tryGemini(fullPrompt, senderId, messageContext, style);
      if (reply) return reply;
    } catch (err: any) {
      const errMsg = err?.message || '';
      const is429 = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED');
      if (is429) {
        console.log('🔑 Gemini 429 — trying Mistral fallback...');
        geminiExhaustedUntil = Date.now() + 300_000; // 5 min cooldown
      }
    }
  }

  // Fallback to Mistral
  if (getAvailableMistralKeys().length > 0) {
    try {
      const reply = await tryMistral(systemPrompt, fullPrompt, senderId, messageContext, style);
      if (reply) return reply;
    } catch (err: any) {
      const errMsg = err?.message || '';
      const is429 = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED');
      if (is429) {
        console.log('🔑 Mistral 429 — all providers exhausted');
        mistralExhaustedUntil = Date.now() + 300_000;
      }
    }
  }

  // Last resort: natural fallback
  console.log('⏳ All AI providers failed — natural fallback');
  return getNaturalFallback(senderId);
}

// Helper: Try Gemini API
async function tryGemini(
  fullPrompt: string,
  senderId: string | undefined,
  messageContext: { urgency: number },
  style: any
): Promise<{ text: string; metadata: ReplyMetadata } | null> {
  const response = await getGeminiAI().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: fullPrompt,
    config: { temperature: 0.85, topP: 0.9, maxOutputTokens: 500 },
  });

  let reply = response.text?.trim() || '';
  reply = reply.replace(/^(Mahir:|Abher:|Reply:|"|')/gi, '').trim();
  reply = reply.replace(/^["']|["']$/g, '').trim();

  if (isDeflection(reply) && hasDeflectedRecently(senderId)) {
    console.log('⚠️ Gemini deflecting again — forcing natural reply');
    reply = getRandomFollowUp();
  }

  if (reply.length < 3) reply = getNextDeflection(senderId || 'unknown', style);
  trackReply(senderId, reply);

  return { text: reply, metadata: { typingDelay: getTypingDelay(reply.length, messageContext.urgency), isImportant: messageContext.urgency >= 7 } };
}

// Helper: Try Mistral API
async function tryMistral(
  systemPrompt: string,
  fullPrompt: string,
  senderId: string | undefined,
  messageContext: { urgency: number },
  style: any
): Promise<{ text: string; metadata: ReplyMetadata } | null> {
  const reply = await callMistral(systemPrompt, fullPrompt);
  const cleaned = reply.replace(/^(Mahir:|Abher:|Reply:|"|')/gi, '').trim().replace(/^["']|["']$/g, '').trim();

  if (isDeflection(cleaned) && hasDeflectedRecently(senderId)) {
    console.log('⚠️ Mistral deflecting again — forcing natural reply');
    const finalReply = getRandomFollowUp();
    trackReply(senderId, finalReply);
    return { text: finalReply, metadata: { typingDelay: getTypingDelay(finalReply.length, messageContext.urgency), isImportant: messageContext.urgency >= 7 } };
  }

  const finalReply = cleaned.length < 3 ? getNextDeflection(senderId || 'unknown', style) : cleaned;
  trackReply(senderId, finalReply);

  console.log('✅ Mistral reply successful');
  return { text: finalReply, metadata: { typingDelay: getTypingDelay(finalReply.length, messageContext.urgency), isImportant: messageContext.urgency >= 7 } };
}

// Helpers
function isDeflection(text: string): boolean {
  const patterns = ['puchke batata hu', 'yaad nhi hai', 'pore bolbo', 'acha bolbo', 'muje nahi pata', 'me nahi jaanta'];
  return patterns.some((p) => text.toLowerCase().includes(p));
}

function hasDeflectedRecently(senderId: string | undefined): boolean {
  const recent = recentReplies[senderId || 'unknown']?.slice(-3) || [];
  return recent.some((r) => isDeflection(r));
}

function getRandomFollowUp(): string {
  const prompts = ['kita ba bala ni? 😊', 'kamon asos?', 'bala ni? kbr?', 'oy, kamon asos?', 'sab thik hai?'];
  return prompts[Math.floor(Math.random() * prompts.length)];
}

function trackReply(senderId: string | undefined, reply: string) {
  const key = senderId || 'unknown';
  if (!recentReplies[key]) recentReplies[key] = [];
  recentReplies[key].push(reply);
  if (recentReplies[key].length > 10) recentReplies[key] = recentReplies[key].slice(-10);
}

function getNaturalFallback(senderId: string | undefined): { text: string; metadata: ReplyMetadata } {
  const fallbacks = [
    'kamon asos? 😊', 'kita ba bala ni?', 'oy, bala ni?', 'sab thik hai?',
    'kamon aas? ❤️', 'kita kbr?', 'acha achi kotha bol 😄', 'haan bol, muji shuni ase',
  ];
  const used = recentReplies[senderId || 'unknown']?.slice(-3) || [];
  const available = fallbacks.filter((f) => !used.includes(f));
  const pool = available.length > 0 ? available : fallbacks;
  const reply = pool[Math.floor(Math.random() * pool.length)];
  trackReply(senderId, reply);
  return { text: reply, metadata: { typingDelay: 1500 + Math.random() * 2000, isImportant: false } };
}

export { getNextDeflection, loadGuide, rotateGeminiKey, rotateMistralKey };

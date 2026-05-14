import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { runResponseGuard, recordOutgoing, ConversationEntry } from './response_guard.js';
import { getFeedbackContext } from './feedback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const instructionsPath = path.join(dataDir, 'mahir_instructions.md');
const contextPath = path.join(dataDir, 'context.md');
const contactsPath = path.join(dataDir, 'contacts.json');
const scriptedRepliesPath = path.join(dataDir, 'scripted_replies.json');
const languageExamplesPath = path.join(dataDir, 'language_examples.json');
const styleProfilePath = path.join(dataDir, 'style_profile.json');
const scheduledMessagesPath = path.join(dataDir, 'scheduled_messages.json');

// Per-sender reply tracking (bounded to prevent memory leaks)
const recentReplies: Record<string, string[]> = {};
const MAX_TRACKED_SENDERS = 100;

// Track which senders received the exhausted message (bounded)
const exhaustedSent: Record<string, boolean> = {};

function pruneExhaustedSent() {
  const keys = Object.keys(exhaustedSent);
  if (keys.length > MAX_TRACKED_SENDERS) {
    const toRemove = keys.slice(0, keys.length - MAX_TRACKED_SENDERS);
    for (const k of toRemove) delete exhaustedSent[k];
  }
}

// Provider cooldowns (5 min after 429)
const providerCooldowns: Record<string, number> = {
  gemini: 0,
  mistral: 0,
  groq: 0,
  openrouter: 0,
  cohere: 0,
  llmgtwy: 0
};

// Provider success/fail tracking
const providerStats: Record<string, { success: number; fail: number; lastUsed: string }> = {};

function recordProviderSuccess(name: string) {
  if (!providerStats[name]) providerStats[name] = { success: 0, fail: 0, lastUsed: '' };
  providerStats[name].success++;
  providerStats[name].lastUsed = new Date().toISOString();
}

function recordProviderFail(name: string) {
  if (!providerStats[name]) providerStats[name] = { success: 0, fail: 0, lastUsed: '' };
  providerStats[name].fail++;
  providerStats[name].lastUsed = new Date().toISOString();
}

// Fallback canned reply pool — used when all LLM providers fail
const fallbackReplies = [
  'Ami akhon ektu busy achi, pore kotha bolte paren.',
  'Acha bhai, me dekhbo pore. Thoda busy hu abhi.',
  'Bhai ektu kaam me atka hu, pore detail me baat karte hain.',
  'Ektu busy achi bhai, pore baat kori. Thik ache?',
  'Bhai abhi reply dena possible na, pore bolbo inshaAllah.',
];
let fallbackIdx = 0;
function getFallbackReply(): string {
  const reply = fallbackReplies[fallbackIdx];
  fallbackIdx = (fallbackIdx + 1) % fallbackReplies.length;
  return reply;
}

// ============================================================
// FILE CACHE (TTL-based, avoids repeated sync reads)
// ============================================================

const fileCache = new Map<string, { data: string; expiresAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds
const ALWAYS_FRESH = new Set(['contacts.json', 'language_examples.json']); // skip cache

function cachedRead(filePath: string): string {
  const fileName = path.basename(filePath);
  if (!ALWAYS_FRESH.has(fileName)) {
    const cached = fileCache.get(filePath);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }
  const data = fs.readFileSync(filePath, 'utf-8');
  fileCache.set(filePath, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function invalidateCache(filePath?: string) {
  if (filePath) {
    fileCache.delete(filePath);
  } else {
    fileCache.clear();
  }
}

// ============================================================
// FILE LOADERS
// ============================================================

function loadFile(filePath: string): string {
  try {
    return cachedRead(filePath);
  } catch {
    return '';
  }
}

function loadMahirInstructions(): string {
  return loadFile(instructionsPath);
}

function loadContext(): string {
  return loadFile(contextPath);
}

function loadStyleProfile(): string {
  try {
    const raw = cachedRead(styleProfilePath);
    const data = JSON.parse(raw);
    const parts: string[] = [];
    if (data.slang_words?.length) {
      parts.push(`Common slang: ${data.slang_words.slice(0, 20).join(', ')}`);
    }
    if (data.common_emojis?.length) {
      parts.push(`Common emojis: ${data.common_emojis.join(' ')}`);
    }
    if (data.greetings?.length) {
      parts.push(`Natural greetings: ${data.greetings.slice(0, 10).join(', ')}`);
    }
    if (data.response_style) {
      const s = data.response_style;
      parts.push(`Response style: ${s.avg_sentences || 2} sentence avg, ${s.use_questions ? 'uses questions' : 'mostly statements'}, ${s.match_sender_energy ? 'matches sender energy' : ''}`);
    }
    if (data.deflection_phrases?.length) {
      parts.push(`Deflection phrases (use when unsure): ${data.deflection_phrases.slice(0, 5).join(' || ')}`);
    }
    if (data.forbidden_phrases?.length) {
      parts.push(`NEVER use phrases like: ${data.forbidden_phrases.slice(0, 15).join(', ')}`);
    }
    if (parts.length === 0) return '';
    return `## Style Profile (learned from Mujtaba's chat patterns)\n${parts.join('\n')}\n`;
  } catch {
    return '';
  }
}

function loadLanguageExamples(): string {
  try {
    const raw = cachedRead(languageExamplesPath);
    const data = JSON.parse(raw);
    const examples: any[] = data.examples || [];
    if (examples.length === 0) return '';
    let text = '## Language Examples (learned from Mujtaba)\n';
    const recent = examples.slice(-30);
    for (const ex of recent) {
      text += `- Message: "${ex.message}" — Why: ${ex.reason}\n`;
    }
    text += '\nThese are examples of how to respond. Understand the pattern, don\'t copy them word-for-word.\n';
    return text;
  } catch {
    return '';
  }
}

function loadContacts(): Record<string, any> {
  try {
    const raw = cachedRead(contactsPath);
    return JSON.parse(raw);
  } catch {
    return { contacts: {}, last_updated: new Date().toISOString() };
  }
}

function loadScriptedReply(senderId: string): string {
  try {
    const raw = cachedRead(scriptedRepliesPath);
    const data = JSON.parse(raw);
    const script = data[senderId];
    if (script && script.active && script.instruction) {
      return script.instruction;
    }
  } catch { /* file doesn't exist or invalid */ }
  return '';
}

function markScriptReported(senderId: string) {
  try {
    const raw = cachedRead(scriptedRepliesPath);
    const data = JSON.parse(raw);
    if (data[senderId]) {
      data[senderId].reported = true;
      data[senderId].lastReportedAt = new Date().toISOString();
      fs.writeFileSync(scriptedRepliesPath, JSON.stringify(data, null, 2));
      invalidateCache(scriptedRepliesPath);
    }
  } catch { /* silent */ }
}

function saveContact(senderId: string, info: any) {
  const data = loadContacts();
  data.contacts[senderId] = {
    ...data.contacts[senderId],
    ...info,
    last_seen: new Date().toISOString(),
  };
  data.last_updated = new Date().toISOString();
  try {
    fs.writeFileSync(contactsPath, JSON.stringify(data, null, 2));
    invalidateCache(contactsPath);
  } catch {
    // silent
  }
}

// Credit tracking for multi-DB fallback (Neon free tier)
let dbCreditsUsed = 0;
const DB_CREDIT_LIMIT = 100;

export function getDbCreditsUsed(): number {
  return dbCreditsUsed;
}

export function incrementDbCredits() {
  dbCreditsUsed++;
}

export function resetDbCredits() {
  dbCreditsUsed = 0;
}

// ============================================================
// SYSTEM PROMPT BUILDER
// ============================================================

function buildSystemPrompt(
  instructions: string,
  context: string,
  contactInfo: string,
  languageExamples: string,
  styleProfile: string,
  timeContext: string,
  history: any[],
  senderName?: string,
  relationshipInstruction?: string,
  feedbackContext?: string,
): string {
  let prompt = `${instructions}\n\n`;

  // Current context (dynamic situation, if any)
  if (context) {
    prompt += `CURRENT SITUATION:\n${context}\n\n`;
  }

  // Contact memory (what Mahir knows about this person)
  if (contactInfo) {
    prompt += `WHAT YOU KNOW ABOUT THIS PERSON:\n${contactInfo}\n\n`;
  }

  if (relationshipInstruction) {
    prompt += `RELATIONSHIP NOTE:\n${relationshipInstruction}\n\n`;
  }

  // Feedback context — past mistakes to learn from
  if (feedbackContext) {
    prompt += `${feedbackContext}\n\n`;
  }

  // Style profile from chat analysis
  if (styleProfile) {
    prompt += `${styleProfile}\n\n`;
  }

  // Language examples taught via /teach
  if (languageExamples) {
    prompt += `${languageExamples}\n\n`;
  }

  // Time context
  prompt += `Current time: ${timeContext}.\n\n`;

  // Conversation history
  if (history.length > 0) {
    const recent = history.slice(-8);
    prompt += `RECENT CONVERSATION (read carefully to understand context):\n`;
    for (const entry of recent) {
      const speaker = entry.role === 'user' ? (senderName || 'Friend') : 'Mahir';
      prompt += `${speaker}: ${entry.content}\n`;
    }
    prompt += `\n`;
  }

  return prompt;
}

// ============================================================
// API PROVIDERS
// ============================================================

async function callGemini(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getGeminiKeys();
  if (keys.length === 0) throw new Error('No Gemini keys');

  for (const key of keys) {
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await retryWithBackoff(async () => {
        return await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `${systemPrompt}\n\nUser's latest message: "${userMessage}"\n\nYour reply (remember the rules above):`,
          config: { temperature: 0.8, topP: 0.9, maxOutputTokens: 300 },
        });
      });
      return response.text?.trim() || '';
    } catch (err: any) {
      if (is429Error(err)) continue;
      throw err;
    }
  }
  throw new Error('All Gemini keys exhausted');
}

async function callOpenAICompatible(baseURL: string, model: string, keys: string[], extraHeaders: Record<string, string>, systemPrompt: string, userMessage: string): Promise<string> {
  for (const key of keys) {
    try {
      const res = await retryWithBackoff(async () => {
        const response = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
            ...extraHeaders,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            temperature: 0.8,
            max_tokens: 300,
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`${baseURL} ${response.status}: ${body}`);
        }
        return response;
      });

      const data = await res.json();
      if (!data.choices || data.choices.length === 0 || !data.choices[0].message || !data.choices[0].message.content) {
        throw new Error('Empty or invalid response from API');
      }
      return data.choices[0].message.content;
    } catch (err: any) {
      if (is429Error(err) && keys.length > 1) continue;
      throw err;
    }
  }
  throw new Error('All keys exhausted');
}

async function callMistral(systemPrompt: string, userMessage: string): Promise<string> {
  return callOpenAICompatible('https://api.mistral.ai/v1', 'mistral-small-latest', config.getMistralKeys(), {}, systemPrompt, userMessage);
}

async function callGroq(systemPrompt: string, userMessage: string): Promise<string> {
  return callOpenAICompatible('https://api.groq.com/openai/v1', 'llama-3.1-8b-instant', config.getGroqKeys(), {}, systemPrompt, userMessage);
}

async function callOpenRouter(systemPrompt: string, userMessage: string): Promise<string> {
  return callOpenAICompatible(
    'https://openrouter.ai/api/v1',
    'meta-llama/llama-3.1-8b-instruct:free',
    config.getOpenRouterKeys(),
    { 'HTTP-Referer': 'https://digital-twin.onrender.com', 'X-Title': 'Mahir Digital Twin' },
    systemPrompt,
    userMessage
  );
}

async function callCohere(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getCohereKeys();
  if (keys.length === 0) throw new Error('No Cohere keys');

  for (const key of keys) {
    try {
      const res = await retryWithBackoff(async () => {
        const response = await fetch('https://api.cohere.ai/v1/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model: 'command-r-plus-08-2024',
            message: userMessage,
            preamble: systemPrompt,
            temperature: 0.8,
            max_tokens: 300,
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Cohere ${response.status}: ${body}`);
        }
        return response;
      });

      const data = await res.json();
      if (!data.text) throw new Error('Empty response from Cohere');
      return data.text;
    } catch (err: any) {
      if (is429Error(err) && keys.length > 1) continue;
      throw err;
    }
  }
  throw new Error('All Cohere keys exhausted');
}

async function callLlmGateway(systemPrompt: string, userMessage: string): Promise<string> {
  return callOpenAICompatible(
    'https://api.llmgateway.io/v1',
    'gpt-4o-mini',
    config.getLlmgtwyKeys(),
    {},
    systemPrompt,
    userMessage
  );
}

async function callSarvam(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getSarvamKeys();
  if (keys.length === 0) throw new Error('No Sarvam keys');

  for (const key of keys) {
    try {
      const res = await retryWithBackoff(async () => {
        const response = await fetch('https://api.sarvam.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-subscription-key': key,
          },
          body: JSON.stringify({
            model: 'sarvam-m',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            temperature: 0.8,
            max_tokens: 300,
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Sarvam ${response.status}: ${body}`);
        }
        return response;
      });

      const data = await res.json();
      if (!data.choices || data.choices.length === 0 || !data.choices[0].message || !data.choices[0].message.content) {
        throw new Error('Empty response from Sarvam');
      }
      return data.choices[0].message.content;
    } catch (err: any) {
      if (is429Error(err) && keys.length > 1) continue;
      throw err;
    }
  }
  throw new Error('All Sarvam keys exhausted');
}

// ============================================================
// MEDIA PROCESSING — Images (Gemini Vision) & Voice (Sarvam STT)
// ============================================================

export async function describeImage(base64Data: string, mimeType: string): Promise<string> {
  const keys = config.getGeminiKeys();
  if (keys.length === 0) return 'a photo';

  for (const key of keys) {
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await retryWithBackoff(async () => {
        return await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{
            role: 'user',
            parts: [
              { text: 'Describe this image in 1 short sentence in simple Hinglish. Focus on what is visible. If there is a person, describe what they are doing. Keep it under 15 words.' },
              { inlineData: { mimeType, data: base64Data } },
            ],
          }],
          config: { temperature: 0.3, maxOutputTokens: 50 },
        });
      });
      return response.text?.trim() || 'a photo';
    } catch (err: any) {
      if (is429Error(err) && keys.length > 1) continue;
      return 'a photo';
    }
  }
  return 'a photo';
}

async function transcribeAudioSarvam(base64Data: string): Promise<string> {
  const keys = config.getSarvamKeys();
  if (keys.length === 0) return '';

  const key = keys[0];
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'audio/ogg' });
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'saarika:v2.5');
    formData.append('language_code', 'bn-IN');

    const res = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': key },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Sarvam STT error:', errText);
      return '';
    }

    const data = await res.json();
    return data.transcript || '';
  } catch (err) {
    console.error('Sarvam STT error:', err);
    return '';
  }
}

export async function transcribeAudio(base64Data: string): Promise<string> {
  // Try Sarvam STT first (Indian language optimized, bn-IN support, no billing required)
  if (config.getSarvamKeys().length > 0) {
    const sarvamResult = await transcribeAudioSarvam(base64Data);
    if (sarvamResult) {
      console.log('🎤 Sarvam STT:', sarvamResult.slice(0, 80));
      return sarvamResult;
    }
    console.log('⚠️ Sarvam STT failed, trying Google Cloud...');
  }

  // Fallback to Google Cloud STT
  const apiKey = config.googleCloudApiKey;
  if (!apiKey) return 'a voice message';

  try {
    const res = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          encoding: 'OGG_OPUS',
          sampleRateHertz: 48000,
          languageCode: 'bn-IN',
          alternativeLanguageCodes: ['en-IN', 'hi-IN', 'en-US'],
          model: 'latest_short',
          enableAutomaticPunctuation: true,
        },
        audio: { content: base64Data },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Google STT error:', errText);
      return 'a voice message';
    }

    const data = await res.json();
    if (data.results && data.results.length > 0) {
      return data.results.map((r: any) => r.alternatives?.[0]?.transcript || '').filter(Boolean).join(' ');
    }
    return 'a voice message';
  } catch (err) {
    console.error('Google STT error:', err);
    return 'a voice message';
  }
}

interface Provider {
  name: string;
  call: (system: string, user: string) => Promise<string>;
}

const providers: Provider[] = [
  { name: 'gemini', call: callGemini },
  { name: 'mistral', call: callMistral },
  { name: 'groq', call: callGroq },
  { name: 'openrouter', call: callOpenRouter },
  { name: 'cohere', call: callCohere },
  { name: 'llmgtwy', call: callLlmGateway },
];

function isProviderAvailable(name: string): boolean {
  switch (name) {
    case 'gemini': return config.getGeminiKeys().length > 0;
    case 'sarvam': return config.getSarvamKeys().length > 0;
    case 'mistral': return config.getMistralKeys().length > 0;
    case 'groq': return config.getGroqKeys().length > 0;
    case 'openrouter': return config.getOpenRouterKeys().length > 0;
    case 'cohere': return config.getCohereKeys().length > 0;
    case 'llmgtwy': return config.getLlmgtwyKeys().length > 0;
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
  return msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate_limit') || msg.includes('too_many');
}

function isRetryableError(err: any): boolean {
  const msg = err?.message || '';
  return msg.includes('503') || msg.includes('500') || msg.includes('UNAVAILABLE') || msg.includes('network') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT');
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number = 2): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isRetryableError(err)) throw err;
      if (i < maxRetries) {
        const delay = 1000 * Math.pow(2, i);
        console.log(`🔄 Retryable error (${err.message}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ============================================================
// CLEAN UP AI RESPONSE
// ============================================================

function cleanReply(text: string | undefined | null): string {
  if (!text) return '';
  let reply = text.trim();
  reply = reply.replace(/^(Mahir:|Abher:|Reply:|AI:|Assistant:|Mahir Abher:)/gi, '').trim();
  reply = reply.replace(/^["'`]|["'`]$/g, '').trim();
  return reply;
}

// ============================================================
// EXHAUSTED MESSAGE (const — only sent ONCE per sender)
// ============================================================

const EXHAUSTED_MESSAGE = 'Ami akhon ektu busy achi, ektu pore kotha bolte paren. 🥲';

// ============================================================
// LLM Routing — Simple messages → Groq first, Complex → Gemini first
// Only for TRUE simple messages (greetings, bye, yes/no, single word)

function isSimpleMessage(userMessage: string): boolean {
  const lower = userMessage.trim().toLowerCase();
  const words = lower.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return false;

  if (words.length === 1) {
    const singlePatterns = [/^(hi|hello|hey|hlo|hii|hlw|helo|by|bye|byee|gn|goodnight|ok|okay|acha|haan|han|ha|nahi|nhi|na|ni|hmm|mm|hm|thanks|thank|thnx|lol|haha|hehe|oh|oy|aare|are|arey|assalamualaikum|walaikumassalam)$/];
    for (const p of singlePatterns) {
      if (p.test(words[0])) return true;
    }
    return false;
  }

  if (words.length === 2) {
    const twoWordPatterns = [/^(kit|ky)\s+(a|kar)$/];
    const joined = words.join(' ');
    for (const p of twoWordPatterns) {
      if (p.test(joined)) return true;
    }
    return false;
  }

  if (words.length === 3) {
    const threeWord = words.join(' ');
    if (/^(kamon asos|kita kbr|kemon aso|kaise ho|kya kar|kya hua|kya baat)$/i.test(threeWord)) return true;
  }

  return false;
}

// ============================================================
// MAIN REPLY GENERATION
// ============================================================

export interface ReplyMetadata {
  typingDelay: number;
  isImportant: boolean;
}

export interface GenerateReplyResult {
  text: string;
  metadata: ReplyMetadata;
  needsClarification: boolean;
  clarificationText: string;
  scriptTriggered?: string;
  hasInformPromise?: boolean;
  nameLearned?: { name: string; phone: string };
}

function makeResult(text: string, metadata?: Partial<ReplyMetadata>, clarification?: { needsClarification: boolean; text: string }, extras?: { scriptTriggered?: string; hasInformPromise?: boolean; nameLearned?: { name: string; phone: string } }): GenerateReplyResult {
  return {
    text,
    metadata: {
      typingDelay: metadata?.typingDelay ?? getTypingDelay(text.length),
      isImportant: metadata?.isImportant ?? isImportantMessage(text),
    },
    needsClarification: clarification?.needsClarification ?? false,
    clarificationText: clarification?.text ?? '',
    scriptTriggered: extras?.scriptTriggered,
    hasInformPromise: extras?.hasInformPromise,
    nameLearned: extras?.nameLearned,
  };
}

export async function generateReply(
  senderMessage: string,
  conversationHistory: ConversationEntry[] = [],
  senderName?: string,
  senderId?: string
): Promise<GenerateReplyResult> {
  const id = senderId || 'unknown';

  pruneExhaustedSent();

  const availableProviders = providers.filter(p => isProviderAvailable(p.name) && !isProviderOnCooldown(p.name));

  // LLM Routing: Simple message → Groq gets priority (saves Gemini keys)
  // Sarvam-m is free so it's also efficient for simple messages
  if (isSimpleMessage(senderMessage)) {
    availableProviders.sort((a, b) => {
      if (a.name === 'groq') return -1;
      if (b.name === 'groq') return 1;
      if (a.name === 'sarvam') return -1;
      if (b.name === 'sarvam') return 1;
      return 0;
    });
  }

  if (availableProviders.length === 0) {
    if (exhaustedSent[id]) {
      console.log(`⏭️ Skipping reply to ${id} — all providers still down, using fallback`);
      return makeResult(getFallbackReply());
    }

    console.log(`⚠️ ALL providers down — fallback reply to ${id}`);
    exhaustedSent[id] = true;
    return makeResult(getFallbackReply());
  }

  exhaustedSent[id] = false;

  // Load instructions from single consolidated file
  const instructions = loadMahirInstructions();
  const context = loadContext();
  const languageExamples = loadLanguageExamples();
  const styleProfile = loadStyleProfile();
  const feedbackContext = getFeedbackContext();
  const contactsData = loadContacts();
  const contact = contactsData.contacts[id];
  const contactInfo = contact ? JSON.stringify(contact, null, 2) : '';

  // Enhanced contact memory: last topic, mood, relationship summary
  let contactSummary = '';
  if (contact) {
    const parts: string[] = [];
    if (contact.relationship) {
      const relNames: Record<string, string> = { mom: 'mother', dad: 'father', bibi: 'wife', wife: 'wife', friend: 'friend', boss: 'boss', bhai: 'brother', brother: 'brother', didi: 'elder sister', sister: 'elder sister', elder: 'elder', stranger: 'stranger', client: 'client', teacher: 'teacher' };
      parts.push(`This is your ${relNames[contact.relationship] || contact.relationship}`);
    }
    if (contact.last_topic) parts.push(`last topic was about ${contact.last_topic}`);
    if (contact.last_message_summary) parts.push(`last message: "${contact.last_message_summary.slice(0, 80)}"`);
    if (contact.last_reply_summary) parts.push(`you replied: "${contact.last_reply_summary.slice(0, 80)}"`);
    if (contact.name) {
      if (contact.name_confirmed) {
        parts.push(`their CONFIRMED name is ${contact.name} — call them by this name ALWAYS. Mujtaba ne bataya hai.`);
      } else if (contact.name_pending_confirmation) {
        parts.push(`WhatsApp name: ${contact.name} (not yet confirmed) — ASK them for their real name to be sure`);
      } else {
        parts.push(`their name might be ${contact.name} — ASK them for their name to confirm`);
      }
    }
    if (contact.guide) parts.push(`Mujtaba's guide about them: "${contact.guide}"`);
    if (contact.conversation_count) parts.push(`you've talked ${contact.conversation_count} times before`);
    if (parts.length > 0) contactSummary = `📌 Contact Summary: ${parts.join('. ')}.`;
  }

  // Relationship-based tone instruction
  const rel = contact?.relationship || '';
  const behaviorMap: Record<string, string> = {
    mom: 'Use respectful, loving language. Address with "aap".',
    dad: 'Use formal, respectful language. Address with "aap".',
    bibi: 'Use warm, loving, casual language.',
    wife: 'Use warm, loving, casual language.',
    friend: 'Use casual, playful language. Can use "tum".',
    boss: 'Use very formal, professional language.',
    bhai: 'Use casual, brotherly, warm language.',
    brother: 'Use casual, brotherly, warm language.',
    didi: 'Use respectful, loving language. Address with "aap".',
    sister: 'Use respectful, loving language. Address with "aap".',
    elder: 'Use very respectful, formal language. Address with "aap".',
    stranger: 'Use polite but cautious, formal language.',
    client: 'Use professional, polite, helpful language.',
    teacher: 'Use very respectful, formal language. Address with "aap".',
  };
  const relationshipInstruction = rel && behaviorMap[rel]
    ? `This person is your ${rel}. ${behaviorMap[rel]}`
    : '';

  // Scripted reply injection (special override feature)
  const scriptInstruction = loadScriptedReply(id);
  const scriptInjection = scriptInstruction
    ? `\n\n📋 SCRIPTED REPLY INSTRUCTION (CRITICAL — FOLLOW THIS WHEN REPLYING): ${scriptInstruction}\nAfter replying naturally (not copy-paste), incorporate Mujtaba's instruction naturally into your response. THEN report back to Mujtaba via Telegram about what you said.`
    : '';

  // Build system prompt — instructions + dynamic data only
  const timeContext = getTimeContext();
  // Observation summary (full conversation summary from observe mode)
  const observationSummary = getObservedContext(id);
  // Append contact summary to contactInfo
  let enhancedContactInfo = contactInfo + (contactSummary ? `\n\n${contactSummary}` : '');
  if (observationSummary) {
    enhancedContactInfo += `\n\n=== LEARNED FROM OBSERVING CONVERSATIONS ===\n${observationSummary}\n\nIMPORTANT: The global knowledge and language patterns above were observed from various conversations. They are tools you can use everywhere, but ADAPT them to each person. If talking to an elder, use respectful language even if the patterns show casual style. If talking to a friend, you can be casual. Always match the person you're talking to RIGHT NOW.`;
  }

  let systemPrompt = buildSystemPrompt(
    instructions,
    context,
    enhancedContactInfo,
    languageExamples,
    styleProfile,
    timeContext,
    conversationHistory,
    senderName,
    relationshipInstruction,
    feedbackContext,
  );

  // Append scripted reply injection if active
  if (scriptInjection) {
    systemPrompt += scriptInjection;
  }

  for (const provider of availableProviders) {
    try {
      console.log(`🚀 Trying ${provider.name}...`);
      let reply = await provider.call(systemPrompt, senderMessage);
      let cleaned = cleanReply(reply);

      if (cleaned.length > 0) {
        const guardResult = runResponseGuard(cleaned, senderMessage, id, conversationHistory);

        if (!guardResult.passed) {
          console.log(`🛡️ Guard blocked reply (${guardResult.reason}): ${guardResult.suggestion}`);
          const warningPrompt = systemPrompt + `\n\n⚠️ GUARD WARNING: Your previous reply had an issue: ${guardResult.reason}. ${guardResult.suggestion}. Fix this and generate a better reply.`;
          reply = await provider.call(warningPrompt, senderMessage);
          cleaned = cleanReply(reply);
          console.log(`🔄 Regenerated reply: ${cleaned.slice(0, 60)}...`);
        }

        if (cleaned.length > 0) {
          trackReply(id, cleaned);
          recordOutgoing(id, cleaned);
          const newName = learnFromConversation(id, senderName, senderMessage, cleaned, conversationHistory);
          const nameLearned = newName ? { name: newName, phone: id } : undefined;

          console.log(`✅ ${provider.name}: ${cleaned.slice(0, 60)}...`);
          recordProviderSuccess(provider.name);
          const hasInform = /(acha bolbo|bol dunga|ko bol|inform|tell|bata dunga|puchke bat|pore bol|Mujtaba ko)/i.test(cleaned);
          return makeResult(cleaned, {}, undefined, { scriptTriggered: scriptInstruction, hasInformPromise: hasInform, nameLearned });
        }
      }
    } catch (err: any) {
      recordProviderFail(provider.name);
      if (is429Error(err)) {
        console.log(`🔑 ${provider.name} 429 — next provider`);
        setProviderCooldown(provider.name);
      } else if (isRetryableError(err)) {
        console.log(`❌ ${provider.name} retryable error after retries: ${err.message}`);
      } else {
        console.log(`❌ ${provider.name} error: ${err.message}`);
      }
    }
  }

  console.log(`🤔 All providers failed for ${id} — fallback reply`);
  return makeResult(getFallbackReply());
}

// ============================================================
// AUTO-LEARN FROM CONVERSATION
// ============================================================

function learnFromConversation(
  senderId: string,
  senderName: string | undefined,
  userMessage: string,
  aiReply: string,
  history: any[]
): string | undefined {
  const existing = loadContacts().contacts[senderId] || {};
  let learnedName: string | undefined;

  if (senderName && !existing.name) {
    existing.name = senderName;
    existing.name_pending_confirmation = true;
    learnedName = senderName;
  }

  existing.conversation_count = (existing.conversation_count || 0) + 1;

  const lower = userMessage.toLowerCase();
  if (lower.includes('school') || lower.includes('class') || lower.includes('college')) {
    existing.last_topic = 'education';
  } else if (lower.includes('work') || lower.includes('job') || lower.includes('kaam')) {
    existing.last_topic = 'work';
  } else if (lower.includes('family') || lower.includes('bhai') || lower.includes('maa') || lower.includes('baap')) {
    existing.last_topic = 'family';
  } else if (lower.includes('call') || lower.includes('phone')) {
    existing.last_topic = 'call_request';
  }

  existing.last_message_summary = userMessage.slice(0, 100);
  existing.last_reply_summary = aiReply.slice(0, 100);

  saveContact(senderId, existing);
  return learnedName;
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
  const keywords = ['urgent', 'emergency', 'help', 'call me', 'important', 'personal', 'family', 'medical', 'paisa', 'money', 'acha bolbo', 'block'];
  return keywords.some(kw => lower.includes(kw));
}

function trackReply(senderId: string, reply: string) {
  const keys = Object.keys(recentReplies);
  if (keys.length >= MAX_TRACKED_SENDERS) {
    delete recentReplies[keys[0]];
  }

  if (!recentReplies[senderId]) recentReplies[senderId] = [];
  recentReplies[senderId].push(reply);
  if (recentReplies[senderId].length > 15) recentReplies[senderId] = recentReplies[senderId].slice(-15);
}

export interface ProviderStatus {
  name: string;
  available: boolean;
  onCooldown: boolean;
  cooldownRemaining: number;
  successCount: number;
  failCount: number;
  lastUsed: string;
}

export function getProviderStatuses(): (ProviderStatus & { stats: { success: number; fail: number; lastUsed: string } })[] {
  return providers.map(p => {
    const stats = providerStats[p.name] || { success: 0, fail: 0, lastUsed: '' };
    return {
      name: p.name,
      available: isProviderAvailable(p.name),
      onCooldown: isProviderOnCooldown(p.name),
      cooldownRemaining: isProviderOnCooldown(p.name)
        ? Math.max(0, Math.round((providerCooldowns[p.name] - Date.now()) / 1000))
        : 0,
      successCount: stats.success,
      failCount: stats.fail,
      lastUsed: stats.lastUsed,
      stats,
    };
  });
}

export function isAnyProviderAvailable(): boolean {
  return providers.some(p => isProviderAvailable(p.name) && !isProviderOnCooldown(p.name));
}

export async function generateSpeech(text: string): Promise<Buffer | null> {
  const keys = config.getSarvamKeys();
  if (keys.length === 0) return null;

  const key = keys[0];
  try {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': key,
      },
      body: JSON.stringify({
        text,
        target_language_code: 'bn-IN',
        speaker: 'shubh',
        model: 'bulbul:v3',
        pace: 1.0,
        speech_sample_rate: 24000,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Sarvam TTS error:', errText);
      return null;
    }

    const data = await res.json();
    if (data.audios && data.audios.length > 0) {
      return Buffer.from(data.audios[0], 'base64');
    }
    return null;
  } catch (err) {
    console.error('Sarvam TTS error:', err);
    return null;
  }
}

// ============================================================
// SCHEDULED MESSAGES — Send messages at a future time
// ============================================================

interface ScheduledMessage {
  id: string;
  targetPhone: string;
  targetName: string;
  message: string;
  scheduledTime: string;
  status: 'pending' | 'sent' | 'failed';
  createdAt: string;
  lastError?: string;
}

function loadSchedules(): ScheduledMessage[] {
  try {
    return JSON.parse(cachedRead(scheduledMessagesPath));
  } catch {
    return [];
  }
}

function saveSchedules(schedules: ScheduledMessage[]) {
  fs.writeFileSync(scheduledMessagesPath, JSON.stringify(schedules, null, 2));
  invalidateCache(scheduledMessagesPath);
}

export function createSchedule(targetPhone: string, targetName: string, message: string, scheduledTime: string): ScheduledMessage {
  const schedules = loadSchedules();
  const schedule: ScheduledMessage = {
    id: Math.random().toString(36).substring(2, 10),
    targetPhone,
    targetName,
    message,
    scheduledTime,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  schedules.push(schedule);
  saveSchedules(schedules);
  return schedule;
}

export function getSchedules(): ScheduledMessage[] {
  return loadSchedules();
}

export function deleteSchedule(id: string): boolean {
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return false;
  schedules.splice(idx, 1);
  saveSchedules(schedules);
  return true;
}

export function getDueSchedules(): ScheduledMessage[] {
  const now = Date.now();
  return loadSchedules().filter(s => s.status === 'pending' && new Date(s.scheduledTime).getTime() <= now);
}

export function markScheduleSent(id: string, error?: string) {
  const schedules = loadSchedules();
  const s = schedules.find(s => s.id === id);
  if (s) {
    s.status = error ? 'failed' : 'sent';
    s.lastError = error;
    saveSchedules(schedules);
  }
}

// ============================================================
// OBSERVATION SUMMARY ACCESS
// ============================================================

export function getObservedContext(phone: string): string {
  const parts: string[] = [];

  // 1) Per-contact observation summary
  try {
    const data = JSON.parse(cachedRead(contactsPath));
    const contact = data.contacts[phone];
    if (contact?.observation_summary) {
      parts.push(contact.observation_summary);
    }
  } catch { /* silent */ }

  // 2) Global learned knowledge (from all observed conversations)
  const learnPath = path.join(dataDir, 'learned_knowledge.json');
  try {
    const knowledge = JSON.parse(cachedRead(learnPath));
    if (Array.isArray(knowledge) && knowledge.length > 0) {
      const categories = [...new Set(knowledge.map((k: any) => k.category))];
      parts.push('GLOBAL KNOWLEDGE (facts observed from other conversations — use with awareness):');
      for (const cat of categories) {
        const facts = knowledge.filter((k: any) => k.category === cat).slice(0, 3).map((k: any) => k.fact);
        if (facts.length > 0) parts.push(`  ${cat}: ${facts.join('; ')}.`);
      }
    }
  } catch { /* silent */ }

  // 3) Global language patterns (from all observed conversations)
  const langPath = path.join(dataDir, 'learned_language.json');
  try {
    const lang = JSON.parse(cachedRead(langPath));
    if (lang.patterns) {
      parts.push('GLOBAL LANGUAGE PATTERNS (learned from observing conversations — adapt to each person):');
      if (lang.patterns.language_mix) parts.push(`  Language style: ${lang.patterns.language_mix}.`);
      if (lang.patterns.common_phrases?.length > 0) {
        parts.push(`  Recurring phrases: ${lang.patterns.common_phrases.slice(0, 8).join(', ')}.`);
      }
      if (lang.patterns.common_sentence_starters?.length > 0) {
        parts.push(`  Sentence starters observed: ${lang.patterns.common_sentence_starters.slice(0, 6).join(', ')}.`);
      }
      if (lang.patterns.mujtaba_asks_questions) {
        parts.push(`  Note: When unsure, asking questions works well — observed from Mujtaba.`);
      }
    }
  } catch { /* silent */ }

  if (parts.length === 0) return '';

  return parts.join('\n\n');
}

export { loadContext, loadContacts, saveContact, markScriptReported };

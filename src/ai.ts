import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const personalityPath = path.join(dataDir, 'personality.md');
const contextPath = path.join(dataDir, 'context.md');
const contactsPath = path.join(dataDir, 'contacts.json');
const languageExamplesPath = path.join(dataDir, 'language_examples.json');
const languageMatcherPath = path.join(dataDir, 'language_matcher.md');
const conversationRulesPath = path.join(dataDir, 'conversation_rules.md');

// Per-sender reply tracking (bounded to prevent memory leaks)
const recentReplies: Record<string, string[]> = {};
const MAX_TRACKED_SENDERS = 100;

// Track which senders received the exhausted message (bounded)
const exhaustedSent: Record<string, boolean> = {};

function pruneExhaustedSent() {
  const keys = Object.keys(exhaustedSent);
  if (keys.length > MAX_TRACKED_SENDERS) {
    // Remove oldest entries
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
};

// ============================================================
// FILE LOADERS
// ============================================================

function loadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function loadPersonality(): string {
  return loadFile(personalityPath);
}

function loadContext(): string {
  return loadFile(contextPath);
}

function loadContacts(): Record<string, any> {
  try {
    const raw = fs.readFileSync(contactsPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { contacts: {}, last_updated: new Date().toISOString() };
  }
}

function loadLanguageExamples(): string {
  try {
    const raw = fs.readFileSync(languageExamplesPath, 'utf-8');
    const data = JSON.parse(raw);
    const examples = data.examples || [];
    if (examples.length === 0) return '';

    // Format examples for the system prompt
    let text = 'LANGUAGE EXAMPLES (learned from Mujtaba):\n';
    // Show last 30 examples (most recent)
    const recent = examples.slice(-30);
    for (const ex of recent) {
      text += `- Message: "${ex.message}"\n  Why: ${ex.reason}\n`;
    }
    return text;
  } catch {
    return '';
  }
}

function loadLanguageMatcher(): string {
  return loadFile(languageMatcherPath);
}

function loadConversationRules(): string {
  return loadFile(conversationRulesPath);
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
  } catch {
    // silent
  }
}

// ============================================================
// CONVERSATION CONTEXT ANALYSIS
// Let the AI detect context naturally from history, not hardcoded phrases
// ============================================================

function getConversationContext(userMessage: string, history: any[]): string {
  const lower = userMessage.toLowerCase().trim();
  const msgLen = userMessage.trim().length;

  // Check if user's message is very short (likely an ending signal)
  const isShortResponse = msgLen < 5;

  // Check if conversation has been going on and user is giving short responses
  const recentUser = history.filter((e: any) => e.role === 'user').slice(-3);
  const allShort = recentUser.length >= 2 && recentUser.every((e: any) => e.content.trim().length < 6);

  if (isShortResponse && allShort) {
    return '⚠️ User is giving very short responses — they may want to end the conversation. Keep your reply minimal and do not ask new questions.';
  }

  if (isShortResponse) {
    return 'User gave a very short response. Match their energy — keep your reply short and natural.';
  }

  return 'User is actively engaged. Respond naturally to what they said.';
}

// ============================================================
// SYSTEM PROMPT BUILDER
// ============================================================

function buildSystemPrompt(
  personality: string,
  context: string,
  contactInfo: string,
  languageExamples: string,
  timeContext: string,
  conversationContext: string,
  history: any[],
  senderName?: string
): string {
  let prompt = `${personality}\n\n`;

  // Language matching rules (NEW)
  const languageMatcher = loadLanguageMatcher();
  if (languageMatcher) {
    prompt += `## LANGUAGE MATCHING (CRITICAL — FOLLOW THESE RULES)\n${languageMatcher}\n\n`;
  }

  // Conversation rules (NEW)
  const conversationRules = loadConversationRules();
  if (conversationRules) {
    prompt += `## CONVERSATION RULES (CRITICAL — FOLLOW THESE RULES)\n${conversationRules}\n\n`;
  }

  // Current context (dynamic)
  if (context) {
    prompt += `CURRENT SITUATION:\n${context}\n\n`;
  }

  // Contact memory
  if (contactInfo) {
    prompt += `WHAT YOU KNOW ABOUT THIS PERSON:\n${contactInfo}\n\n`;
  }

  // Language examples learned from Mujtaba
  if (languageExamples) {
    prompt += `${languageExamples}\n\n`;
  }

  // Time context
  prompt += `Current time: ${timeContext}.\n\n`;

  // Conversation context (let AI detect naturally)
  prompt += `${conversationContext}\n\n`;

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
            model: 'command-r',
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

// ============================================================
// PROVIDER REGISTRY
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
  { name: 'cohere', call: callCohere },
];

function isProviderAvailable(name: string): boolean {
  switch (name) {
    case 'gemini': return config.getGeminiKeys().length > 0;
    case 'mistral': return config.getMistralKeys().length > 0;
    case 'groq': return config.getGroqKeys().length > 0;
    case 'openrouter': return config.getOpenRouterKeys().length > 0;
    case 'cohere': return config.getCohereKeys().length > 0;
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
// RESPONSE GUARD (inline to avoid circular deps)
// ============================================================

const recentOutgoing: Record<string, string[]> = {};
const MAX_OUTGOING_PER_SENDER = 10;

function recordOutgoingInternal(senderId: string, reply: string) {
  if (!recentOutgoing[senderId]) recentOutgoing[senderId] = [];
  recentOutgoing[senderId].push(reply);
  if (recentOutgoing[senderId].length > MAX_OUTGOING_PER_SENDER) {
    recentOutgoing[senderId] = recentOutgoing[senderId].slice(-MAX_OUTGOING_PER_SENDER);
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function wordSetSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter((w) => w.length > 2));
  const wordsB = new Set(b.split(' ').filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

interface GuardResult {
  passed: boolean;
  reason: string;
  suggestion: string;
}

function runResponseGuardInternal(reply: string, userMessage: string, senderId: string, history: ConversationEntry[]): GuardResult {
  // Check 1: Duplicate detection
  const historyOutgoing = recentOutgoing[senderId] || [];
  const normalized = normalizeText(reply);
  for (const prev of historyOutgoing) {
    if (normalized === normalizeText(prev)) {
      return { passed: false, reason: 'exact_duplicate', suggestion: 'Reply is identical to a recent message.' };
    }
    if (wordSetSimilarity(normalized, normalizeText(prev)) > 0.7) {
      return { passed: false, reason: 'high_similarity', suggestion: `Too similar to: "${prev.slice(0, 50)}..."` };
    }
  }

  // Check 2: Length proportionality
  const userLen = userMessage.trim().length;
  const replyLen = reply.trim().length;
  if (userLen <= 5 && replyLen > 80) {
    return { passed: false, reason: 'overlong_for_short_message', suggestion: `User sent ${userLen} chars, reply should be 1 sentence max.` };
  }
  if (userLen < 20 && replyLen > userLen * 4) {
    return { passed: false, reason: 'disproportionate_length', suggestion: `Reply ${replyLen} chars vs user ${userLen} chars — keep proportional.` };
  }

  // Check 3: Fact contradictions
  const lower = reply.toLowerCase();
  if (lower.includes('bada bhai') || lower.includes('bari bhai') || lower.includes('older brother')) {
    return { passed: false, reason: 'identity_contradiction', suggestion: 'Mahir is chhota bhai, not bada bhai.' };
  }
  const ageMatch = lower.match(/(\d+)\s*(ka|saal|year|age)/);
  if (ageMatch) {
    const claimedAge = parseInt(ageMatch[1]);
    if (claimedAge >= 25) {
      const isChhotaBhai = history.some((e) => e.role === 'assistant' && e.content.toLowerCase().includes('chhota bhai'));
      if (isChhotaBhai) {
        return { passed: false, reason: 'age_contradiction', suggestion: `Claimed age ${claimedAge} but is "chhota bhai".` };
      }
    }
  }

  return { passed: true, reason: '', suggestion: '' };
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

export interface GenerateReplyResult {
  text: string;
  metadata: ReplyMetadata;
  needsClarification: boolean;
  clarificationText: string;
}

function makeResult(text: string, metadata?: Partial<ReplyMetadata>, clarification?: { needsClarification: boolean; text: string }): GenerateReplyResult {
  return {
    text,
    metadata: {
      typingDelay: metadata?.typingDelay ?? getTypingDelay(text.length),
      isImportant: metadata?.isImportant ?? isImportantMessage(text),
    },
    needsClarification: clarification?.needsClarification ?? false,
    clarificationText: clarification?.text ?? '',
  };
}

export async function generateReply(
  senderMessage: string,
  conversationHistory: ConversationEntry[] = [],
  senderName?: string,
  senderId?: string
): Promise<GenerateReplyResult> {
  const id = senderId || 'unknown';

  // Prune old entries to prevent memory leaks
  pruneExhaustedSent();

  // Check if ALL providers are on cooldown
  const availableProviders = providers.filter(p => isProviderAvailable(p.name) && !isProviderOnCooldown(p.name));

  if (availableProviders.length === 0) {
    // Already sent exhausted message — try clarification instead of repeating
    if (exhaustedSent[id]) {
      console.log(`⏭️ Skipping reply to ${id} — already sent exhausted message, trying clarification`);
      return makeResult('', {}, { needsClarification: true, text: 'bhai abhi sab AI busy hai, thoda wait karo ya phir se bolo' });
    }

    // First time all providers down — don't send const busy msg, ask for clarification
    console.log(`⚠️ ALL providers down — asking ${id} to rephrase`);
    exhaustedSent[id] = true;
    return makeResult('', {}, { needsClarification: true, text: 'Ami akhon ektu busy achi, ektu pore kotha bolte paren. 🥲' });
  }

  // Reset exhausted flag when providers available
  exhaustedSent[id] = false;

  // Load personality, context, contacts, language examples
  const personality = loadPersonality();
  const context = loadContext();
  const contactsData = loadContacts();
  const contactInfo = contactsData.contacts[id] ? JSON.stringify(contactsData.contacts[id], null, 2) : '';
  const languageExamples = loadLanguageExamples();

  // Analyze conversation context naturally (no hardcoded phrases)
  const conversationContext = getConversationContext(senderMessage, conversationHistory);

  // Check if this is an unknown sender — add name-asking instruction
  const isNewSender = !contactInfo || contactInfo.length < 20;
  const nameAskInstruction = isNewSender && conversationHistory.length <= 2
    ? '\n\n⚠️ NAME DETECTION: This person seems new (you have no saved info about them). If the conversation feels natural and you haven\'t asked yet, casually ask their name sometime soon. Don\'t be robotic — weave it into the conversation naturally. Like "acha btw tumhara naam kya hai?" or at the end of a friendly exchange.'
    : '';

  // Build system prompt
  const timeContext = getTimeContext();
  const systemPrompt = buildSystemPrompt(
    personality,
    context,
    contactInfo,
    languageExamples,
    timeContext,
    conversationContext + nameAskInstruction,
    conversationHistory,
    senderName
  );

  // Try each available provider
  for (const provider of availableProviders) {
    try {
      console.log(`🚀 Trying ${provider.name}...`);
      let reply = await provider.call(systemPrompt, senderMessage);
      let cleaned = cleanReply(reply);

      if (cleaned.length > 0) {
        // Run response guard checks
        const guardResult = runResponseGuardInternal(cleaned, senderMessage, id, conversationHistory);

        if (!guardResult.passed) {
          console.log(`🛡️ Guard blocked reply (${guardResult.reason}): ${guardResult.suggestion}`);
          // Try one more time with guard warning appended to prompt
          const warningPrompt = systemPrompt + `\n\n⚠️ GUARD WARNING: Your previous reply had an issue: ${guardResult.reason}. ${guardResult.suggestion}. Fix this and generate a better reply.`;
          reply = await provider.call(warningPrompt, senderMessage);
          cleaned = cleanReply(reply);
          console.log(`🔄 Regenerated reply: ${cleaned.slice(0, 60)}...`);
        }

        if (cleaned.length > 0) {
          // Track reply
          trackReply(id, cleaned);

          // Record outgoing for duplicate detection
          recordOutgoingInternal(id, cleaned);

          // Save contact info (auto-learn from conversation)
          learnFromConversation(id, senderName, senderMessage, cleaned, conversationHistory);

          console.log(`✅ ${provider.name}: ${cleaned.slice(0, 60)}...`);
          return makeResult(cleaned);
        }
      }
    } catch (err: any) {
      if (is429Error(err)) {
        console.log(`🔑 ${provider.name} 429 — next provider`);
        setProviderCooldown(provider.name);
      } else if (isRetryableError(err)) {
        // Retryable errors (503, 500) are already retried inside the provider functions
        // If we get here, retries also failed — move to next provider
        console.log(`❌ ${provider.name} retryable error after retries: ${err.message}`);
      } else {
        console.log(`❌ ${provider.name} error: ${err.message}`);
      }
    }
  }

  // All providers failed in this round — use clarification mode instead of const message
  console.log(`🤔 All providers failed for ${id} — using clarification mode`);
  return makeResult('', {}, { needsClarification: true, text: 'bhai me samja nhi, ek baar phir se bolna?' });
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
) {
  const existing = loadContacts().contacts[senderId] || {};

  // Save sender name if we don't have it
  if (senderName && !existing.name) {
    existing.name = senderName;
  }

  // Track conversation count
  existing.conversation_count = (existing.conversation_count || 0) + 1;

  // Save last topic (from user message, extract key words)
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

  // Save a summary of last interaction
  existing.last_message_summary = userMessage.slice(0, 100);
  existing.last_reply_summary = aiReply.slice(0, 100);

  saveContact(senderId, existing);
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
  // Cap tracked senders to prevent memory leaks
  const keys = Object.keys(recentReplies);
  if (keys.length >= MAX_TRACKED_SENDERS && !recentReplies[senderId]) {
    // Remove oldest entry (first key)
    delete recentReplies[keys[0]];
  }

  if (!recentReplies[senderId]) recentReplies[senderId] = [];
  recentReplies[senderId].push(reply);
  if (recentReplies[senderId].length > 15) recentReplies[senderId] = recentReplies[senderId].slice(-15);
}

export { loadPersonality, loadContext, saveContact };

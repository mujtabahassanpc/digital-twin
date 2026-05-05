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

// Per-sender reply tracking
const recentReplies: Record<string, string[]> = {};

// Track which senders received the exhausted message
const exhaustedSent: Record<string, boolean> = {};

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
  const ai = new GoogleGenAI({ apiKey: keys[0] });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `${systemPrompt}\n\nUser's latest message: "${userMessage}"\n\nYour reply (remember the rules above):`,
    config: { temperature: 0.8, topP: 0.9, maxOutputTokens: 300 },
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
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 300,
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
      temperature: 0.8,
      max_tokens: 300,
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
      temperature: 0.8,
      max_tokens: 300,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callCohere(systemPrompt: string, userMessage: string): Promise<string> {
  const keys = config.getCohereKeys();
  if (keys.length === 0) throw new Error('No Cohere keys');
  const res = await fetch('https://api.cohere.ai/v1/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${keys[0]}`,
    },
    body: JSON.stringify({
      model: 'command-r',
      message: userMessage,
      preamble: systemPrompt,
      temperature: 0.8,
      max_tokens: 300,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cohere ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.text;
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

// ============================================================
// CLEAN UP AI RESPONSE
// ============================================================

function cleanReply(text: string): string {
  let reply = text.trim();
  // Remove prefixes
  reply = reply.replace(/^(Mahir:|Abher:|Reply:|AI:|Assistant:|Mahir Abher:)/gi, '').trim();
  // Remove quotes
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

export async function generateReply(
  senderMessage: string,
  conversationHistory: ConversationEntry[] = [],
  senderName?: string,
  senderId?: string
): Promise<{ text: string; metadata: ReplyMetadata }> {
  const id = senderId || 'unknown';

  // Check if ALL providers are on cooldown
  const availableProviders = providers.filter(p => isProviderAvailable(p.name) && !isProviderOnCooldown(p.name));

  if (availableProviders.length === 0) {
    // Already sent exhausted message — skip
    if (exhaustedSent[id]) {
      console.log(`⏭️ Skipping reply to ${id} — already sent exhausted message`);
      return { text: '', metadata: { typingDelay: 0, isImportant: false } };
    }

    // First time exhausted — send once
    console.log(`⚠️ ALL providers exhausted — sending const message to ${id}`);
    exhaustedSent[id] = true;
    return {
      text: EXHAUSTED_MESSAGE,
      metadata: { typingDelay: 2000, isImportant: false },
    };
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

  // Build system prompt
  const timeContext = getTimeContext();
  const systemPrompt = buildSystemPrompt(
    personality,
    context,
    contactInfo,
    languageExamples,
    timeContext,
    conversationContext,
    conversationHistory,
    senderName
  );

  // Try each available provider
  for (const provider of availableProviders) {
    try {
      console.log(`🚀 Trying ${provider.name}...`);
      const reply = await provider.call(systemPrompt, senderMessage);
      const cleaned = cleanReply(reply);

      if (cleaned.length > 0) {
        // Track reply
        trackReply(id, cleaned);

        // Save contact info (auto-learn from conversation)
        learnFromConversation(id, senderName, senderMessage, cleaned, conversationHistory);

        console.log(`✅ ${provider.name}: ${cleaned.slice(0, 60)}...`);
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
        console.log(`🔑 ${provider.name} 429 — next provider`);
        setProviderCooldown(provider.name);
      } else {
        console.log(`❌ ${provider.name} error: ${err.message}`);
        setProviderCooldown(provider.name);
      }
    }
  }

  // All providers failed in this round
  if (exhaustedSent[id]) {
    return { text: '', metadata: { typingDelay: 0, isImportant: false } };
  }
  exhaustedSent[id] = true;
  return {
    text: EXHAUSTED_MESSAGE,
    metadata: { typingDelay: 2000, isImportant: false },
  };
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
  if (!recentReplies[senderId]) recentReplies[senderId] = [];
  recentReplies[senderId].push(reply);
  if (recentReplies[senderId].length > 15) recentReplies[senderId] = recentReplies[senderId].slice(-15);
}

export { loadPersonality, loadContext, saveContact };

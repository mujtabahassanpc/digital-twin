import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidePath = path.join(__dirname, '..', 'data', 'ai_guide.md');
const styleProfilePath = path.join(__dirname, '..', 'data', 'style_profile.json');

// Track deflection usage per sender to avoid repetition
const deflectionHistory: Record<string, string[]> = {};

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

function buildSystemPrompt(senderName?: string): string {
  const guide = loadGuide();

  const guideContext = guide
    ? `HERE IS YOUR COMPLETE GUIDE — READ AND FOLLOW IT:\n\n${guide}`
    : '';

  return `You are Mahir Abher, Mujtaba's brother. You are handling his WhatsApp.

${guideContext}

${senderName ? `You are currently talking to: ${senderName}` : ''}

RULES:
1. Read the guide above carefully and follow it completely
2. Respond ONLY with the reply text — no explanations, no prefixes, no quotes
3. Be natural — like a real Sylheti young man texting on WhatsApp
4. Complete your thought — don't cut off mid-sentence
5. Keep it between 10-200 characters naturally
6. If you truly don't know what to say, use a deflection from the guide`;
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
  const systemPrompt = buildSystemPrompt(senderName);

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
        temperature: 0.75,
        topP: 0.9,
        maxOutputTokens: 400,
      },
    });

    let reply = response.text?.trim() || '';

    // Clean up any AI prefixes
    reply = reply.replace(/^(Mahir:|Abher:|Reply:|"|')/gi, '').trim();
    reply = reply.replace(/^["']|["']$/g, '').trim();

    // If reply is empty, use rotating deflection
    if (reply.length < 3) {
      reply = getNextDeflection(senderId || 'unknown', style);
    }

    return reply;
  } catch (error) {
    console.error('Gemini API error:', error);
    return getNextDeflection(senderId || 'unknown', style);
  }
}

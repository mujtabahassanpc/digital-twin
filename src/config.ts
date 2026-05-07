import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

function optionalEnv(key: string, fallback?: string): string {
  return process.env[key] || fallback || '';
}

function parseKeys(envVar: string): string[] {
  return envVar.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
}

export const config = {
  // Gemini AI — single key (legacy)
  geminiApiKey: optionalEnv('GEMINI_API_KEY', ''),
  geminiApiKeys: optionalEnv('GEMINI_API_KEYS', ''),

  // Mistral AI
  mistralApiKeys: optionalEnv('MISTRAL_API_KEYS', ''),

  // Groq AI
  groqApiKeys: optionalEnv('GROQ_API_KEYS', ''),

  // OpenRouter AI
  openRouterApiKeys: optionalEnv('OPENROUTER_API_KEYS', ''),

  // Cohere AI
  cohereApiKeys: optionalEnv('COHERE_API_KEYS', ''),

  // LLM Gateway
  llmgtwyApiKeys: optionalEnv('LLMGTWY_API_KEYS', ''),

  // Neon Database
  databaseUrl: optionalEnv('DATABASE_URL', ''),

  // App Settings
  port: parseInt(process.env.APP_PORT || '3000', 10),
  busyMode: process.env.BUSY_MODE !== 'false',

  // Telegram Bot
  telegramBotToken: optionalEnv('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: optionalEnv('TELEGRAM_CHAT_ID', ''),

  // Feature flags
  isAiReady(): boolean {
    return this.getGeminiKeys().length > 0 || this.getMistralKeys().length > 0 ||
           this.getGroqKeys().length > 0 || this.getOpenRouterKeys().length > 0 ||
           this.getCohereKeys().length > 0 || this.getLlmgtwyKeys().length > 0;
  },

  // Get all active keys for each provider
  getGeminiKeys(): string[] {
    const pool = parseKeys(this.geminiApiKeys);
    if (pool.length > 0) return pool;
    if (this.geminiApiKey) return [this.geminiApiKey];
    return [];
  },

  getMistralKeys(): string[] { return parseKeys(this.mistralApiKeys); },
  getGroqKeys(): string[] { return parseKeys(this.groqApiKeys); },
  getOpenRouterKeys(): string[] { return parseKeys(this.openRouterApiKeys); },
  getCohereKeys(): string[] { return parseKeys(this.cohereApiKeys); },
  getLlmgtwyKeys(): string[] { return parseKeys(this.llmgtwyApiKeys); },

  isDbReady(): boolean { return !!this.databaseUrl; },
  isTelegramReady(): boolean { return !!(this.telegramBotToken && this.telegramChatId); },
};

import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback?: string): string {
  return process.env[key] || fallback || '';
}

export const config = {
  // Gemini AI — single key (legacy)
  geminiApiKey: optionalEnv('GEMINI_API_KEY', ''),

  // Gemini AI — multiple keys pool (comma-separated)
  // Format: GEMINI_API_KEYS=key1,key2,key3
  geminiApiKeys: optionalEnv('GEMINI_API_KEYS', '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0),

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
    return this.getGeminiKeys().length > 0;
  },

  // Get all active Gemini keys (prioritizes pool over single key)
  getGeminiKeys(): string[] {
    if (this.geminiApiKeys.length > 0) return this.geminiApiKeys;
    if (this.geminiApiKey) return [this.geminiApiKey];
    return [];
  },

  isDbReady(): boolean {
    return !!this.databaseUrl;
  },

  isTelegramReady(): boolean {
    return !!(this.telegramBotToken && this.telegramChatId);
  },
};

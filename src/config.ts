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
  // Gemini AI
  geminiApiKey: optionalEnv('GEMINI_API_KEY', ''),

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
    return !!this.geminiApiKey;
  },

  isDbReady(): boolean {
    return !!this.databaseUrl;
  },

  isTelegramReady(): boolean {
    return !!(this.telegramBotToken && this.telegramChatId);
  },
};

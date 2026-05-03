import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const styleProfilePath = path.join(__dirname, '..', 'data', 'style_profile.json');

interface ChatMessage {
  sender: string;
  text: string;
  timestamp?: string;
}

function parseWhatsAppExport(filePath: string): ChatMessage[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const messages: ChatMessage[] = [];

  // WhatsApp export format: [DD/MM/YY, HH:MM:SS] Sender: Message
  const regex = /^\[([\d\/\s:,]+)\]\s*([^:]+):\s*(.+)$/;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      messages.push({
        timestamp: match[1].trim(),
        sender: match[2].trim(),
        text: match[3].trim(),
      });
    }
  }

  return messages;
}

function analyzeStyle(messages: ChatMessage[], userName: string = 'Mujtaba') {
  const myMessages = messages.filter(
    (m) => m.sender === userName
  );

  if (myMessages.length === 0) {
    console.log('No messages found from user:', userName);
    return;
  }

  // Analyze response length
  const lengths = myMessages.map((m) => m.text.length);
  const avgLength = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);

  // Extract common words (filter stop words)
  const stopWords = new Set([
    'aare', 'mmm', 'acha', 'haan', 'naa', 'oy', 'the', 'and', 'or', 'is', 'it',
  ]);
  const wordFreq: Record<string, number> = {};
  for (const msg of myMessages) {
    const words = msg.text.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 2 && !stopWords.has(word)) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    }
  }

  const topSlang = Object.entries(wordFreq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([word]) => word);

  // Extract emoji usage
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
  const emojiFreq: Record<string, number> = {};
  for (const msg of myMessages) {
    const emojis = msg.text.match(emojiRegex) || [];
    for (const emoji of emojis) {
      emojiFreq[emoji] = (emojiFreq[emoji] || 0) + 1;
    }
  }

  const topEmojis = Object.entries(emojiFreq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([emoji]) => emoji);

  // Analyze greetings
  const greetings = myMessages
    .filter((m) => m.text.length < 20)
    .map((m) => m.text.toLowerCase())
    .filter((t) => /^(oy|aare|kita|kamon|assalam|salam|hi|hey|hello)/.test(t));

  // Update existing style profile
  const existingProfile = JSON.parse(fs.readFileSync(styleProfilePath, 'utf-8'));

  // Merge new slang
  const existingSlang = new Set(existingProfile.slang_words || []);
  for (const slang of topSlang) {
    existingSlang.add(slang);
  }

  // Update response style
  existingProfile.response_style = {
    avg_length_chars: avgLength,
    min_length_chars: Math.max(10, avgLength - 40),
    max_length_chars: avgLength + 140,
    avg_sentences: Math.max(1, Math.round(avgLength / 50)),
    use_questions: myMessages.filter((m) => m.text.includes('?')).length > myMessages.length * 0.2,
    match_sender_energy: true,
  };

  // Update slang and emojis
  existingProfile.slang_words = [...existingSlang];
  if (topEmojis.length > 0) {
    existingProfile.common_emojis = topEmojis;
  }
  if (greetings.length > 0) {
    existingProfile.greetings = [...new Set([...existingProfile.greetings, ...greetings])];
  }

  existingProfile.updated_at = new Date().toISOString();
  existingProfile.message_count = myMessages.length;

  fs.writeFileSync(styleProfilePath, JSON.stringify(existingProfile, null, 2));

  console.log('\n=== Style Profile Updated ===');
  console.log(`Messages analyzed: ${myMessages.length}`);
  console.log(`Avg response length: ${avgLength} chars`);
  console.log(`Top slang: ${topSlang.slice(0, 10).join(', ')}`);
  console.log(`Top emojis: ${topEmojis.slice(0, 7).join(' ')}`);
  console.log(`Profile saved to: ${styleProfilePath}`);
}

// Run if called directly
if (process.argv[2]) {
  const filePath = process.argv[2];
  const userName = process.argv[3] || 'Mujtaba';

  console.log(`Analyzing chat export: ${filePath}`);
  console.log(`User name: ${userName}`);

  const messages = parseWhatsAppExport(filePath);
  console.log(`Total messages found: ${messages.length}`);

  analyzeStyle(messages, userName);
}

export { parseWhatsAppExport, analyzeStyle };

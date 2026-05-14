import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDatabase, getPool, closePool } from './db.js';
import { generateReply, getProviderStatuses, isAnyProviderAvailable, getDbCreditsUsed, incrementDbCredits } from './ai.js';
import { saveMessage, getConversationHistory } from './db.js';
import { startWhatsApp, sendWhatsAppMessage, showTyping, sendVoiceMessage, getQRCode, isConnected, whatsappEmitter } from './whatsapp.js';
import { sendInstantAlert, sendImportantConversationAlert, handleTelegramCommand } from './telegram.js';
import { addAlert } from './alertManager.js';
import { recordReply } from './feedback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (dashboard)
app.use(express.static(path.join(rootDir, 'public')));

// WhatsApp Event Handler
const urgentKeywords = ['urgent', 'emergency', 'help', 'zaroori', 'jaldi', 'important', 'problem', 'issue', 'kaam hai', 'madad'];
const importantConversationTriggers = [
  'zaroori baat', 'kaam hai', 'baat karni hai', 'talk to mujtaba',
  'mujtaba se baat', 'need to tell', 'personal baat', 'private',
  'secret', 'kharcha', 'paisa', 'money', 'family', 'shadi',
  'medical', 'hospital', 'accident', 'death', 'marriage',
  'job', 'offer', 'result', 'exam', 'admission',
];

// Voice keywords — user asks Mahir to send voice message
const voiceKeywords = ['voice', 'bol ke', 'sunna', 'awaaz', 'awaz', 'bol ke bhejo', 'voice message', 'apni awaaz', 'apni awaz', 'bol ke suna', 'sunao', 'bolo na', 'voice me', 'bol ke dikha', 'apni voice', 'voice send'];

// Per-chat voice message count (resets on restart)
const voiceCountPerChat: Record<string, number> = {};
const MAX_VOICE_PER_CHAT = 5;

// Message batching — wait 3 sec for more messages from same sender
const messageBuffers: Record<string, { messages: { text: string; timestamp: number }[]; timer: ReturnType<typeof setTimeout> }> = {};
const BATCH_WINDOW_MS = 3000;

// Observe Mode — Mujtaba talks, Mahir watches, learns & summarizes
let observeMode = false;
let observePhone: string | null = null;
let observeStartTime: string | null = null;
let observeTimer: ReturnType<typeof setTimeout> | null = null;
const observedMessages: { role: 'user' | 'mujtaba'; content: string; timestamp: string }[] = [];
const observationsPath = path.join(__dirname, '..', 'data', 'observations.json');
const learnedLangPath = path.join(__dirname, '..', 'data', 'learned_language.json');
const learnedKnowPath = path.join(__dirname, '..', 'data', 'learned_knowledge.json');

function resetObserveTimer() {
  if (observeTimer) clearTimeout(observeTimer);
  // Auto-finalize after 5 min of inactivity
  observeTimer = setTimeout(() => {
    if (observeMode && observedMessages.length > 0) {
      console.log(`⏰ Observe auto-finalized — ${observePhone} inactive for 5 min`);
      finalizeObservation();
    }
  }, 5 * 60 * 1000);
}

function finalizeObservation() {
  if (observedMessages.length > 0) {
    saveObservation();
    generateObservationSummary();
  }
  observeMode = false;
  observePhone = null;
  observeStartTime = null;
  observedMessages.length = 0;
  if (observeTimer) { clearTimeout(observeTimer); observeTimer = null; }
}

function toggleObserve(phone: string | null): string {
  if (!phone) {
    finalizeObservation();
    return '🔍 Observe mode OFF. Full summary saved.';
  }
  // Turn on — save previous observation first if switching
  if (observeMode && observedMessages.length > 0) {
    saveObservation();
    generateObservationSummary();
  }
  observeMode = true;
  observePhone = phone;
  observeStartTime = new Date().toISOString();
  observedMessages.length = 0;
  resetObserveTimer();
  return `🔍 Observe mode ON for ${phone}. Mahir will watch, learn & summarize.`;
}

function saveObservation() {
  if (observedMessages.length === 0) return;
  let all: any[] = [];
  try { all = JSON.parse(fs.readFileSync(observationsPath, 'utf-8')); } catch { /* new file */ }
  all.push({
    phone: observePhone,
    startedAt: observeStartTime,
    endedAt: new Date().toISOString(),
    messages: [...observedMessages],
  });
  if (all.length > 50) all = all.slice(-50);
  fs.writeFileSync(observationsPath, JSON.stringify(all, null, 2));
  console.log(`📝 Observation saved for ${observePhone} (${observedMessages.length} messages)`);
}

function generateObservationSummary() {
  if (observedMessages.length < 2) return;
  const mujtabaMsgs = observedMessages.filter(m => m.role === 'mujtaba');
  const userMsgs = observedMessages.filter(m => m.role === 'user');
  if (mujtabaMsgs.length === 0) return;

  const totalMsgs = observedMessages.length;
  const userCount = userMsgs.length;
  const mujtabaCount = mujtabaMsgs.length;
  const allText = observedMessages.map(m => m.content).join(' ');
  const allLower = allText.toLowerCase();

  // ─── Deep Language Pattern Extraction ──────────────────────
  const commonFillers = ['acha','hmm','oy','haan','naa','thik','bhai','arey','aare','ha','hn','ji','accha','theek','arre'];
  const fillerFreq: Record<string, number> = {};
  for (const m of observedMessages) {
    for (const w of m.content.toLowerCase().split(/\s+/)) {
      if (commonFillers.includes(w)) fillerFreq[w] = (fillerFreq[w] || 0) + 1;
    }
  }

  // Sentence starters (first 2 words of each message)
  const starters: string[] = [];
  for (const m of observedMessages) {
    const words = m.content.trim().split(/\s+/);
    if (words.length >= 2) starters.push(words.slice(0, 2).join(' ').toLowerCase());
    else if (words.length === 1) starters.push(words[0].toLowerCase());
  }

  // Common phrases (recurring 2-3 word sequences from Mujtaba)
  const phraseCounts: Record<string, number> = {};
  for (const m of mujtabaMsgs) {
    const words = m.content.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = words[i] + ' ' + words[i+1];
      phraseCounts[bigram] = (phraseCounts[bigram] || 0) + 1;
      if (i < words.length - 2) {
        const trigram = words[i] + ' ' + words[i+1] + ' ' + words[i+2];
        phraseCounts[trigram] = (phraseCounts[trigram] || 0) + 1;
      }
    }
  }
  const commonPhrases = Object.entries(phraseCounts)
    .filter(([, c]) => c >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([p]) => p);

  // Language mix detection
  const bengaliWords = allText.match(/[অআইঈউঊঋএঐওঔকখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়ৎংঃঁািীুূৃেৈোৌ]/g);
  const englishWords = allText.match(/[a-zA-Z]{3,}/g);
  const langMix = bengaliWords && bengaliWords.length > 5 ? 'sylheti/bangla mixed' : 'hinglish/english';
  const hasEnglish = englishWords && englishWords.length > 3;

  // Question style
  const mujtabaQs = mujtabaMsgs.filter(m => m.content.includes('?'));
  const questionStyle = mujtabaQs.length > 0 ? 'yes' : 'no';
  const questionWords = mujtabaQs.map(m => {
    const q = m.content.toLowerCase();
    if (q.includes('kyu')) return 'kyu';
    if (q.includes('kya')) return 'kya';
    if (q.includes('kaise')) return 'kaise';
    if (q.includes('kab')) return 'kab';
    if (q.includes('kaha')) return 'kaha';
    if (q.includes('kon')) return 'kon';
    return 'other';
  });

  // ─── Knowledge Extraction ──────────────────────────────────
  const knowledgeFacts: string[] = [];
  for (const m of userMsgs) {
    const lower = m.content.toLowerCase();
    // Personal info patterns
    const studyMatch = lower.match(/(study|padh|college|school|university|class|exam|semester|subject|teacher|lecture)/);
    if (studyMatch) knowledgeFacts.push(`Education: user mentioned ${studyMatch[1]}`);
    const workMatch = lower.match(/(job|work|office|company|boss|client|salary|business|profession)/);
    if (workMatch) knowledgeFacts.push(`Work: user mentioned ${workMatch[1]}`);
    const familyMatch = lower.match(/(maa|baap|dad|mom|father|mother|bhai|brother|didi|sister|wife|bibi|family|chacha|mama|khalu)/);
    if (familyMatch) knowledgeFacts.push(`Family: user mentioned ${familyMatch[1]}`);
    const healthMatch = lower.match(/(health|hospital|doctor|medical|sick|ill|pain|fever|cough|cold|operation|surgery|medicine|tablet)/);
    if (healthMatch) knowledgeFacts.push(`Health: user mentioned ${healthMatch[1]}`);
    const moneyMatch = lower.match(/(paisa|money|payment|bill|cost|price|rent|fee|loan|expense|salary)/);
    if (moneyMatch) knowledgeFacts.push(`Finance: user mentioned ${moneyMatch[1]}`);
    const timeMatch = lower.match(/(kal|aaj|aajkal|today|tomorrow|yesterday|next week|next month|saturday|sunday|monday|time|schedule)/);
    if (timeMatch) knowledgeFacts.push(`Time: user mentioned ${timeMatch[1]}`);
    // Named entities (capitalized words that aren't start-of-sentence)
    const words = m.content.split(/\s+/);
    for (const w of words) {
      if (/^[A-Z][a-z]{2,}$/.test(w) && !['The','Aap','Ami','Tumi','Amar','Tomar','Akhon','Ektu','Kemon','Keno','Kintu'].includes(w)) {
        knowledgeFacts.push(`Entity: mentioned "${w}"`);
        break;
      }
    }
  }
  const uniqueFacts = [...new Set(knowledgeFacts)].slice(0, 20);

  // ─── Conversation Dynamics ─────────────────────────────────
  const avgMujtabaLen = Math.round(mujtabaMsgs.reduce((s, m) => s + m.content.length, 0) / mujtabaMsgs.length);
  const avgUserLen = userMsgs.length > 0 ? Math.round(userMsgs.reduce((s, m) => s + m.content.length, 0) / userMsgs.length) : 0;
  const topics = [...new Set(uniqueFacts.map(f => f.split(':')[0].trim()))];

  // ─── Save Global Language Patterns ──────────────────────────
  const langData = { patterns: { filler_freq: fillerFreq, common_sentence_starters: [...new Set(starters)].slice(0, 10), common_phrases: commonPhrases, language_mix: langMix, uses_english: hasEnglish, mujtaba_asks_questions: questionStyle, question_words: [...new Set(questionWords)], avg_reply_length_chars: avgMujtabaLen }, last_updated: new Date().toISOString(), source_phone: observePhone };
  try {
    let existing: any = { patterns: {} };
    try { existing = JSON.parse(fs.readFileSync(learnedLangPath, 'utf-8')); } catch { /* new file */ }
    // Merge: keep existing patterns, add/update new ones
    for (const [k, v] of Object.entries(langData.patterns)) {
      if (Array.isArray(v)) {
        const existingArr = (existing.patterns[k] as string[]) || [];
        existing.patterns[k] = [...new Set([...v, ...existingArr])].slice(0, 30);
      } else if (typeof v === 'object' && v !== null) {
        existing.patterns[k] = { ...existing.patterns[k], ...v } as any;
      } else {
        (existing.patterns as any)[k] = v;
      }
    }
    existing.last_updated = new Date().toISOString();
    existing.source_phone = observePhone;
    fs.writeFileSync(learnedLangPath, JSON.stringify(existing, null, 2));
    console.log(`🌐 Global language patterns saved (${commonPhrases.length} phrases, ${Object.keys(fillerFreq).length} fillers)`);
  } catch (e) { console.log('⚠️ Failed to save language patterns:', e); }

  // ─── Save Global Knowledge ──────────────────────────────────
  if (uniqueFacts.length > 0) {
    try {
      let knowData: any[] = [];
      try { knowData = JSON.parse(fs.readFileSync(learnedKnowPath, 'utf-8')); } catch { /* new file */ }
      for (const fact of uniqueFacts) {
        const existingEntry = knowData.find((e: any) => e.fact === fact);
        if (existingEntry) {
          existingEntry.count = (existingEntry.count || 1) + 1;
          existingEntry.last_seen = new Date().toISOString();
        } else {
          knowData.push({ fact, category: fact.split(':')[0].trim(), source_phone: observePhone, learned_at: new Date().toISOString(), last_seen: new Date().toISOString(), count: 1 });
        }
      }
      if (knowData.length > 200) knowData = knowData.slice(-200);
      fs.writeFileSync(learnedKnowPath, JSON.stringify(knowData, null, 2));
      console.log(`🧠 Global knowledge saved (${uniqueFacts.length} facts)`);
    } catch (e) { console.log('⚠️ Failed to save knowledge:', e); }
  }

  // ─── Build Per-Contact Summary ──────────────────────────────
  const summaryParts: string[] = [];
  summaryParts.push(`📋 OBSERVED CONVERSATION SUMMARY (${totalMsgs} msgs, ${userCount} user + ${mujtabaCount} Mujtaba):`);
  if (topics.length > 0) summaryParts.push(`Topics discussed: ${topics.join(', ')}.`);
  if (uniqueFacts.length > 0) summaryParts.push(`Known facts: ${uniqueFacts.slice(0, 8).join('; ')}.`);
  summaryParts.push(`Mujtaba's style: avg ${avgMujtabaLen} chars/reply, ${questionStyle === 'yes' ? 'asks questions' : 'mostly statements'}. Language: ${langMix}.`);
  if (commonPhrases.length > 0) summaryParts.push(`Common phrases: ${commonPhrases.slice(0, 8).join(', ')}.`);
  if (Object.keys(fillerFreq).length > 0) summaryParts.push(`Fillers: ${Object.entries(fillerFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, c]) => `${w}(${c}x)`).join(', ')}.`);

  // Condensed flow
  const segments: string[] = [];
  let currentSegment = '';
  let lastSpeaker = '';
  for (const m of observedMessages) {
    const speaker = m.role === 'mujtaba' ? 'M' : 'U';
    if (speaker !== lastSpeaker && currentSegment) { segments.push(currentSegment.trim()); currentSegment = ''; }
    currentSegment += `${speaker}: ${m.content} | `;
    lastSpeaker = speaker;
  }
  if (currentSegment) segments.push(currentSegment.trim());
  summaryParts.push(`Flow (${segments.length} exchanges):`);
  segments.slice(0, 10).forEach((seg, i) => summaryParts.push(`  ${i + 1}. ${seg.slice(0, 130)}...`));

  const fullSummary = summaryParts.join('\n');

  // Save to contacts
  if (!observePhone) return;
  const contactsPath = path.join(__dirname, '..', 'data', 'contacts.json');
  try {
    const data = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
    if (!data.contacts[observePhone]) data.contacts[observePhone] = {};
    const contact = data.contacts[observePhone];
    contact.observation_summary = fullSummary;
    contact.observed_style = {
      avg_reply_length: avgMujtabaLen,
      user_avg_length: avgUserLen,
      uses_questions: questionStyle === 'yes',
      mujtaba_fillers: Object.keys(fillerFreq),
      detected_topics: topics,
      common_phrases: commonPhrases.slice(0, 10),
      language_mix: langMix,
      total_messages: totalMsgs,
      last_observed: new Date().toISOString(),
    };
    if (topics.length > 0) contact.last_topic = topics[0];
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(contactsPath, JSON.stringify(data, null, 2));
    console.log(`📚 Per-contact summary saved for ${observePhone} — ${totalMsgs} msgs, ${uniqueFacts.length} facts`);
  } catch { /* silent */ }
}

function processBatchedMessage(
  senderId: string,
  senderName: string,
  combinedText: string
): Promise<void> {
  const batchStartTime = Date.now();
  return (async () => {
    try {
      // Save incoming message (combined)
      await saveMessage(senderId, senderName, 'incoming', combinedText, false);
      incrementDbCredits();

      // Observe mode: save incoming message without auto-replying
      if (observeMode && observePhone === senderId) {
        observedMessages.push({ role: 'user', content: combinedText, timestamp: new Date().toISOString() });
        resetObserveTimer();
        console.log(`🔍 Observe: User (${senderName}) said: "${combinedText.slice(0, 60)}..."`);
        return;
      }

      const lower = combinedText.toLowerCase();
      const isImportant = importantConversationTriggers.some((phrase) => lower.includes(phrase));

      if (isImportant) {
        console.log(`🔔 Important conversation from ${senderName} (${senderId})`);

        const history = await getConversationHistory(senderId, 5);
        const context = history.map((h: any) => `${h.role === 'user' ? '👤' : '🤖'} ${h.content}`).join('\n');

        await sendImportantConversationAlert(senderName, senderId, context || 'No recent history');

        await showTyping(senderId, 2000);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const reply = 'acha bolbo, me sun raha hu 🤲';
        await sendWhatsAppMessage(senderId, reply);
        await saveMessage(senderId, undefined, 'outgoing', reply, true);
        return;
      }

      // Telegram instant alert for urgent keywords
      if (urgentKeywords.some((kw) => lower.includes(kw))) {
        console.log('🚨 URGENT message detected — sending Telegram alert');
        await sendInstantAlert(senderName, combinedText, 'Urgent keywords detected');
      }

      // Check busy mode
      if (!config.busyMode) {
        console.log('⏸️ Busy mode OFF — not auto-replying');
        return;
      }

      // --- Pre-process short greetings: "Jii?", "Hello?" etc → simple reply, no LLM ---
      const greetingOnlyPattern = /^(jii\??|ji\??|hello\??|hmm\??|hm\??|oye\??|arey\??|hallo\??|hey\??)$/i;
      if (greetingOnlyPattern.test(combinedText.trim())) {
        const greetingReplies = ['Jii, kemon acho?', 'Jii, bolun.', 'Hmm, bolun.', 'Jii, bolen kya baat hai?'];
        const reply = greetingReplies[Math.floor(Math.random() * greetingReplies.length)];
        console.log(`👋 Greeting-only detected — simple reply`);
        await showTyping(senderId, 1000);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await sendWhatsAppMessage(senderId, reply);
        await saveMessage(senderId, undefined, 'outgoing', reply, true);
        return;
      }

      // Get conversation history
      const history = await getConversationHistory(senderId, 10);

      // Generate AI reply with metadata
      const result = await generateReply(combinedText, history, senderName, senderId);

      // --- Enhanced End Enforcer: Detect conversation ending & energy ---
      const recentUserMsgs = history.filter(e => e.role === 'user').slice(-3);
      const currentMsgShort = combinedText.trim().length <= 3;
      const allShort = recentUserMsgs.length >= 2 && recentUserMsgs.every(e => e.content.trim().length <= 5);
      const noQuestion = !recentUserMsgs.some(e => e.content.includes('?'));
      const replyIsLong = result.text && result.text.split(' ').length > 12;

      // Level 1: Single-word ending ("ok", "hmm", "k") → ultra short reply
      if (currentMsgShort && combinedText.trim().toLowerCase().match(/^(ok|hmm|hm|mm|k|hn|na|acha|thik|oh|haan|haa)$/)) {
        const acknowledgments = ['thik ache', 'acha', 'mm', 'thik hai'];
        result.text = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
        console.log('✂️ Ultra-short ending detected — single-word acknowledgment');
      }
      // Level 2: User consistently giving short replies → trim to last complete sentence
      else if (allShort && noQuestion && replyIsLong) {
        const words = result.text.split(' ');
        const trimmed = words.slice(0, 12).join(' ').trim();
        // Find last sentence-ending punctuation before 12th word, cut there
        const lastSentenceEnd = Math.max(trimmed.lastIndexOf('.'), trimmed.lastIndexOf('!'), trimmed.lastIndexOf('?'));
        if (lastSentenceEnd > 0) {
          result.text = trimmed.slice(0, lastSentenceEnd + 1);
        } else {
          // No sentence break found — keep only if it's a complete thought, otherwise send acknowledgment
          const acknowledgments = ['thik ache', 'acha', 'thik hai', 'hmm'];
          result.text = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
        }
        console.log('✂️ Reply trimmed to complete sentence (end enforcer)');
      }

      // --- Serious mode: Detect urgent/harsh keywords → remove jokes/emojis ---
      const seriousKeywords = ['death', 'died', 'mar gaya', 'accident', 'hospital', 'operation', 'critical', 'surgery', 'loss', 'passed away', 'innalillahi', 'condolence'];
      const isSerious = seriousKeywords.some(kw => combinedText.toLowerCase().includes(kw));
      if (isSerious && result.text) {
        result.text = result.text
          .replace(/[😀-🙏🀄-🧀🗨-🛿]/gu, '')
          .replace(/😂|😅|🤣|😆|😁/g, '')
          .replace(/lol|haha|hehe/gi, '')
          .trim();
        console.log('🕊️ Serious mode — jokes/emojis removed');
      }

      // Handle clarification needed — Mahir asks user to rephrase AND tells Mujtaba
      if (result.needsClarification) {
        console.log(`🤔 Mahir confused — asking for clarification from ${senderName}`);

        // Send clarification request to user
        const clarificationMsg = result.clarificationText || 'bhai me samja nhi, ek baar phir se bolna?';
        await showTyping(senderId, 1500);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await sendWhatsAppMessage(senderId, clarificationMsg);
        await saveMessage(senderId, undefined, 'outgoing', clarificationMsg, true);

        // Buffer alert for Telegram digest
        addAlert('confusion', senderName, senderId, combinedText, `Recent: ${history.slice(-2).map((h: any) => h.content).join(' | ')}`);

        // --- Save to learning queue (async) ---
        const queuePath = path.join(__dirname, '..', 'data', 'learning_queue.json');
        try {
          const raw = await fs.promises.readFile(queuePath, 'utf-8').catch(() => '[]');
          let queue = JSON.parse(raw);
          queue.push({
            timestamp: new Date().toISOString(),
            senderId,
            senderName,
            userMessage: combinedText,
            context: history.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n'),
            status: 'new',
          });
          if (queue.length > 50) queue = queue.slice(-50);
          await fs.promises.writeFile(queuePath, JSON.stringify(queue, null, 2));
        } catch { /* silent */ }

        return;
      }

      // Skip if no reply (already sent exhausted message)
      if (!result.text) {
        console.log(`⏭️ Skipping reply to ${senderName} — already sent exhausted message`);
        return;
      }

      // Split reply into multiple messages if needed
      const messages = splitIntoMessages(result.text);

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const delay = getTypingDelay(msg.length, combinedText, senderId);

        if (i > 0) {
          // Realistic pause between messages (human-like: 1-3 sec)
          const pause = 1000 + Math.random() * 2000;
          await new Promise((resolve) => setTimeout(resolve, pause));
        }

        await showTyping(senderId, delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await sendWhatsAppMessage(senderId, msg);
        await saveMessage(senderId, undefined, 'outgoing', msg, true);
      }

      // Track reply timing per contact
      const timings = contactTypingCache.get(senderId) || [];
      timings.push(Date.now() - batchStartTime);
      if (timings.length > MAX_TIMING_SAMPLES) timings.shift();
      contactTypingCache.set(senderId, timings);

      console.log(`💬 AI Reply to ${senderName} (${messages.length} message(s)): ${result.text.slice(0, 80)}...`);

      // Record reply in feedback buffer (for /rate command)
      recordReply(senderId, senderName, combinedText, result.text);

      // --- Script execution report → buffer for digest ---
      if (result.scriptTriggered) {
        addAlert('script_executed', senderName, senderId, result.scriptTriggered, `Mahir replied: "${result.text.slice(0, 150)}"`);
        const { markScriptReported } = await import('./ai.js');
        markScriptReported(senderId);
      }

      // --- "Acha Bolbo" / Inform Promise Detection → buffer for digest ---
      if (result.hasInformPromise) {
        addAlert('inform_promise', senderName, senderId, combinedText, `Mahir replied: "${result.text.slice(0, 150)}"`);
      }

      // --- Name learned → ask Mujtaba for confirmation ---
      if (result.nameLearned) {
        addAlert('name_learned', result.nameLearned.name, result.nameLearned.phone,
          `Mahir learned a new name: "${result.nameLearned.name}" (${result.nameLearned.phone})`,
          `Use /confirmname ${result.nameLearned.phone} <name> <relation> to confirm.\nUse /rejectname ${result.nameLearned.phone} to reject.\n\nThen /nameguide ${result.nameLearned.phone} <guide> to tell Mahir how to talk to them.`
        );
      }

      // --- Voice Reply — user asked Mahir to send voice ---
      const userWantsVoice = voiceKeywords.some(kw => lower.includes(kw));
      if (userWantsVoice && config.getSarvamKeys().length > 0) {
        const currentCount = voiceCountPerChat[senderId] || 0;
        if (currentCount < MAX_VOICE_PER_CHAT) {
          console.log(`🎤 ${senderName} asked for voice (${currentCount + 1}/${MAX_VOICE_PER_CHAT})`);
          const { generateSpeech } = await import('./ai.js');
          const audioBuffer = await generateSpeech(result.text);
          if (audioBuffer) {
            await sendVoiceMessage(senderId, audioBuffer);
            voiceCountPerChat[senderId] = currentCount + 1;
            // Send second voice if under limit
            if (currentCount + 1 < MAX_VOICE_PER_CHAT && result.text.length > 60) {
              const secondText = result.text.length > 120
                ? result.text.split(/[.!?\n]/).filter(Boolean).slice(1, 2).join('. ') || 'thik hai'
                : 'acha thik hai';
              const secondAudio = await generateSpeech(secondText);
              if (secondAudio) {
                await new Promise(r => setTimeout(r, 1500));
                await sendVoiceMessage(senderId, secondAudio);
                voiceCountPerChat[senderId] = currentCount + 2;
              }
            }
          }
        } else {
          console.log(`⏭️ Voice limit reached for ${senderName} (${MAX_VOICE_PER_CHAT})`);
        }
      }
      // --- Cliffhanger follow-up: user trails off with ... or ? ---
      const trimmed = combinedText.trim();
      const isCliffhanger = /\.{2,}\s*$/.test(trimmed) || (trimmed.endsWith('?') && trimmed.split(/\s+/).length <= 4);
      const replyHasQuestion = result.text && /[?]/.test(result.text);
      if (isCliffhanger && !replyHasQuestion && !result.hasInformPromise && !result.scriptTriggered) {
        const followUps = ['Aur phir kya?', 'Phir kya hua?', 'Aage batao na?', 'Hmm, aur?', 'Achha, phir?', 'Matlab?'];
        const followUp = followUps[Math.floor(Math.random() * followUps.length)];
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        await showTyping(senderId, 1200);
        await new Promise(r => setTimeout(r, 1200));
        await sendWhatsAppMessage(senderId, followUp);
        await saveMessage(senderId, undefined, 'outgoing', followUp, true);
        console.log(`🔚 Cliffhanger follow-up sent to ${senderName}: "${followUp}"`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  })();
}

const complexityWords = [
  'kyunki', 'wajah', 'actually', 'basically', 'however', 'although',
  'therefore', 'meanwhile', 'nevertheless', 'particularly',
  'situation', 'understanding', 'experience', 'relationship',
  'responsibility', 'communication',
];

function getTypingDelay(
  msgLen: number,
  incomingMsg?: string,
  senderId?: string,
): number {
  let base: number;
  if (msgLen <= 10) base = 700 + Math.random() * 500;
  else if (msgLen <= 30) base = 1000 + Math.random() * 800;
  else if (msgLen <= 80) base = 1500 + Math.random() * 1000;
  else base = 2200 + Math.random() * 1500;

  // #1: If incoming message has typos, add "correcting" pause
  if (incomingMsg) {
    const words = incomingMsg.split(/\s+/);
    const typoCount = words.filter(w => {
      if (w.length < 3) return false;
      const normalized = w.toLowerCase().replace(/[^a-z]/g, '');
      // Simple typo heuristic: repeated letters, missing common chars
      if (/(.)\1{2,}/.test(normalized)) return true; // "hellooo"
      if (/^[^aeiou]{4,}$/.test(normalized)) return true; // "thghl" no vowels
      return false;
    }).length;

    if (typoCount > 0) {
      base += typoCount * 600 + Math.random() * 400;
    }
  }

  // #2: Complex message → longer thinking pause
  if (incomingMsg) {
    const questionCount = (incomingMsg.match(/\?/g) || []).length;
    const complexWordCount = complexityWords.filter(w =>
      incomingMsg.toLowerCase().includes(w)
    ).length;

    if (questionCount >= 2 || complexWordCount > 0 || incomingMsg.length > 150) {
      base += 800 + Math.random() * 700;
    }
  }

  // #3: Cliffhanger — incomplete message ending with ...
  if (incomingMsg && /\.{3,}\s*$/.test(incomingMsg.trim())) {
    base += 1200 + Math.random() * 800;
  }

  // #4: Vary by contact — store avg reply time per sender
  const contactTimings = contactTypingCache.get(senderId || '');
  if (contactTimings && contactTimings.length > 3) {
    const avg = contactTimings.reduce((a, b) => a + b, 0) / contactTimings.length;
    // If user typically replies fast, Mahir replies slightly faster too
    if (avg < 3000) base = base * 0.85;
    else if (avg > 10000) base = base * 1.15;
  }

  return Math.round(Math.max(500, base));
}

// Track per-contact reply timings for natural pacing
const contactTypingCache = new Map<string, number[]>();
const MAX_TIMING_SAMPLES = 10;


function splitIntoMessages(text: string): string[] {
  // If short, just one message
  if (text.length <= 80) return [text];

  // Split on sentence boundaries (。 ! ? . \n)
  const sentences = text.split(/([.!?\n]+)/);
  const chunks: string[] = [];
  let current = '';

  for (const part of sentences) {
    if (current.length + part.length > 120 && current.length > 20) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Cap at 3 messages max — merge extras into last
  if (chunks.length > 3) {
    const last = chunks.slice(2).join(' ');
    chunks.length = 2;
    chunks.push(last);
  }

  return chunks.filter(m => m.length > 0);
}

// Observe: when Mujtaba replies, save for learning
whatsappEmitter.on('own-message', (data: { senderId: string; text: string }) => {
  if (observeMode && observePhone === data.senderId) {
    observedMessages.push({ role: 'mujtaba', content: data.text, timestamp: new Date().toISOString() });
    resetObserveTimer();
    console.log(`🔍 Observe: Mujtaba replied to ${data.senderId}: "${data.text.slice(0, 60)}..."`);
  }
});

whatsappEmitter.on('message', async (data: { senderId: string; senderName: string; text: string }) => {
  try {
    const { senderId, senderName, text } = data;

    // Initialize buffer for this sender
    if (!messageBuffers[senderId]) {
      messageBuffers[senderId] = { messages: [], timer: undefined as any };
    }

    const buffer = messageBuffers[senderId];
    buffer.messages.push({ text, timestamp: Date.now() });

    // Clear existing timer
    clearTimeout(buffer.timer);

    // Set timer to process batch after window
    buffer.timer = setTimeout(() => {
      const combined = buffer.messages.map(m => m.text).join('\n');
      delete messageBuffers[senderId];
      processBatchedMessage(senderId, senderName, combined);
    }, BATCH_WINDOW_MS);
  } catch (error) {
    console.error('Error batching message:', error);
  }
});

// Telegram Bot Polling (commands)
let telegramUpdateOffset = 0;
async function pollTelegram() {
  if (!config.isTelegramReady()) return;

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${telegramUpdateOffset}&timeout=5`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        telegramUpdateOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg || !msg.text) continue;

        if (msg.text.startsWith('/')) {
          const parts = msg.text.substring(1).split(' ');
          const command = parts[0].toLowerCase();
          const args = parts.slice(1).join(' ');
          console.log(`📩 Telegram command: /${command} ${args}`);
          await handleTelegramCommand(command, args);
        } else {
          // Plain text — check for alert-summary keywords
          const lower = msg.text.toLowerCase();
          if (/^(kya hua|kuch bata|bol|alerts|digest do|summary|kya chal raha|update)/i.test(lower)) {
            const { getPendingCount, flushAndSend } = await import('./alertManager.js');
            if (getPendingCount() > 0) {
              await flushAndSend('📋 Flushed on user request');
            } else {
              const { sendTelegramMessage } = await import('./telegram.js');
              await sendTelegramMessage('📋 Koi pending alert nahi hai. Sab normal hai.');
            }
          }
        }

        // Handle callback queries (button clicks)
        if (update.callback_query) {
          const cb = update.callback_query;
          if (cb.data === 'toggle_busy') {
            config.busyMode = !config.busyMode;
            const url2 = `https://api.telegram.org/bot${config.telegramBotToken}/answerCallbackQuery`;
            await fetch(url2, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cb.id, text: `Busy mode: ${config.busyMode ? 'ON' : 'OFF'}` }),
            });
            await handleTelegramCommand('status', '');
          }
        }
      }
    }
  } catch (error) {
    console.error('Telegram poll error:', error);
  }

  // Poll every 3 seconds
  setTimeout(pollTelegram, 3000);
}

// Start WhatsApp connection
startWhatsApp().catch((err) => console.error('Failed to start WhatsApp:', err));

// Start Telegram polling
setTimeout(pollTelegram, 2000);

// Routes
app.get('/api/qr', (_req, res) => {
  const qr = getQRCode();
  res.json({ qr, status: isConnected() ? 'connected' : qr ? 'scan_needed' : 'connecting' });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      whatsapp: isConnected(),
      ai: config.isAiReady(),
      database: config.isDbReady(),
      telegram: config.isTelegramReady(),
    },
    busyMode: config.busyMode,
  });
});

// Provider health dashboard
app.get('/api/providers', (_req, res) => {
  const statuses = getProviderStatuses();
  res.json({
    timestamp: new Date().toISOString(),
    providers: statuses,
    anyAvailable: isAnyProviderAvailable(),
    dbCreditsUsed: getDbCreditsUsed(),
  });
});

app.get('/api/test', (_req, res) => {
  res.json({
    status: 'ok',
    busyMode: config.busyMode,
    whatsappConnected: isConnected(),
    aiReady: config.isAiReady(),
    dbReady: config.isDbReady(),
    telegramReady: config.isTelegramReady(),
  });
});

app.post('/api/toggle', (_req, res) => {
  config.busyMode = !config.busyMode;
  res.json({ busyMode: config.busyMode });
});

app.post('/api/digest', async (_req, res) => {
  const { sendDailyDigest } = await import('./telegram.js');

  try {
    const pool = getPool();

    const today = new Date().toISOString().split('T')[0];
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM conversations WHERE DATE(timestamp) = $1`,
      [today]
    );
    const totalMessages = parseInt(totalResult.rows[0].count);

    const contactsResult = await pool.query(
      `SELECT sender_name, COUNT(*) as count FROM conversations WHERE DATE(timestamp) = $1 GROUP BY sender_name ORDER BY count DESC LIMIT 5`,
      [today]
    );
    const topContacts = contactsResult.rows.map((r) => ({
      name: r.sender_name || 'Unknown',
      count: parseInt(r.count),
    }));

    const importantResult = await pool.query(
      `SELECT sender_name, content FROM conversations WHERE DATE(timestamp) = $1 AND LENGTH(content) > 50 AND message_type = 'incoming' ORDER BY timestamp DESC LIMIT 5`,
      [today]
    );
    const importantHighlights = importantResult.rows.map(
      (r) => `${r.sender_name || 'Unknown'}: ${r.content.substring(0, 100)}`
    );

    const sent = await sendDailyDigest({
      totalMessages,
      uniqueContacts: topContacts.length,
      topContacts,
      importantHighlights,
      date: new Date().toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    });

    res.json({ success: sent, message: sent ? 'Digest sent to Telegram' : 'Failed to send digest' });
  } catch (error) {
    console.error('Digest error:', error);
    res.status(500).json({ error: 'Failed to generate digest' });
  }
});

// Learning Queue API
app.get('/api/learning-queue', (_req, res) => {
  const queuePath = path.join(__dirname, '..', 'data', 'learning_queue.json');
  try {
    const raw = fs.readFileSync(queuePath, 'utf-8');
    const queue = JSON.parse(raw);
    const pending = queue.filter((item: any) => item.status === 'new').slice(-20);
    res.json({ total: queue.length, pending: pending.length, items: pending });
  } catch {
    res.json({ total: 0, pending: 0, items: [] });
  }
});

app.post('/api/learning-queue/approve', async (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number') return res.status(400).json({ error: 'index required' });

  const queuePath = path.join(__dirname, '..', 'data', 'learning_queue.json');
  const langPath = path.join(__dirname, '..', 'data', 'language_examples.json');

  try {
    const raw = fs.readFileSync(queuePath, 'utf-8');
    const queue = JSON.parse(raw);
    const pending = queue.filter((item: any) => item.status === 'new');
    if (index < 0 || index >= pending.length) return res.status(404).json({ error: 'Item not found' });

    const item = pending[index];
    item.status = 'approved';

    // Add to language examples
    const langRaw = fs.readFileSync(langPath, 'utf-8');
    const lang = JSON.parse(langRaw);
    lang.examples.push({
      message: item.userMessage,
      reason: `Auto-learned: ${item.senderName} said "${item.userMessage.slice(0, 50)}"`,
      added_at: new Date().toISOString(),
    });
    lang.last_updated = new Date().toISOString();

    fs.writeFileSync(langPath, JSON.stringify(lang, null, 2));
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

    res.json({ success: true, message: 'Approved and added to language examples' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all for SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'index.html'));
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { toggleObserve };
export default app;

// Start server if running directly
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  async function start() {
    try {
      await initDatabase();

      // Start DB size monitoring (check every 6 hours)
      if (config.isDbReady()) {
        checkDbSize();
        setInterval(checkDbSize, 6 * 60 * 60 * 1000);
      }

      // Start schedule checker (every 30 seconds)
      startScheduleChecker();

      const PORT = config.port;
      app.listen(PORT, () => {
        console.log(`\n🤖 Mahir Abher (Mujtaba ka Bhai) running on http://localhost:${PORT}`);
        console.log(`   WhatsApp: ${isConnected() ? '✅ Connected' : '⏳ Waiting for scan...'}`);
        console.log(`   AI (Gemini): ${config.isAiReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Database (Neon): ${config.isDbReady() ? '✅ Ready' : '⏳ Not configured'}`);
        console.log(`   Telegram: ${config.isTelegramReady() ? '✅ Ready (polling commands)' : '⏳ Not configured'}`);
        console.log(`   Busy Mode: ${config.busyMode ? 'ON (Mahir auto-replies)' : 'OFF'}`);
        console.log(`\n   QR Code: GET /api/qr`);
        console.log(`   Dashboard: GET /\n`);
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  start();
}

// DB Size Monitoring
let dbAlertSent80 = false;
let dbAlertSent90 = false;
let dbAlertSent95 = false;

async function checkDbSize() {
  if (!config.isDbReady()) return;
  try {
    const result = await getPool().query(`SELECT pg_database_size(current_database()) as bytes`);
    const bytes = parseInt(result.rows[0].bytes);
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const maxMb = 500; // Neon free tier: 500 MB
    const pct = (parseFloat(mb) / maxMb) * 100;

    if (pct >= 95 && !dbAlertSent95) {
      dbAlertSent95 = true;
      const { sendTelegramMessage } = await import('./telegram.js');
      await sendTelegramMessage(`🚨 <b>Database at ${pct.toFixed(0)}% capacity!</b>\n\nUsed: ${mb} MB / ${maxMb} MB\n\n⚠️ Neon free tier almost full! Add second Neon DB soon. Use /status to check.`);
      console.log(`🚨 DB at ${pct.toFixed(0)}% — alert sent`);
    } else if (pct >= 90 && !dbAlertSent90) {
      dbAlertSent90 = true;
      const { sendTelegramMessage } = await import('./telegram.js');
      await sendTelegramMessage(`⚠️ <b>Database at ${pct.toFixed(0)}% capacity</b>\n\nUsed: ${mb} MB / ${maxMb} MB\n\nPrepare to add second Neon DB soon.`);
      console.log(`⚠️ DB at ${pct.toFixed(0)}% — alert sent`);
    } else if (pct >= 80 && !dbAlertSent80) {
      dbAlertSent80 = true;
      const { sendTelegramMessage } = await import('./telegram.js');
      await sendTelegramMessage(`📊 <b>Database at ${pct.toFixed(0)}%</b>\n\nUsed: ${mb} MB / ${maxMb} MB\n\nGetting there. Consider adding second Neon DB.`);
      console.log(`📊 DB at ${pct.toFixed(0)}% — alert sent`);
    }

    // Log every check
    console.log(`📊 DB size: ${mb} MB / ${maxMb} MB (${pct.toFixed(0)}%)`);
  } catch (err) {
    console.error('DB size check error:', err);
  }
}

// Scheduled Message Checker
function startScheduleChecker() {
  setInterval(async () => {
    try {
      const { getDueSchedules, markScheduleSent } = await import('./ai.js') as any;
      const due = getDueSchedules();
      for (const s of due) {
        console.log(`⏰ Sending scheduled message to ${s.targetPhone}: "${s.message.slice(0, 50)}..."`);
        try {
          await sendWhatsAppMessage(s.targetPhone, `${s.message}\n\n— Mahir Abher 🤖`);
          markScheduleSent(s.id);
          const { sendTelegramMessage } = await import('./telegram.js') as any;
          await sendTelegramMessage(`⏰ <b>Scheduled Message Sent</b>\n\n<b>To:</b> ${s.targetPhone}\n<b>Time:</b> ${new Date(s.scheduledTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n<b>Message:</b> "${s.message.slice(0, 100)}"`).catch(() => {});
          console.log(`✅ Scheduled message sent to ${s.targetPhone}`);
        } catch (err: any) {
          console.error(`❌ Failed to send scheduled message to ${s.targetPhone}:`, err);
          markScheduleSent(s.id, err.message);
        }
      }
    } catch (err) {
      // silent — scheduler keeps running
    }
  }, 30_000);
}

// Graceful Shutdown
async function shutdownGracefully(signal: string) {
  console.log(`\n🛑 Received ${signal} — shutting down gracefully...`);

  // Flush message batch buffers (process remaining)
  const flushPromises: Promise<void>[] = [];
  for (const [senderId, buffer] of Object.entries(messageBuffers)) {
    clearTimeout(buffer.timer);
    if (buffer.messages.length > 0) {
      const combined = buffer.messages.map(m => m.text).join('\n');
      console.log(`🔄 Flushing ${buffer.messages.length} queued message(s) from ${senderId}`);
      flushPromises.push(processBatchedMessage(senderId, 'unknown', combined));
    }
  }

  // Wait for all in-flight messages to complete (with timeout)
  if (flushPromises.length > 0) {
    await Promise.race([
      Promise.all(flushPromises),
      new Promise(r => setTimeout(r, 8000)),
    ]);
  }

  // Close DB pool
  await closePool().catch(() => {});

  console.log('👋 Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));

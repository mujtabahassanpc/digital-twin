export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

// Track recent outgoing messages per sender for duplicate detection
const outgoingHistory: Record<string, string[]> = {};
const MAX_OUTGOING_PER_SENDER = 10;

export interface GuardResult {
  passed: boolean;
  reason: string;
  suggestion: string;
}

/**
 * Check if reply is too similar to recent outgoing messages from this sender's conversation
 */
export function checkDuplicate(reply: string, senderId: string): GuardResult {
  const history = outgoingHistory[senderId] || [];
  if (history.length === 0) return { passed: true, reason: '', suggestion: '' };

  const normalized = normalizeText(reply);

  for (const prev of history) {
    const normalizedPrev = normalizeText(prev);

    // Exact match
    if (normalized === normalizedPrev) {
      return {
        passed: false,
        reason: 'exact_duplicate',
        suggestion: 'Reply is identical to a recent message. Generate something different.',
      };
    }

    // High similarity (>70% overlap by word set)
    const similarity = wordSetSimilarity(normalized, normalizedPrev);
    if (similarity > 0.7) {
      return {
        passed: false,
        reason: 'high_similarity',
        suggestion: `Reply is ${Math.round(similarity * 100)}% similar to: "${prev.slice(0, 50)}..."`,
      };
    }
  }

  return { passed: true, reason: '', suggestion: '' };
}

/**
 * Check if reply is way too long compared to user message
 */
export function checkLength(reply: string, userMessage: string): GuardResult {
  const userLen = userMessage.trim().length;
  const replyLen = reply.trim().length;

  // Very short user message (end-of-conversation signals)
  // Only block when reply is excessively long (80+ chars for a 1-2 word msg)
  if (userLen <= 5 && replyLen > 80) {
    return {
      passed: false,
      reason: 'overlong_for_short_message',
      suggestion: `User sent ${userLen} chars ("${userMessage.slice(0, 30)}"), reply should be 1 sentence max.`,
    };
  }

  // User message is short, reply is disproportionately long
  // Use generous multiplier (8x) to avoid blocking natural responses to short questions
  if (userLen < 10 && replyLen > userLen * 8 && replyLen > 40) {
    return {
      passed: false,
      reason: 'disproportionate_length',
      suggestion: `User sent ${userLen} chars, reply is ${replyLen} chars. Keep it proportional.`,
    };
  }

  return { passed: true, reason: '', suggestion: '' };
}

/**
 * Check for obvious fact contradictions
 */
export function checkFacts(reply: string, history: ConversationEntry[]): GuardResult {
  const lower = reply.toLowerCase();

  // Check age contradiction: if reply says user is older than "bhai" should be
  const ageMatch = lower.match(/(\d+)\s*(ka|saal|year|age)/);
  if (ageMatch) {
    const claimedAge = parseInt(ageMatch[1]);
    // If claiming to be older than a typical younger brother would be
    // while conversation says "chhota bhai", flag it
    if (claimedAge >= 25) {
      const isChhotaBhai = history.some(
        (e) => e.role === 'assistant' && e.content.toLowerCase().includes('chhota bhai')
      );
      if (isChhotaBhai) {
        return {
          passed: false,
          reason: 'age_contradiction',
          suggestion: `Claimed age ${claimedAge} but identified as "chhota bhai" (younger brother). Fix.`,
        };
      }
    }
  }

  // Check if claiming to be "bada bhai" (older brother) — identity contradiction
  if (lower.includes('bada bhai') || lower.includes('bari bhai') || lower.includes('older brother')) {
    return {
      passed: false,
      reason: 'identity_contradiction',
      suggestion: 'Mahir is chhota bhai (younger), not bada bhai. Fix identity.',
    };
  }

  return { passed: true, reason: '', suggestion: '' };
}

/**
 * Run all guards on a reply before sending
 */
export function runResponseGuard(
  reply: string,
  userMessage: string,
  senderId: string,
  history: ConversationEntry[]
): GuardResult {
  // Check 1: Duplicate
  const dup = checkDuplicate(reply, senderId);
  if (!dup.passed) return dup;

  // Check 2: Length
  const len = checkLength(reply, userMessage);
  if (!len.passed) return len;

  // Check 3: Facts
  const fact = checkFacts(reply, history);
  if (!fact.passed) return fact;

  return { passed: true, reason: '', suggestion: '' };
}

/**
 * Record an outgoing message in history
 */
export function recordOutgoing(senderId: string, reply: string) {
  if (!outgoingHistory[senderId]) outgoingHistory[senderId] = [];
  outgoingHistory[senderId].push(reply);
  if (outgoingHistory[senderId].length > MAX_OUTGOING_PER_SENDER) {
    outgoingHistory[senderId] = outgoingHistory[senderId].slice(-MAX_OUTGOING_PER_SENDER);
  }
}

// --- Helpers ---

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

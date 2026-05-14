import { sendTelegramMessage } from './telegram.js';

interface AlertEntry {
  type: 'confusion' | 'inform_promise' | 'script_executed' | 'important_conversation' | 'name_learned' | 'name_confirmed';
  senderName: string;
  senderId: string;
  content: string;
  detail: string;
  timestamp: number;
}

const buffer: AlertEntry[] = [];
const MAX_BUFFER = 30;
const AUTO_FLUSH_MS = 10 * 60 * 1000; // 10 min auto-flush
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function resetFlushTimer() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    if (buffer.length > 0) flushAlerts('⏰ Auto-flush (10 min)');
  }, AUTO_FLUSH_MS);
}

export function addAlert(
  type: AlertEntry['type'],
  senderName: string,
  senderId: string,
  content: string,
  detail: string,
) {
  buffer.push({ type, senderName, senderId, content, detail, timestamp: Date.now() });
  if (buffer.length > MAX_BUFFER) {
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }
  resetFlushTimer();
}

export function getPendingCount(): number {
  return buffer.length;
}

export function flushAlerts(reason = '📋 Manual flush'): string {
  if (buffer.length === 0) return '';

  const now = Date.now();
  let informCount = 0;
  let confusionCount = 0;
  let scriptCount = 0;
  const contactSet = new Set<string>();

  let nameLearnCount = 0;
  for (const a of buffer) {
    contactSet.add(a.senderName);
    if (a.type === 'inform_promise') informCount++;
    else if (a.type === 'confusion') confusionCount++;
    else if (a.type === 'script_executed') scriptCount++;
    else if (a.type === 'name_learned') nameLearnCount++;
  }

  const sorted = [...buffer].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Record<string, { name: string; items: string[] }> = {};
  for (const a of sorted) {
    if (!groups[a.senderId]) groups[a.senderId] = { name: a.senderName, items: [] };
    const label = a.type === 'inform_promise' ? '📢 "Bol dunga"' :
      a.type === 'confusion' ? '🤔 Confused' :
      a.type === 'script_executed' ? '📋 Script ran' :
      a.type === 'name_learned' ? '📝 New name learned' :
      a.type === 'name_confirmed' ? '✅ Name confirmed' : '🔔 Important';
    const time = new Date(a.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    groups[a.senderId].items.push(`[${time}] ${label}: ${a.content.slice(0, 100)}`);
  }

  let summary = `📋 <b>Mahir Activity Digest</b>\n${reason}\n\n`;
  summary += `<b>Stats:</b> ${buffer.length} events · ${contactSet.size} contacts · ${informCount} inform · ${confusionCount} confused · ${scriptCount} scripts · ${nameLearnCount} names learned\n\n`;
  for (const [id, g] of Object.entries(groups)) {
    summary += `<b>${g.name}</b> (${g.items.length}x)\n`;
    for (const item of g.items.slice(-5)) summary += `  ${item}\n`;
    if (g.items.length > 5) summary += `  +${g.items.length - 5} more\n`;
    summary += '\n';
  }
  summary += `— Mahir Abher`;

  buffer.length = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

  return summary;
}

export async function flushAndSend(reason?: string): Promise<boolean> {
  const summary = flushAlerts(reason);
  if (!summary) return false;
  return sendTelegramMessage(summary);
}

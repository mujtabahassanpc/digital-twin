import { config } from './config.js';

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v20.0';

interface WhatsAppMessage {
  messaging_product: 'whatsapp';
  recipient_type?: string;
  to: string;
  type: 'text';
  text: {
    body: string;
    preview_url?: boolean;
  };
}

interface WhatsAppResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

export async function sendWhatsAppMessage(
  recipientPhoneNumber: string,
  messageBody: string
): Promise<WhatsAppResponse> {
  if (!config.isWhatsAppReady()) {
    console.warn('WhatsApp not configured — message logged only:', {
      to: recipientPhoneNumber,
      message: messageBody,
    });
    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: recipientPhoneNumber, wa_id: recipientPhoneNumber }],
      messages: [{ id: 'mock-' + Date.now() }],
    };
  }

  const message: WhatsAppMessage = {
    messaging_product: 'whatsapp',
    to: recipientPhoneNumber,
    type: 'text',
    text: {
      body: messageBody,
      preview_url: true,
    },
  };

  const response = await fetch(
    `${WHATSAPP_API_BASE}/${config.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

export function verifyWhatsAppWebhook(
  mode: string,
  token: string,
  challenge: string
): string | null {
  if (
    mode === 'subscribe' &&
    token === config.whatsappVerifyToken
  ) {
    return challenge;
  }
  return null;
}

export function parseIncomingWebhook(body: any) {
  const entry = body.entry?.[0];
  if (!entry) return null;

  const changes = entry.changes?.[0];
  if (!changes) return null;

  const value = changes.value;
  const messages = value.messages;

  if (!messages || messages.length === 0) return null;

  const message = messages[0];
  const senderId = message.from;
  const senderName = value.contacts?.[0]?.profile?.name;
  const text = message.text?.body;

  if (!text || !senderId) return null;

  return {
    senderId,
    senderName,
    text,
    timestamp: message.timestamp || new Date().toISOString(),
    messageId: message.id,
  };
}

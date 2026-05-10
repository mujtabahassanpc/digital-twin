import { Pool } from 'pg';
import { config } from './config.js';

let pool: ReturnType<typeof createPool> | null = null;

function createPool() {
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

export async function initDatabase() {
  if (!config.isDbReady()) {
    console.log('Database not configured — skipping DB init');
    return;
  }

  const client = await getPool().connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        sender_id VARCHAR(50) NOT NULL,
        sender_name VARCHAR(100),
        message_type VARCHAR(10) NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        ai_generated BOOLEAN DEFAULT FALSE,
        whatsapp_message_id VARCHAR(100)
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100),
        relationship VARCHAR(50) DEFAULT 'friend',
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        last_active TIMESTAMPTZ DEFAULT NOW(),
        message_count INT DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_sender
        ON conversations(sender_id, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_contacts_phone
        ON contacts(phone_number);
    `);

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

export async function saveMessage(
  senderId: string,
  senderName: string | undefined,
  messageType: 'incoming' | 'outgoing',
  content: string,
  aiGenerated: boolean = false,
  whatsappMessageId?: string
) {
  if (!config.isDbReady()) {
    console.log(`[DB SKIP] ${messageType}: ${senderId} -> ${content.substring(0, 50)}`);
    return;
  }

  try {
    await getPool().query(
      `INSERT INTO conversations (sender_id, sender_name, message_type, content, ai_generated, whatsapp_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [senderId, senderName, messageType, content, aiGenerated, whatsappMessageId]
    );

    // Update or insert contact
    await getPool().query(
      `INSERT INTO contacts (phone_number, name, last_active, message_count)
       VALUES ($1, $2, NOW(), 1)
       ON CONFLICT (phone_number)
       DO UPDATE SET last_active = NOW(), message_count = contacts.message_count + 1,
                     name = COALESCE(EXCLUDED.name, contacts.name)`,
      [senderId, senderName]
    );
  } catch (error) {
    console.error('Error saving message to DB:', error);
  }
}

export async function getConversationHistory(
  senderId: string,
  limit: number = 10
) {
  if (!config.isDbReady()) {
    return [];
  }

  try {
    const result = await getPool().query(
      `SELECT sender_id, message_type as "messageType", content, timestamp
       FROM conversations
       WHERE sender_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [senderId, limit]
    );

    return result.rows.reverse().map((row) => ({
      role: (row.messageType === 'incoming' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: row.content,
    }));
  } catch (error) {
    console.error('Error fetching conversation history:', error);
    return [];
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export { getPool };

# 🤖 Mahir Abher — WhatsApp AI Digital Twin

Mujtaba ka AI-powered WhatsApp proxy. Jab Mujtaba busy ho, Mahir uska WhatsApp sambhalta hai — real insaan ki tarah.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- A WhatsApp account to scan as Linked Device
- At least one AI API key (see below)
- (Optional) Neon DB for conversation history
- (Optional) Telegram Bot for admin control

### Setup
```bash
git clone https://github.com/mujtabahassanpc/digital-twin.git
cd digital-twin
npm install
cp .env.example .env
# Edit .env with your API keys
npm run build
npm start
```

### Environment Variables
See `.env.example` for all available options:

| Variable | Purpose | Required |
|----------|---------|----------|
| `GEMINI_API_KEYS` | Gemini AI keys (comma-separated) | ✅ (at least one AI provider) |
| `MISTRAL_API_KEYS` | Mistral AI keys | Optional |
| `GROQ_API_KEYS` | Groq AI keys | Optional |
| `OPENROUTER_API_KEYS` | OpenRouter AI keys | Optional |
| `COHERE_API_KEYS` | Cohere AI keys | Optional |
| `DATABASE_URL` | Neon PostgreSQL URL | Optional |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Optional |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | Optional |
| `APP_PORT` | Server port (default: 3000) | Optional |
| `BUSY_MODE` | Auto-reply toggle (default: true) | Optional |

### Free API Keys
| Provider | Free Tier | Get Key |
|----------|-----------|---------|
| Gemini | 20 req/day per key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Mistral | 10M tokens/month | [console.mistral.ai](https://console.mistral.ai/api-keys/) |
| Groq | High rate limits | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenRouter | Free models available | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Cohere | Free tier available | [dashboard.cohere.com](https://dashboard.cohere.com/api-keys) |

**Tip:** Add multiple keys comma-separated: `GEMINI_API_KEYS=key1,key2,key3`

## 📱 How It Works

```
WhatsApp Message → Baileys (Linked Device) → AI Provider → Reply
                                                      ↓ (429?)
                                              Next Provider → Reply
                                                      ↓ (all exhausted?)
                                              Const Message (once only)
```

### AI Provider Priority
1. Gemini (Google)
2. Mistral
3. Groq
4. OpenRouter
5. Cohere

If one provider fails (429), it automatically tries the next. Each provider has a 5-minute cooldown after rate limiting.

## 🎯 Architecture

### Core Files
```
src/
├── ai.ts           # AI reply generation, multi-provider fallback
├── config.ts       # Environment variables, key parsing
├── db.ts           # PostgreSQL conversation history
├── index.ts        # Express server, event routing
├── telegram.ts     # Telegram bot commands
├── whatsapp.ts     # Baileys WhatsApp connection
└── style.ts        # WhatsApp export analysis (CLI)

data/
├── personality.md  # Mahir's identity, style, rules (static)
├── context.md      # Current situation, Mujtaba's status (editable)
├── contacts.json   # Per-contact memory (auto-learned)
└── language_examples.json  # Language training examples (Telegram-taught)
```

### Two-Brain System
Mahir has **two types of knowledge**:

1. **Personality (`data/personality.md`)** — Who Mahir is, how he speaks, what not to say. This is static and rarely changes.

2. **Context (`data/context.md`)** — Current situation. Mujtaba is busy/school/sleeping. This changes frequently and is editable via Telegram.

### Language Learning
Mahir learns from examples you teach via Telegram. Each example has a message and a reason:

```
/teach "acha thik hai" | jab short acknowledgment dena ho
```

Examples are injected into every AI prompt so Mahir gradually learns your style.

## 📲 Telegram Commands

### Teach Language
```
/teach "message" | reason           → Add one example
/teachbulk "m1" > r1 :: "m2" > r2  → Add multiple examples
/lang [n]                           → View last n examples
/forgetlang <index>                 → Remove example by index
/clearlang                          → Clear all examples
```

### Set Context
```
/mujtaba busy      → "Mujtaba kaam me busy hai"
/mujtaba school    → "Mujtaba school gaya hai"
/mujtaba sleeping  → "Mujtaba so raha hai"
/mujtaba office    → "Mujtaba office me hai"
/mujtaba eating    → "Mujtaba khaana kha raha hai"
/mujtaba driving   → "Mujtaba drive kar raha hai"
/mujtaba meeting   → "Mujtaba meeting me hai"
/mujtaba travelling → "Mujtaba travel kar raha hai"
/mujtaba available → "Mujtaba available hai"
/context <text>    → Custom instruction add karo
```

### Manage
```
/status            → Check all services
/busy on           → Enable auto-reply
/busy off          → Disable auto-reply
/reply <jid> <msg> → Send manual reply
/contacts          → View saved contact memories
/forget <jid>      → Clear contact memory
/digest            → Send daily summary
/help              → Show commands
```

## 🧠 How Mahir Thinks

### No Canned Replies
Mahir has **zero fixed responses**. Every reply is generated by AI based on:
1. **Personality** — How Mahir speaks
2. **Context** — What's happening right now
3. **Contact Memory** — What Mahir knows about this person
4. **Language Examples** — How you've taught Mahir to speak
5. **Conversation History** — What was just said

### Conversation Flow Detection
Mahir detects conversation ending naturally:
- If user's messages get progressively shorter → ending mode
- If user gives one-word answer after long conversation → ending mode
- In ending mode: no new questions, short acknowledgment

### Language Style
- **Primary:** Hinglish (Hindi + English mix)
- **Natural Sylheti:** Words that fit naturally, not forced
- **No Bengali script:** Roman letters only
- **Short messages:** 1-3 sentences, like real WhatsApp

## 🌐 Hosting

### Render (Recommended)
```bash
# Push to GitHub
git push origin main

# Create new Web Service on Render
# Connect your repo
# Set environment variables
# Deploy!
```

### UptimeRobot
Set up a ping to `https://your-app.onrender.com/health` every 5 minutes to prevent sleep.

### Local Development
```bash
npm run dev    # Watch mode (tsx)
npm run build  # TypeScript compile
npm start      # Production mode
```

## 📊 Dashboard
Visit `http://localhost:3000` for:
- QR code status
- Busy mode toggle
- Service health check

## 🔧 Customization

### Change Mahir's Personality
Edit `data/personality.md`:
- Add/remove speaking style rules
- Change language preferences
- Modify what NOT to say

### Add Language Examples
Use Telegram `/teach` command or edit `data/language_examples.json`:
```json
{
  "examples": [
    {
      "message": "acha thik hai",
      "reason": "jab short acknowledgment dena ho",
      "added_at": "2026-05-05T00:00:00Z"
    }
  ]
}
```

### Add New AI Providers
1. Add config in `config.ts`
2. Add provider function in `ai.ts`
3. Add to `providers` array

## ⚠️ Known Limitations
- Free tier APIs have daily limits — use multiple keys
- Baileys auth is file-based — QR re-scan needed after server restart
- No end-to-end encryption for AI processing
- Conversation context limited to last 8 messages

## 📜 License
MIT

## 👤 Author
Mujtaba Hassan — Built for personal use, open sourced for learning.

# Telegram Chat Summarizer Bot (TypeScript)

[На русском](docs/README_ru.md)

An asynchronous Telegram bot built with Node.js, TypeScript, the `telegraf` framework, and the official `@google/genai` SDK for automatic message logging and summarization in group chats using the **Gemini 3.1 Flash Lite** model.

**WARNING!!! 100% AI slop project** written by Gemini 3.5 Flash from scratch. Use with caution.

## Features
*   **Multi-language Support**: Configurable bot interface and summary language (English and Russian are fully supported; see `.env` settings). Supports natural time parsing in both languages.
*   **Real-time logging**: The bot tracks and logs text messages and media captions into a local SQLite database.
*   **Edit synchronization**: Automatically updates message content in the database if a user edits their message in Telegram.
*   **Memory safe**: A background cron job cleans up messages older than 30 days once a day.
*   **Secure database permissions**: Creates the SQLite database directory with mode `0700` when missing and sets the database file itself to mode `0600` on Linux/macOS.
*   **Markup protection**: Sanitizes Gemini output for Telegram HTML, converts basic Markdown formatting, and falls back to plain text if Telegram still rejects the markup.
*   **Topic (Thread) compatibility**: Correctly handles and stores `thread_id` for forum-like supergroups.
*   **Private chat support**: In private chats, trigger keywords start summarization; other messages receive a short welcome/help response.

---

## 🛠️ Bot Preparation and Configuration

### 1. Creating a Telegram Bot
1. Chat with [@BotFather](https://t.me/BotFather) on Telegram.
2. Create a new bot using the `/newbot` command and copy the provided **Telegram Bot Token**.

### 2. Disabling Privacy Mode (Important!)
By default, Telegram bots cannot read group messages unless they are directly mentioned. To allow the bot to collect history for summarization:
1. In the chat with [@BotFather](https://t.me/BotFather), send the `/mybots` command and select your bot.
2. Go to **Bot Settings** -> **Group Privacy**.
3. Click **Turn off** (you should see a message saying `Privacy mode is disabled`).
4. If the bot is already in your group, **remove it and add it back** for the settings to apply.
5. *(Recommended)*: Make the bot an administrator in the group and grant it permission to read messages.

### 3. Getting Gemini API Key
Obtain a free or paid API key from [Google AI Studio](https://aistudio.google.com/).

### 4. Advanced Configuration (Optional)
You can configure rate limits, privacy modes, and whitelist specific chat IDs in your `.env` file to protect your Gemini API quota:
*   **Rate Limiting**:
    *   `RATE_LIMIT_MAX_REQUESTS`: Set the maximum number of summarization requests allowed per chat in the window. Disabled if unset or set to `0`; invalid or negative values fail closed and block requests temporarily.
    *   `RATE_LIMIT_WINDOW_SEC`: The duration of the window in seconds (defaults to `3600` - 1 hour; invalid values fall back to `3600`).
*   **Chat ID Authorization**:
    *   `ALLOWED_CHATS`: A comma-separated list of numeric chat IDs allowed to use the bot (e.g., `-100123456789,-100987654321,12345678`).
    *   `ALLOW_ALL_CHATS`: Set to `true` to explicitly disable authorization checks and allow all chats. By default, authorization operates in a **fail-closed** mode: if `ALLOW_ALL_CHATS` is not `true` and `ALLOWED_CHATS` is empty or unset, all chats will be unauthorized by default.
*   **PII Minimization**:
    *   `REDACT_USER_IDENTITIES`: Set to `true` to enable user identity redaction in transcripts. In this mode, real names and usernames in message headers and bodies are replaced with stable pseudonyms (e.g., `User 1`, `User 2`), and any other username mentions are replaced with `@user_redacted`.
*   **Logging**:
    *   `DEBUG=true`, `DEBUG=1`, or `LOG_LEVEL=debug`: Enables debug logs. Non-debug logs are always printed.
*   **Database path**:
    *   `DB_PATH`: Defaults to `data/bot_messages.db`. Values containing `..` are rejected on startup.
*   **Gemini API key**:
    *   `GEMINI_API_KEY`: Primary API key variable. `GOOGLE_API_KEY` is also accepted as a fallback.

---

## 🚀 Installation and Run

For a detailed deployment guide on Linux servers (Debian/Ubuntu and Alma/Rocky Linux), please refer to the [Deployment Guide](docs/deployment.md).

### Prerequisites
*   Node.js v20.17.0 or higher (tested on Node.js v22)

### Installation Steps

1.  Clone the repository and navigate to its folder.
2.  Install the required dependencies using npm:
    ```bash
    npm install
    ```
3.  Create a `.env` configuration file based on the example:
    ```bash
    cp .env.example .env
    ```
4.  Fill in `.env` with your tokens:
    ```env
    TELEGRAM_BOT_TOKEN=your_telegram_bot_token
    GEMINI_API_KEY=your_gemini_api_key
    DB_PATH=data/bot_messages.db
    DEFAULT_TIMEZONE=Europe/Moscow
    BOT_LANGUAGE=en
    ALLOW_ALL_CHATS=true
    REDACT_USER_IDENTITIES=false
    ```

### Testing Functionality
You can run the full built-in test suite before starting the bot:
```bash
npm test
```
It runs database, main handler, timeframe parser, utility, and summarizer tests. You can also run individual suites:
```bash
npm run test:db
npm run test:main
npm run test:parser
npm run test:utils
npm run test:summarizer
```

### Building the Project (TypeScript compilation)
To compile the TypeScript project into JavaScript, run:
```bash
npm run build
```
Compiled files will be saved in the `dist/` directory.

### Running the Bot
Start the bot directly using `tsx` (TypeScript execute):
```bash
npm start
```
Or run the compiled version:
```bash
node dist/main.js
```

---

## 💡 Bot Usage

1.  Add the bot to your group chat.
2.  Chat as usual — the bot will save messages in the background.
3.  To get a summary, mention the bot and specify the desired time interval in natural language:
    *   `@bot_username summarize the last hour`
    *   `@bot_username get summary for 3 hours`
    *   `@bot_username what was discussed today?`
    *   `@bot_username briefly for yesterday`
    *   `@bot_username summarization for the last 2 days`
    *   `@bot_username summarize last 30 minutes` (Russian queries like `суммаризуй за последний час` are also supported)

*Note: If the time period cannot be parsed, the bot defaults to summarizing the last 24 hours.*

In private chats, send a trigger phrase such as `summarize the last hour` or `суммаризуй за час` to summarize messages visible in that private chat.

## License

MIT. [LICENSE](LICENSE).

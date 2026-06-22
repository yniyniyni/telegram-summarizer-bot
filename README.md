# Telegram Chat Summarizer Bot (TypeScript)

[На русском](docs/README_ru.md)

An asynchronous Telegram bot built with Node.js, TypeScript, and the `telegraf` framework for automatic message logging and summarization in group chats. It works out of the box with Google's **Gemini 3.1 Flash Lite** (via the official `@google/genai` SDK) and can be pointed at any **OpenAI-compatible API** (OpenAI, OpenRouter, Together, local vLLM/Ollama servers, …).

**WARNING!!! 100% AI slop project** written by Gemini 3.5 Flash from scratch. Use with caution.

## Features
*   **Pluggable LLM provider**: Uses Google Gemini by default, or any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, local servers, etc.) via `LLM_PROVIDER=openai`. The model is configurable on both providers.
*   **Multi-language Support**: Configurable bot interface and summary language (English and Russian are fully supported; see `.env` settings). Supports natural time parsing in both languages.
*   **Real-time logging**: The bot tracks and logs text messages and media captions into a local SQLite database.
*   **Edit synchronization**: Automatically updates message content in the database if a user edits their message in Telegram.
*   **Memory safe**: A background cron job cleans up messages older than 30 days once a day.
*   **Secure database permissions**: Creates the SQLite database directory with mode `0700` when missing and sets the database file itself to mode `0600` on Linux/macOS.
*   **Markup protection**: Sanitizes the LLM output for Telegram HTML, converts basic Markdown formatting, and falls back to plain text if Telegram still rejects the markup.
*   **Topic (Thread) compatibility**: Correctly handles and stores `thread_id` for forum-like supergroups.
*   **Private chat support**: In private chats, trigger keywords start summarization; other messages receive a short welcome/help response.
*   **Multimodal media understanding** *(opt-in, Gemini only)*: When enabled, the bot logs and sends images, voice messages, and video notes to the model so summaries can reflect their content, not just text. Off by default; enable per type via `MULTIMODAL_*` flags.
*   **Deep-dive Q&A** *(opt-in)*: When enabled, mentioning the bot with an actual question (e.g. *"@bot why did we postpone the release?"*) returns a focused answer drawn from chat history instead of a standard structured summary. Off by default; enable with `DEEP_DIVE_ENABLED=true`.

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

### 3. Getting an LLM API Key
For the default Gemini provider, obtain a free or paid API key from [Google AI Studio](https://aistudio.google.com/). Alternatively, set `LLM_PROVIDER=openai` and provide an `OPENAI_API_KEY` to use OpenAI or any OpenAI-compatible endpoint (see the LLM Provider settings below).

### 4. Advanced Configuration (Optional)
You can choose the LLM provider, configure rate limits, privacy modes, and whitelist specific chat IDs in your `.env` file to protect your API quota:
*   **LLM Provider**:
    *   `LLM_PROVIDER`: `gemini` (default) or `openai`. When set to `openai`, the bot calls an OpenAI-compatible Chat Completions endpoint instead of the Gemini SDK.
    *   `GEMINI_MODEL`: Override the Gemini model (defaults to `gemini-3.1-flash-lite`).
    *   `OPENAI_API_KEY`: API key for the OpenAI-compatible provider (required when `LLM_PROVIDER=openai`).
    *   `OPENAI_MODEL`: Model name for the OpenAI-compatible provider (defaults to `gpt-4o-mini`).
    *   `OPENAI_BASE_URL`: Custom endpoint for OpenAI-compatible providers (defaults to `https://api.openai.com/v1`, no trailing slash needed). Works with OpenRouter, Together, local vLLM/Ollama servers, etc.
*   **Rate Limiting**:
    *   `RATE_LIMIT_MAX_REQUESTS`: Set the maximum number of summarization requests allowed per chat in the window. Disabled if unset or set to `0`; invalid or negative values fail closed and block requests temporarily.
    *   `RATE_LIMIT_WINDOW_SEC`: The duration of the window in seconds (defaults to `3600` - 1 hour; invalid values fall back to `3600`).
*   **Chat ID Authorization**:
    *   `ALLOWED_CHATS`: A comma-separated list of numeric chat IDs allowed to use the bot (e.g., `-100123456789,-100987654321,12345678`).
    *   `ALLOWED_USERS`: A comma-separated list of numeric Telegram user IDs allowed to interact with the bot in private messages (DMs). If configured, it restricts private chats even if `ALLOW_ALL_CHATS` is set to `true`.
    *   `ALLOW_ALL_CHATS`: Set to `true` to explicitly disable authorization checks and allow all chats. By default, authorization operates in a **fail-closed** mode: if `ALLOW_ALL_CHATS` is not `true` and both `ALLOWED_CHATS` and `ALLOWED_USERS` are empty or unset, all chats will be unauthorized by default.
*   **PII Minimization**:
    *   `REDACT_USER_IDENTITIES`: Set to `true` to enable user identity redaction in transcripts. In this mode, real names and usernames in message headers and bodies are replaced with stable pseudonyms (e.g., `User 1`, `User 2`), and any other username mentions are replaced with `@user_redacted`.
*   **Message Links**:
    *   `INCLUDE_MESSAGE_LINKS`: Set to `true` to append one source-message link per topic in the "Main Topics of Discussion" section of each summary. Works only in private supergroups/channels (Telegram `t.me/c/…` links); basic groups and DMs are skipped automatically. Default: `false`. Independent of `REDACT_USER_IDENTITIES`.
*   **Multimodal Support** (Gemini only — has no effect with `LLM_PROVIDER=openai`, which logs a startup warning):
    *   `MULTIMODAL_ENABLED`: Master switch (default: `false`). Must be `true` for any media logging/processing; the per-type flags below are ignored while it is off.
    *   `MULTIMODAL_IMAGES_ENABLED` / `MULTIMODAL_VOICE_ENABLED` / `MULTIMODAL_VIDEO_NOTE_ENABLED`: Per-type toggles (default: `false` each) for images, voice messages, and video notes.
    *   `MULTIMODAL_INCLUDE_BY_DEFAULT`: When `true`, media is always included in summaries. When `false` (default), media is included only if the request mentions it (e.g. *with images*, *с медиа*, *войс*, *кружки*).
    *   `MEDIA_STORAGE_MAX_MB`: Disk budget for stored media files (default: `500`). When exceeded, the oldest files are deleted first.
    *   `MULTIMODAL_FILES_API`: How media is sent to Gemini — `off` (default; inline base64 with conservative per-type caps of 1 MB image / 3 MB voice / 5 MB video note), `ondemand` (upload to the Gemini Files API at summarization time, removing the inline caps), or `cache` (like `ondemand` but reuse the uploaded URI across summaries within Google's ~48h retention window).
    *   `MEDIA_MAX_DOWNLOAD_MB`: When the Files API is enabled, replaces the per-type inline caps with a single cap (default: `20`, the Telegram Bot API ceiling for `getFile`).
*   **Deep-dive Q&A**:
    *   `DEEP_DIVE_ENABLED`: Set to `true` to enable deep-dive mode (default: `false`). When on, a mention/DM that contains an interrogative marker (e.g. *what, why, how, tell me, расскажи, почему*) is answered as a specific question instead of producing a standard summary; a markerless mention still triggers a normal summary. With an explicit timeframe the answer uses that window's messages; with no timeframe it reuses the most recent cached summary for that chat (kept up to 3 days), falling back to the last 24 hours. Deep-dive analyzes **text only** — even with multimodality enabled, media is not sent to the model in this mode.
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
    *   `@bot_username summary for the last month`
    *   `@bot_username summarize last 30 minutes` (Russian queries like `суммаризуй за последний час` are also supported)

*Supported intervals: minutes, hours, days, week, month, plus `today` and `yesterday`.*

*Note: If the time period cannot be parsed, the bot defaults to summarizing the last 24 hours.*

In private chats, send a trigger phrase such as `summarize the last hour` or `суммаризуй за час` to summarize messages visible in that private chat.

### Deep-dive Q&A (optional)

With `DEEP_DIVE_ENABLED=true`, instead of a full summary you can ask the bot a specific question and get a focused answer from the chat history:
*   `@bot_username what did we decide about the migration?`
*   `@bot_username tell me more about yesterday's incident`
*   `@bot_username why was the deploy postponed for the last 3 hours?` (a timeframe scopes the answer to that window)

A mention without a question word still produces a normal summary, so existing usage is unchanged.

## License

MIT. [LICENSE](LICENSE).

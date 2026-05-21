# Telegram Gemini Chat Summarizer Bot (TypeScript)

[На русском](README_ru.md)

An asynchronous Telegram bot built with Node.js, TypeScript, the `telegraf` framework, and the official `@google/genai` SDK for automatic message logging and summarization in group chats using the **Gemini 3.1 Flash Lite** model.

## Features
*   **Real-time logging**: The bot tracks and logs text messages and media captions into a local SQLite database.
*   **Edit synchronization**: Automatically updates message content in the database if a user edits their message in Telegram.
*   **Natural time parsing (RU/EN)**: Supports flexible time queries (e.g. `last hour`, `for 3 hours`, `today`, `last 5 days`, `yesterday`, etc.).
*   **Memory safe**: A background cron job cleans up messages older than 30 days once a day.
*   **Markup protection**: If Gemini returns invalid Markdown, the bot automatically falls back to plain text mode to avoid Telegram API formatting errors.
*   **Topic (Thread) compatibility**: Correctly handles and stores `thread_id` for forum-like supergroups.

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

---

## 🚀 Installation and Run

### Prerequisites
*   Node.js v18.0.0 or higher (tested on Node.js v22)

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
    ```

### Testing Functionality
You can run the built-in database and time parser tests before starting the bot:
```bash
npm test
```
Or separately:
```bash
npm run test:db
```
```bash
npm run test:parser
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

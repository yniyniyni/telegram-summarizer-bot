import 'dotenv/config';
import { fileURLToPath } from 'url';
import path from 'path';
import { Telegraf, Context } from 'telegraf';
import * as db from './db.js';
import * as summarizer from './summarizer.js';
import { getLocale } from './locales.js';

// Setup basic logger
function log(level: string, message: string, ...args: any[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${message}`, ...args);
}

/**
 * Calculates the local midnight epoch timestamp in a specific timezone.
 * @param timezoneName 
 * @returns 
 */
export function getMidnightTimestamp(timezoneName: string): number {
  const now = new Date();
  
  // Format current date in target timezone as YYYY-MM-DD
  const tzString = now.toLocaleString('sv-SE', { timeZone: timezoneName });
  const [datePart] = tzString.split(' '); // e.g. "2026-05-21"

  // Get current times in both target timezone and UTC to calculate offset
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezoneName }));
  const utcTime = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = localTime.getTime() - utcTime.getTime();

  // Create midnight UTC object and subtract the timezone offset to get local midnight in UTC epoch
  const midnightUtc = new Date(`${datePart}T00:00:00Z`);
  return Math.floor((midnightUtc.getTime() - offsetMs) / 1000);
}

/**
 * Parses natural language requests for a timeframe in Russian/English.
 * @param text 
 * @param timezoneName 
 * @returns [sinceTimestampEpoch, localized timeframe description]
 */
export function parseTimeframe(text: string, timezoneName = 'Europe/Moscow'): [number, string] {
  const locale = getLocale();
  text = text.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const defaultSeconds = 24 * 3600;
  const defaultDesc = locale.timeframeDefault;

  // 1. Match numeric hours: "N часов", "N часа", "за N часов", "3ч", "3h", etc.
  const hoursMatch = text.match(/(\d+)\s*(?:час|часа|часов|ч|hour|hours|h)/);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1], 10);
    const desc = locale.timeframeHour(hours);
    return [now - (hours * 3600), desc];
  }

  // Single hour check
  if (text.includes("час") || text.includes("hour")) {
    return [now - 3600, locale.timeframeHourSingle];
  }

  // 2. Match numeric minutes: "30 минут", "15 мин"
  const minsMatch = text.match(/(\d+)\s*(?:минут|минуты|минуту|мин|m|min|minute|minutes)/);
  if (minsMatch) {
    const mins = parseInt(minsMatch[1], 10);
    const desc = locale.timeframeMin(mins);
    return [now - (mins * 60), desc];
  }

  if (text.includes("минут") || text.includes("min")) {
    return [now - 600, locale.timeframeMinSingle];
  }

  // 3. Today / "сегодня" (from 00:00 of the current day in target timezone)
  if (text.includes("сегодня") || text.includes("today")) {
    let midnightTs = getMidnightTimestamp(timezoneName);
    if (midnightTs >= now) {
      midnightTs = now - defaultSeconds;
    }
    return [midnightTs, locale.timeframeToday];
  }

  // 4. Yesterday / "вчера" (from 00:00 of yesterday in target timezone)
  if (text.includes("вчера") || text.includes("yesterday")) {
    const yesterdayTs = getMidnightTimestamp(timezoneName) - (24 * 3600);
    return [yesterdayTs, locale.timeframeYesterday];
  }

  // 5. Match numeric days: "3 дня", "5 дней"
  const daysMatch = text.match(/(\d+)\s*(?:день|дня|дней|дн|day|days\b|d\b)/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const desc = locale.timeframeDay(days);
    return [now - (days * 24 * 3600), desc];
  }

  if (text.includes("сутки") || text.includes("суток")) {
    return [now - (24 * 3600), locale.timeframe24h];
  }
  if (text.includes("день") || text.includes("day")) {
    return [now - (24 * 3600), locale.timeframeDaySingle];
  }

  // 6. Week / "неделя"
  if (text.includes("недел") || text.includes("week")) {
    return [now - (7 * 24 * 3600), locale.timeframeWeek];
  }

  return [now - defaultSeconds, defaultDesc];
}

/**
 * Periodically deletes database records older than 30 days.
 */
async function databaseCleanupLoop(): Promise<void> {
  try {
    const cleaned = await db.cleanupOldMessages(30);
    log("INFO", `Database cleanup: removed ${cleaned} messages older than 30 days.`);
  } catch (err) {
    log("ERROR", "Error in database cleanup loop:", err);
  }
}

/**
 * Saves incoming messages or updates edited messages in the database.
 */
async function logMessage(ctx: Context): Promise<void> {
  const message = ctx.message || ctx.editedMessage;
  if (!message) return;

  const text = ('text' in message ? message.text : '') || ('caption' in message ? message.caption : '');
  if (!text) return;

  // Don't log bot command updates
  if (text.startsWith('/')) return;

  const botUsername = ctx.botInfo?.username;
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) {
    return;
  }

  const chat_id = message.chat.id;
  const message_id = message.message_id;
  const timestamp = message.date; // Unix timestamp in seconds

  let user_id = 0;
  let first_name = "Anonymous";
  let last_name: string | null = null;
  let username: string | null = null;

  if (message.from) {
    user_id = message.from.id;
    first_name = message.from.first_name || "Anonymous";
    last_name = message.from.last_name || null;
    username = message.from.username || null;
  } else if ('sender_chat' in message && message.sender_chat) {
    user_id = message.sender_chat.id;
    first_name = ('title' in message.sender_chat ? message.sender_chat.title : "Channel") || "Channel";
    last_name = null;
    username = ('username' in message.sender_chat ? message.sender_chat.username : null) || null;
  }

  const thread_id = ('message_thread_id' in message ? message.message_thread_id : null) || null;

  await db.saveMessage({
    chat_id,
    message_id,
    user_id,
    username,
    first_name,
    last_name,
    text,
    timestamp,
    thread_id
  });
}

/**
 * Orchestrates fetching logs, invoking Gemini, and displaying the summary.
 */
async function runSummarization(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.chat) return;
  
  const chatId = ctx.chat.id;
  const threadId = ('message_thread_id' in message ? message.message_thread_id : undefined) || null;
  const text = ('text' in message ? message.text : '') || "";
  const tz = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';

  const [sinceTs, timeframeDesc] = parseTimeframe(text, tz);
  log("INFO", `Initiating summarization request in chat_id=${chatId} (thread_id=${threadId}). Query text="${text}". Timeframe parsed: sinceTs=${sinceTs} (${timeframeDesc})`);

  const locale = getLocale();
  const replyOptions: any = {};
  if (threadId) {
    replyOptions.message_thread_id = threadId;
  }

  const statusMessage = await ctx.reply(
    locale.gatheringMessages,
    { ...replyOptions, parse_mode: 'HTML' }
  );

  try {
    const chatMessages = await db.getMessages(chatId, sinceTs, threadId);
    const botUsername = ctx.botInfo?.username?.toLowerCase();

    // Skip bot calls/commands in logs
    const filteredMessages = chatMessages.filter(msg => {
      const msgText = msg.text || '';
      if (msgText.startsWith('/')) return false;
      if (botUsername && msgText.toLowerCase().includes(`@${botUsername}`)) return false;
      return true;
    });

    log("INFO", `Retrieved ${chatMessages.length} total messages from DB. Filtered down to ${filteredMessages.length} messages for analysis.`);
    if (filteredMessages.length > 0) {
      log("DEBUG", `Messages being analyzed:\n` + filteredMessages.map(msg => `  [${new Date(msg.timestamp * 1000).toISOString()}] ${msg.first_name}: ${msg.text}`).join('\n'));
    }

    if (filteredMessages.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        locale.noTextMessagesForPeriod(timeframeDesc),
        { parse_mode: 'HTML' }
      );
      return;
    }

    const summaryText = await summarizer.summarizeMessages(filteredMessages, timeframeDesc, tz);

    const maxLength = 4000;
    if (summaryText.length > maxLength) {
      const chunks = [];
      for (let i = 0; i < summaryText.length; i += maxLength) {
        chunks.push(summaryText.substring(i, i + maxLength));
      }

      // Delete status message
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
      } catch (err) {
        log("WARN", "Could not delete status message:", err);
      }

      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { ...replyOptions, parse_mode: 'HTML' });
        } catch (err) {
          log("WARN", "HTML error, falling back to plain text:", err);
          await ctx.reply(chunk, replyOptions);
        }
      }
    } else {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          summaryText,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        log("WARN", "HTML error, falling back to plain text:", err);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          summaryText
        );
      }
    }
  } catch (err: any) {
    log("ERROR", "Error during summarization execution:", err);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        locale.failedToGenerateWithError(err.message || err),
        { parse_mode: 'HTML' }
      );
    } catch (editErr) {
      log("ERROR", "Could not update status message with error detail:", editErr);
    }
  }
}

/**
 * Filter mentions/private chat inquiries.
 */
async function handleBotMentionOrPrivate(ctx: Context): Promise<void> {
  const locale = getLocale();
  const message = ctx.message;
  if (!message || !('text' in message) || !message.text || !ctx.chat) return;

  const text = message.text;
  const botUsername = ctx.botInfo?.username;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);

  if (isPrivate || isMentioned) {
    const triggerKeywords = ["суммаризуй", "суммаризация", "кратко", "итог", "summary", "summarize", "отчет", "конспект", "что обсуждали", "пересказ"];
    const textLower = text.toLowerCase();
    const shouldSummarize = triggerKeywords.some(kw => textLower.includes(kw)) || isPrivate;

    if (!shouldSummarize) {
      if (isPrivate) {
        await ctx.reply(
          locale.welcomeMessage(botUsername || 'bot_username'),
          { parse_mode: 'HTML' }
        );
      }
      return;
    }

    await runSummarization(ctx);
  }
}

/**
 * Initialize and start the Telegram Bot.
 */
async function startBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("FATAL", "TELEGRAM_BOT_TOKEN environment variable is missing. Exiting.");
    process.exit(1);
  }

  log("INFO", "Initializing SQLite database...");
  const dbPath = process.env.DB_PATH || 'data/bot_messages.db';
  db.setDbPath(dbPath);
  await db.initDb();

  const bot = new Telegraf(token);

  // Log incoming messages and edits (excluding commands)
  bot.on(['message', 'edited_message'], async (ctx, next) => {
    try {
      const message = ctx.message || ctx.editedMessage;
      if (message) {
        const text = ('text' in message ? message.text : '') || ('caption' in message ? message.caption : '');
        const chat_id = message.chat.id;
        const fromName = message.from ? `${message.from.first_name} ${message.from.last_name || ''}`.trim() : 'System/Channel';
        const type = ctx.message ? 'message' : 'edited_message';
        log("DEBUG", `Received ${type} in chat ${chat_id} from ${fromName}: "${text}"`);
      }
      await logMessage(ctx);
    } catch (err) {
      log("ERROR", "Error logging message:", err);
    }
    return next();
  });

  // Main listener for text requests (mentions & private chats)
  bot.on('text', async (ctx) => {
    try {
      await handleBotMentionOrPrivate(ctx);
    } catch (err) {
      log("ERROR", "Error handling potential summarization trigger:", err);
    }
  });

  // Fetch bot info once to register and log authorization
  const botInfo = await bot.telegram.getMe();
  log("INFO", `Bot successfully authorized as @${botInfo.username}`);

  // Schedule database cleanup task to run on boot and then once a day
  await databaseCleanupLoop();
  setInterval(databaseCleanupLoop, 24 * 3600 * 1000);

  // Poll for message and edit updates
  log("INFO", "Starting bot polling loop...");
  await bot.launch({
    allowedUpdates: ['message', 'edited_message']
  });

  // Configure graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// Check if this module is run as the main script entry point
const nodePath = process.argv[1];
const currentPath = fileURLToPath(import.meta.url);

if (nodePath && path.resolve(nodePath) === path.resolve(currentPath)) {
  startBot().catch(err => {
    log("FATAL", "Failed to run bot app launcher:", err);
    process.exit(1);
  });
}

import 'dotenv/config';
import { fileURLToPath } from 'url';
import path from 'path';
import { Telegraf, Context } from 'telegraf';
import * as db from './db.js';
import * as summarizer from './summarizer.js';
import { getLocale } from './locales.js';
import { escapeHTML, sanitizeHTML, isChatAuthorized, isRateLimited, splitHTMLText, log, safeErrorForLog } from './utils.js';

export interface TimeframeResult {
  sinceTs: number;
  untilTs?: number;
  desc: string;
}

export function validateTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Calculates the local midnight epoch timestamp for a given date in a specific timezone using a convergent iteration.
 * @param dateStr 
 * @param timezoneName 
 * @returns 
 */
export function getMidnightTimestampForDate(dateStr: string, timezoneName: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  const targetLocalMs = Date.UTC(year, month - 1, day, 0, 0, 0);

  let currentEstimateMs = targetLocalMs;
  for (let iter = 0; iter < 10; iter++) {
    const date = new Date(currentEstimateMs);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneName,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(date);

    const map: Record<string, string> = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }

    const localMs = Date.UTC(
      parseInt(map.year, 10),
      parseInt(map.month, 10) - 1,
      parseInt(map.day, 10),
      parseInt(map.hour, 10),
      parseInt(map.minute, 10),
      parseInt(map.second, 10)
    );

    const offsetMs = localMs - currentEstimateMs;
    const nextEstimateMs = targetLocalMs - offsetMs;

    if (nextEstimateMs === currentEstimateMs) {
      return Math.floor(currentEstimateMs / 1000);
    }
    currentEstimateMs = nextEstimateMs;
  }
  return Math.floor(currentEstimateMs / 1000);
}

/**
 * Calculates the local midnight epoch timestamp in a specific timezone.
 * @param timezoneName 
 * @returns 
 */
export function getMidnightTimestamp(timezoneName: string, nowOverride?: number): number {
  const now = nowOverride !== undefined ? new Date(nowOverride * 1000) : new Date();
  
  // Format current date in target timezone as YYYY-MM-DD
  const tzString = now.toLocaleString('sv-SE', { timeZone: timezoneName });
  const [datePart] = tzString.split(' '); // e.g. "2026-05-21"

  return getMidnightTimestampForDate(datePart, timezoneName);
}

/**
 * Parses natural language requests for a timeframe in Russian/English.
 * @param text 
 * @param timezoneName 
 * @returns TimeframeResult
 */
export function parseTimeframe(text: string, timezoneName = 'Europe/Moscow', nowOverride?: number): TimeframeResult {
  const locale = getLocale();
  text = text.toLowerCase();
  const now = nowOverride !== undefined ? nowOverride : Math.floor(Date.now() / 1000);
  const defaultSeconds = 24 * 3600;
  const defaultDesc = locale.timeframeDefault;

  // 1. Match numeric hours: "N часов", "N часа", "за N часов", "3ч", "3h", etc.
  const ruHoursMatch = text.match(/(?<=^|[^а-яё])(\d+)\s*(час|часа|часов|ч)(?=$|[^а-яё])/i);
  const enHoursMatch = text.match(/\b(\d+)\s*(hour|hours|h)\b/i);
  if (ruHoursMatch || enHoursMatch) {
    const match = ruHoursMatch || enHoursMatch;
    if (match) {
      const hours = parseInt(match[1], 10);
      const desc = locale.timeframeHour(hours);
      return { sinceTs: now - (hours * 3600), desc };
    }
  }

  // Single hour check
  const ruHourSingleMatch = /(?<=^|[^а-яё])(час|часа|часов|ч)(?=$|[^а-яё])/i.test(text);
  const enHourSingleMatch = /\b(hour|hours|h)\b/i.test(text);
  if (ruHourSingleMatch || enHourSingleMatch) {
    return { sinceTs: now - 3600, desc: locale.timeframeHourSingle };
  }

  // 2. Match numeric minutes: "30 минут", "15 мин"
  const ruMinsMatch = text.match(/(?<=^|[^а-яё])(\d+)\s*(минут|минуты|минуту|мин)(?=$|[^а-яё])/i);
  const enMinsMatch = text.match(/\b(\d+)\s*(m|min|minute|minutes)\b/i);
  if (ruMinsMatch || enMinsMatch) {
    const match = ruMinsMatch || enMinsMatch;
    if (match) {
      const mins = parseInt(match[1], 10);
      const desc = locale.timeframeMin(mins);
      return { sinceTs: now - (mins * 60), desc };
    }
  }

  // Single minutes check
  const ruMinSingleMatch = /(?<=^|[^а-яё])(минут|минута|минуты|минуту|мин)(?=$|[^а-яё])/i.test(text);
  const enMinSingleMatch = /\b(min|minute|minutes)\b/i.test(text);
  if (ruMinSingleMatch || enMinSingleMatch) {
    return { sinceTs: now - 600, desc: locale.timeframeMinSingle };
  }

  // 3. Today / "сегодня" (from 00:00 of the current day in target timezone)
  const ruTodayMatch = /(?<=^|[^а-яё])(сегодня)(?=$|[^а-яё])/i.test(text);
  const enTodayMatch = /\b(today)\b/i.test(text);
  if (ruTodayMatch || enTodayMatch) {
    let midnightTs = getMidnightTimestamp(timezoneName, nowOverride);
    if (midnightTs >= now) {
      midnightTs = now - defaultSeconds;
    }
    return { sinceTs: midnightTs, desc: locale.timeframeToday };
  }

  // 4. Yesterday / "вчера" (from 00:00 of yesterday in target timezone)
  const ruYesterdayMatch = /(?<=^|[^а-яё])(вчера)(?=$|[^а-яё])/i.test(text);
  const enYesterdayMatch = /\b(yesterday)\b/i.test(text);
  if (ruYesterdayMatch || enYesterdayMatch) {
    const todayMidnightTs = getMidnightTimestamp(timezoneName, nowOverride);
    const yesterdayMiddayMs = (todayMidnightTs - 12 * 3600) * 1000;
    const tzString = new Date(yesterdayMiddayMs).toLocaleString('sv-SE', { timeZone: timezoneName });
    const [yesterdayDatePart] = tzString.split(' ');
    const yesterdayTs = getMidnightTimestampForDate(yesterdayDatePart, timezoneName);
    return { sinceTs: yesterdayTs, untilTs: todayMidnightTs, desc: locale.timeframeYesterday };
  }

  // 5. Match numeric days: "3 дня", "5 дней"
  const ruDaysMatch = text.match(/(?<=^|[^а-яё])(\d+)\s*(день|дня|дней|дн)(?=$|[^а-яё])/i);
  const enDaysMatch = text.match(/\b(\d+)\s*(day|days|d)\b/i);
  if (ruDaysMatch || enDaysMatch) {
    const match = ruDaysMatch || enDaysMatch;
    if (match) {
      const days = parseInt(match[1], 10);
      const desc = locale.timeframeDay(days);
      return { sinceTs: now - (days * 24 * 3600), desc };
    }
  }

  // Single days checks
  const ruSutkiMatch = /(?<=^|[^а-яё])(сутки|суток)(?=$|[^а-яё])/i.test(text);
  if (ruSutkiMatch) {
    return { sinceTs: now - (24 * 3600), desc: locale.timeframe24h };
  }

  const ruDaySingleMatch = /(?<=^|[^а-яё])(день)(?=$|[^а-яё])/i.test(text);
  const enDaySingleMatch = /\b(day)\b/i.test(text);
  if (ruDaySingleMatch || enDaySingleMatch) {
    return { sinceTs: now - (24 * 3600), desc: locale.timeframeDaySingle };
  }

  // 6. Week / "неделя"
  const ruWeekMatch = /(?<=^|[^а-яё])(неделя|неделю|недели|недель|неделе)(?=$|[^а-яё])/i.test(text);
  const enWeekMatch = /\b(week|weeks)\b/i.test(text);
  if (ruWeekMatch || enWeekMatch) {
    return { sinceTs: now - (7 * 24 * 3600), desc: locale.timeframeWeek };
  }

  return { sinceTs: now - defaultSeconds, desc: defaultDesc };
}

/**
 * Checks if the bot is mentioned exactly in a message.
 */
export function isBotMentioned(message: any, botUsername: string): boolean {
  if (!message || !botUsername) return false;
  const text = (message.text || message.caption || "") as string;
  if (!text) return false;

  const targetMention = `@${botUsername.toLowerCase()}`;

  const hasMentionEntity = message.entities && Array.isArray(message.entities) && 
    message.entities.some((e: any) => e.type === 'mention');

  if (hasMentionEntity) {
    for (const entity of message.entities) {
      if (entity.type === 'mention') {
        const mentionText = text.substring(entity.offset, entity.offset + entity.length);
        if (mentionText.toLowerCase() === targetMention) {
          return true;
        }
      }
    }
    return false;
  }

  // Fallback to boundary-aware regex
  const regex = new RegExp('@' + botUsername + '(?![A-Za-z0-9_])', 'i');
  return regex.test(text);
}

/**
 * Periodically deletes database records older than 30 days.
 */
async function databaseCleanupLoop(): Promise<void> {
  try {
    const cleaned = await db.cleanupOldMessages(30);
    log("INFO", `Database cleanup: removed ${cleaned} messages older than 30 days.`);
  } catch (err) {
    log("ERROR", "Error in database cleanup loop:", safeErrorForLog(err));
  }
}

/**
 * Saves incoming messages or updates edited messages in the database.
 */
export async function logMessage(ctx: Context): Promise<void> {
  const message = ctx.message || ctx.editedMessage;
  if (!message) return;

  const chat_id = message.chat.id;
  if (!isChatAuthorized(chat_id)) {
    log("DEBUG", `Unauthorized chat ${chat_id}, skipping message persistence.`);
    return;
  }

  const text = ('text' in message ? message.text : '') || ('caption' in message ? message.caption : '');
  if (!text) return;

  // Don't log bot command updates
  if (text.startsWith('/')) return;

  const botUsername = ctx.botInfo?.username;
  if (botUsername && isBotMentioned(message, botUsername)) {
    return;
  }

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

const activeLocks = new Set<number>();

/**
 * Orchestrates fetching logs, invoking Gemini, and displaying the summary.
 */
async function runSummarization(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.chat) return;
  
  const chatId = ctx.chat.id;
  const locale = getLocale();

  const replyOptions: { message_thread_id?: number } = {};
  const threadId = ('message_thread_id' in message ? message.message_thread_id : undefined) || null;
  if (threadId) {
    replyOptions.message_thread_id = threadId;
  }

  if (activeLocks.has(chatId)) {
    await ctx.reply(locale.summarizationInProgress, replyOptions);
    return;
  }
  activeLocks.add(chatId);

  try {
    const rateLimitResult = isRateLimited(chatId);
    if (rateLimitResult.limited) {
      await ctx.reply(locale.rateLimited(rateLimitResult.retryAfter || 0), replyOptions);
      return;
    }

    const text = ('text' in message ? message.text : '') || "";
    const tz = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';

    let statusMessage: any = null;

    try {
      const { sinceTs, untilTs, desc: timeframeDesc } = parseTimeframe(text, tz);
      log("INFO", `Initiating summarization request in chat_id=${chatId} (thread_id=${threadId}). Timeframe parsed: sinceTs=${sinceTs}, untilTs=${untilTs} (${timeframeDesc})`);

      statusMessage = await ctx.reply(
        locale.gatheringMessages,
        { ...replyOptions, parse_mode: 'HTML' }
      );

      const chatMessages = await db.getMessages(chatId, sinceTs, threadId, 5000, untilTs);
      const botUsername = ctx.botInfo?.username;

      // Skip bot calls/commands in logs
      const filteredMessages = chatMessages.filter(msg => {
        const msgText = msg.text || '';
        if (msgText.startsWith('/')) return false;
        if (botUsername && isBotMentioned(msg, botUsername)) return false;
        return true;
      });

      log("INFO", `Retrieved ${chatMessages.length} total messages from DB. Filtered down to ${filteredMessages.length} messages for analysis.`);
      if (filteredMessages.length > 0) {
        log("DEBUG", `Analyzing ${filteredMessages.length} messages...`);
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

      const rawSummaryText = await summarizer.summarizeMessages(filteredMessages, timeframeDesc, tz);
      const summaryText = sanitizeHTML(rawSummaryText);

      const maxLength = 4000;
      if (summaryText.length > maxLength) {
        const chunks = splitHTMLText(summaryText, maxLength);

        // Delete status message
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
        } catch (err) {
          log("WARN", "Could not delete status message:", safeErrorForLog(err));
        }

        for (const chunk of chunks) {
          try {
            await ctx.reply(chunk, { ...replyOptions, parse_mode: 'HTML' });
          } catch (err) {
            log("WARN", "HTML error, falling back to plain text:", safeErrorForLog(err));
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
          log("WARN", "HTML error, falling back to plain text:", safeErrorForLog(err));
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            summaryText
          );
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log("ERROR", "Error during summarization execution:", safeErrorForLog(err));
      try {
        if (statusMessage) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            locale.failedToGenerateWithError(escapeHTML(errMsg)),
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.reply(locale.failedToGenerateWithError(escapeHTML(errMsg)), { ...replyOptions, parse_mode: 'HTML' });
        }
      } catch (editErr) {
        log("ERROR", "Could not send/update error message to user:", safeErrorForLog(editErr));
      }
    }
  } finally {
    activeLocks.delete(chatId);
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
  const isMentioned = botUsername && isBotMentioned(message, botUsername);

  if (isPrivate || isMentioned) {
    // In group chats, a @mention always triggers summarization (that's the bot's purpose).
    // In private chats, check for trigger keywords to distinguish summarization requests
    // from general greetings.
    if (isPrivate) {
      const triggerKeywords = ["суммаризуй", "суммаризация", "кратко", "итог", "summary", "summarize", "отчет", "конспект", "что обсуждали", "пересказ"];
      const textLower = text.toLowerCase();
      const hasTrigger = triggerKeywords.some(kw => textLower.includes(kw));

      if (!hasTrigger) {
        await ctx.reply(
          locale.welcomeMessage(botUsername || 'bot_username'),
          { parse_mode: 'HTML' }
        );
        return;
      }
    }

    await runSummarization(ctx);
  }
}

/**
 * Initialize and start the Telegram Bot.
 */
/**
 * Checks fail-closed mode on startup and logs a warning if misconfigured.
 */
export function checkFailClosedMode(): void {
  if (!process.env.ALLOWED_CHATS && !process.env.ALLOWED_USERS && process.env.ALLOW_ALL_CHATS !== 'true') {
    log("WARN", "WARNING: Bot is running in fail-closed mode. No chats or users are authorized. Please configure ALLOWED_CHATS, ALLOWED_USERS or ALLOW_ALL_CHATS=true.");
  }
}

async function startBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("FATAL", "TELEGRAM_BOT_TOKEN environment variable is missing. Exiting.");
    process.exit(1);
  }

  if (process.env.DEFAULT_TIMEZONE) {
    if (!validateTimezone(process.env.DEFAULT_TIMEZONE)) {
      log("WARN", `Invalid timezone configured in DEFAULT_TIMEZONE: ${process.env.DEFAULT_TIMEZONE}. Falling back to UTC.`);
      process.env.DEFAULT_TIMEZONE = 'UTC';
    }
  }

  // Check fail-closed mode on startup
  checkFailClosedMode();

  log("INFO", "Initializing SQLite database...");
  const rawDbPath = process.env.DB_PATH || 'data/bot_messages.db';
  const dbPath = path.resolve(rawDbPath);
  // Validate DB_PATH doesn't contain path traversal
  if (rawDbPath.includes('..')) {
    log("FATAL", `DB_PATH contains path traversal ('..') and is rejected: ${rawDbPath}`);
    process.exit(1);
  }
  log("INFO", `Database path resolved to: ${dbPath}`);
  db.setDbPath(dbPath);
  await db.initDb();

  const bot = new Telegraf(token);

  // Persist incoming messages and edits (excluding commands) only for authorized chats.
  bot.on(['message', 'edited_message'], async (ctx, next) => {
    try {
      const message = ctx.message || ctx.editedMessage;
      if (message) {
        const chat_id = message.chat.id;
        const type = ctx.message ? 'message' : 'edited_message';
        log("DEBUG", `Received ${type} in chat ${chat_id} (user_id=${message.from?.id || 'unknown'})`);
      }
      await logMessage(ctx);
    } catch (err) {
      log("ERROR", "Error logging message:", safeErrorForLog(err));
    }
    return next();
  });

  // Authorization middleware — blocks all interactive responses for unauthorized chats
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined && !isChatAuthorized(chatId)) {
      log("DEBUG", `Unauthorized chat ${chatId}, skipping interactive handlers.`);
      return; // Do not call next() — block summarization, welcome messages, etc.
    }
    return next();
  });

  // Main listener for text requests (mentions & private chats)
  bot.on('text', async (ctx) => {
    try {
      await handleBotMentionOrPrivate(ctx);
    } catch (err) {
      log("ERROR", "Error handling potential summarization trigger:", safeErrorForLog(err));
    }
  });

  // Fetch bot info once to register and log authorization
  const botInfo = await bot.telegram.getMe();
  log("INFO", `Bot successfully authorized as @${botInfo.username}`);

  // Schedule database cleanup task to run on boot and then once a day
  await databaseCleanupLoop();
  const cleanupInterval = setInterval(databaseCleanupLoop, 24 * 3600 * 1000);

  // Poll for message and edit updates
  log("INFO", "Starting bot polling loop...");
  await bot.launch({
    allowedUpdates: ['message', 'edited_message']
  });

  // Configure graceful shutdown (clear interval)
  process.once('SIGINT', () => { clearInterval(cleanupInterval); bot.stop('SIGINT'); });
  process.once('SIGTERM', () => { clearInterval(cleanupInterval); bot.stop('SIGTERM'); });
}

// Check if this module is run as the main script entry point
const nodePath = process.argv[1];
const currentPath = fileURLToPath(import.meta.url);

if (nodePath && path.resolve(nodePath) === path.resolve(currentPath)) {
  startBot().catch(err => {
    log("FATAL", "Failed to run bot app launcher:", safeErrorForLog(err));
    process.exit(1);
  });
}

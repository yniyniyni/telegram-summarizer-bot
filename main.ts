import 'dotenv/config';
import { fileURLToPath } from 'url';
import path from 'path';
import { Telegraf, Context } from 'telegraf';
import * as db from './db.js';
import * as summarizer from './summarizer.js';
import { getLocale } from './locales.js';
import { escapeHTML, sanitizeHTML, isChatAuthorized, isRateLimited, splitHTMLText, log, safeErrorForLog } from './utils.js';
import * as media from './media.js';

export interface TimeframeResult {
  sinceTs: number;
  untilTs?: number;
  desc: string;
  /** True when the user explicitly specified a timeframe; false for the default 24h fallback. */
  explicit: boolean;
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
      return { sinceTs: now - (hours * 3600), desc, explicit: true };
    }
  }

  // Single hour check
  const ruHourSingleMatch = /(?<=^|[^а-яё])(час|часа|часов|ч)(?=$|[^а-яё])/i.test(text);
  const enHourSingleMatch = /\b(hour|hours|h)\b/i.test(text);
  if (ruHourSingleMatch || enHourSingleMatch) {
    return { sinceTs: now - 3600, desc: locale.timeframeHourSingle, explicit: true };
  }

  // 2. Match numeric minutes: "30 минут", "15 мин"
  const ruMinsMatch = text.match(/(?<=^|[^а-яё])(\d+)\s*(минут|минуты|минуту|мин)(?=$|[^а-яё])/i);
  const enMinsMatch = text.match(/\b(\d+)\s*(m|min|minute|minutes)\b/i);
  if (ruMinsMatch || enMinsMatch) {
    const match = ruMinsMatch || enMinsMatch;
    if (match) {
      const mins = parseInt(match[1], 10);
      const desc = locale.timeframeMin(mins);
      return { sinceTs: now - (mins * 60), desc, explicit: true };
    }
  }

  // Single minutes check
  const ruMinSingleMatch = /(?<=^|[^а-яё])(минут|минута|минуты|минуту|мин)(?=$|[^а-яё])/i.test(text);
  const enMinSingleMatch = /\b(min|minute|minutes)\b/i.test(text);
  if (ruMinSingleMatch || enMinSingleMatch) {
    return { sinceTs: now - 600, desc: locale.timeframeMinSingle, explicit: true };
  }

  // 3. Today / "сегодня" (from 00:00 of the current day in target timezone)
  const ruTodayMatch = /(?<=^|[^а-яё])(сегодня)(?=$|[^а-яё])/i.test(text);
  const enTodayMatch = /\b(today)\b/i.test(text);
  if (ruTodayMatch || enTodayMatch) {
    let midnightTs = getMidnightTimestamp(timezoneName, nowOverride);
    if (midnightTs >= now) {
      midnightTs = now - defaultSeconds;
    }
    return { sinceTs: midnightTs, desc: locale.timeframeToday, explicit: true };
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
    return { sinceTs: yesterdayTs, untilTs: todayMidnightTs, desc: locale.timeframeYesterday, explicit: true };
  }

  // 5. Match numeric days: "3 дня", "5 дней"
  const ruDaysMatch = text.match(/(?<=^|[^а-яё])(\d+)\s*(день|дня|дней|дн)(?=$|[^а-яё])/i);
  const enDaysMatch = text.match(/\b(\d+)\s*(day|days|d)\b/i);
  if (ruDaysMatch || enDaysMatch) {
    const match = ruDaysMatch || enDaysMatch;
    if (match) {
      const days = parseInt(match[1], 10);
      const desc = locale.timeframeDay(days);
      return { sinceTs: now - (days * 24 * 3600), desc, explicit: true };
    }
  }

  // Single days checks
  const ruSutkiMatch = /(?<=^|[^а-яё])(сутки|суток)(?=$|[^а-яё])/i.test(text);
  if (ruSutkiMatch) {
    return { sinceTs: now - (24 * 3600), desc: locale.timeframe24h, explicit: true };
  }

  const ruDaySingleMatch = /(?<=^|[^а-яё])(день)(?=$|[^а-яё])/i.test(text);
  const enDaySingleMatch = /\b(day)\b/i.test(text);
  if (ruDaySingleMatch || enDaySingleMatch) {
    return { sinceTs: now - (24 * 3600), desc: locale.timeframeDaySingle, explicit: true };
  }

  // 6. Week / "неделя"
  const ruWeekMatch = /(?<=^|[^а-яё])(неделя|неделю|недели|недель|неделе)(?=$|[^а-яё])/i.test(text);
  const enWeekMatch = /\b(week|weeks)\b/i.test(text);
  if (ruWeekMatch || enWeekMatch) {
    return { sinceTs: now - (7 * 24 * 3600), desc: locale.timeframeWeek, explicit: true };
  }

  // 7. Month / "месяц"
  const ruMonthsMatch = text.match(/(?<=^|[^а-яё])(\d+)\s*(месяц|месяца|месяцев|мес)(?=$|[^а-яё])/i);
  const enMonthsMatch = text.match(/\b(\d+)\s*(month|months)\b/i);
  if (ruMonthsMatch || enMonthsMatch) {
    const match = ruMonthsMatch || enMonthsMatch;
    if (match) {
      const months = parseInt(match[1], 10);
      return { sinceTs: now - (months * 30 * 24 * 3600), desc: locale.timeframeMonth(months), explicit: true };
    }
  }
  // Single month check
  const ruMonthSingleMatch = /(?<=^|[^а-яё])(месяц|месяца|месяцев|мес)(?=$|[^а-яё])/i.test(text);
  const enMonthSingleMatch = /\b(month|months)\b/i.test(text);
  if (ruMonthSingleMatch || enMonthSingleMatch) {
    return { sinceTs: now - (30 * 24 * 3600), desc: locale.timeframeMonthSingle, explicit: true };
  }

  return { sinceTs: now - defaultSeconds, desc: defaultDesc, explicit: false };
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
    // Delete media files for old messages before DB cleanup
    const oldPaths = await db.getOldMediaPaths(30);
    if (oldPaths.length > 0) {
      const deleted = media.deleteMediaFiles(oldPaths);
      log("INFO", `Database cleanup: removed ${deleted} media files older than 30 days.`);
    }

    const cleaned = await db.cleanupOldMessages(30);
    log("INFO", `Database cleanup: removed ${cleaned} messages older than 30 days.`);
  } catch (err) {
    log("ERROR", "Error in database cleanup loop:", safeErrorForLog(err));
  }
}

/**
 * Saves incoming messages or updates edited messages in the database.
 * When multimodal is enabled, detects photo/voice/video_note, downloads them
 * via Telegram API, and persists media metadata alongside the message.
 */
export async function logMessage(ctx: Context): Promise<void> {
  const message = ctx.message || ctx.editedMessage;
  if (!message) return;

  const chat_id = message.chat.id;
  if (!isChatAuthorized(chat_id)) {
    log("DEBUG", `Unauthorized chat ${chat_id}, skipping message persistence.`);
    return;
  }

  const text: string = ('text' in message ? (message.text || '') : '') || ('caption' in message ? (message.caption || '') : '');

  // Detect media (only when master switch is on)
  let mediaType: string | null = null;
  let mediaFileId: string | null = null;

  if (media.multimodalEnabled()) {
    if (media.imagesEnabled() && 'photo' in message && message.photo && message.photo.length > 0) {
      // Pick largest photo (last in array)
      const photo = message.photo[message.photo.length - 1];
      mediaType = 'image';
      mediaFileId = photo.file_id;
    } else if (media.voiceEnabled() && 'voice' in message && message.voice) {
      mediaType = 'voice';
      mediaFileId = message.voice.file_id;
    } else if (media.videoNoteEnabled() && 'video_note' in message && message.video_note) {
      mediaType = 'video_note';
      mediaFileId = message.video_note.file_id;
    }
  }

  // Bail only if neither text nor media
  if (!text && !mediaType) return;

  // Skip commands (even with media — but media-only messages without /text are not commands)
  if (text && text.startsWith('/')) return;

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

  // ── Phase 1 (synchronous): persist message metadata immediately ──
  // Save first so the middleware chain is never blocked on network I/O.
  await db.saveMessage({
    chat_id,
    message_id,
    user_id,
    username,
    first_name,
    last_name,
    text,
    timestamp,
    thread_id,
    media_type: mediaType,
    media_file_id: mediaFileId,
    media_path: null,           // filled in by the async download below
    media_mime_type: null,
  });

  // ── Phase 2 (async, fire-and-forget): download media, then update DB ──
  if (mediaType && mediaFileId && ctx.telegram) {
    const botToken = ctx.telegram.token;
    // Capture plain values — don't reference ctx inside the async IIFE.
    const _chatId = chat_id;
    const _messageId = message_id;
    const _mediaType = mediaType;
    const _mediaFileId = mediaFileId;

    // This runs in the background and must NOT be awaited.
    (async () => {
      try {
        const result = await media.downloadMedia(botToken, _mediaFileId, _chatId, _messageId, _mediaType);
        if (result) {
          await db.setMediaPath(_chatId, _messageId, result.path, result.mimeType);

          // Enforce storage limit after a successful download
          const maxMb = media.getStorageMaxMb();
          try {
            const oldest = await db.getOldestMediaRecords(100);
            const deleted = media.enforceStorageLimit(oldest, maxMb);
            if (deleted.length > 0) {
              for (const p of deleted) {
                try { await db.clearMediaPath(p); } catch (_) { /* best effort */ }
              }
            }
          } catch (err) {
            log("WARN", `Storage limit enforcement failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        log("WARN", `Async media download failed for msg ${_messageId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }
}

const activeLocks = new Set<number>();

// ── Summary cache for deep-dive mode ──
export interface CachedSummary {
  html: string;
  sinceTs: number;
  untilTs?: number;
  messageCount: number;
  createdAt: number;
}
export const summaryCache = new Map<string, CachedSummary>();

export function deepDiveEnabled(): boolean {
  return (process.env.DEEP_DIVE_ENABLED || '').trim().toLowerCase() === 'true';
}

// ── Interrogative markers ──
// NOTE: '?' is intentionally omitted — bare '?' would match ANY polite `@bot summary?`
// request and route summarization to deep-dive. Other markers (`что`, `how`, `why`, etc.)
// already cover genuine questions.
const INTERROGATIVE_MARKERS = [
  'как', 'что', 'почему', 'кто', 'когда', 'где', 'зачем', 'какой', 'какая', 'какие',
  'каков', 'расскажи', 'распиши', 'объясни', 'поясни', 'опиши', 'подробнее', 'углубись',
  'how', 'what', 'why', 'who', 'when', 'where', 'tell', 'explain', 'describe', 'elaborate',
  'deep dive', 'detail', 'details', 'break down', 'dig into', 'look into',
];

// ── Deep-dive request parsing ──
export function parseDeepDiveRequest(
  text: string,
  parsedTimeframe: TimeframeResult
): string | null {
  let remaining = text;

  // 1. Remove @bot mention
  remaining = remaining.replace(/@\w+\s*/g, '').trim();

  // 2. Remove timeframe description phrase
  if (parsedTimeframe.desc) {
    const descIdx = remaining.toLowerCase().indexOf(parsedTimeframe.desc.toLowerCase());
    if (descIdx !== -1) {
      remaining = remaining.slice(0, descIdx) + remaining.slice(descIdx + parsedTimeframe.desc.length);
    }
  }

  // 3. Remove common timeframe framing words
  const timeFramingPhrases = [
    'за последние', 'за последний', 'за последнюю', 'за последних',
    'за прошедшие', 'за прошедший', 'за прошедшую',
    'for the last', 'for last', 'in the last', 'in last',
    'during the last', 'during last',
  ];
  for (const phrase of timeFramingPhrases) {
    const idx = remaining.toLowerCase().indexOf(phrase.toLowerCase());
    if (idx !== -1) {
      remaining = remaining.slice(0, idx) + remaining.slice(idx + phrase.length);
    }
  }

  // 4. Remove numeric timeframe values
  // English units — \b works because JS \w = [a-zA-Z0-9_]
  remaining = remaining.replace(
    /\b\d+\s*(hour|hours|h|min|minute|minutes|day|days|d|week|weeks|month|months)\b/gi,
    ''
  );
  // Russian units — NO trailing \b because JS \b is ASCII-only and Cyrillic
  // chars are \W, so \b after них never matches. Leading \b before \d+ still works.
  remaining = remaining.replace(
    /\b\d+\s*(час|часа|часов|ч|минут|минуты|минуту|мин|день|дня|дней|дн|недел|неделю|недели|недель|месяц|месяца|месяцев|мес)/gi,
    ''
  );

  remaining = remaining.trim();

  // 5. Candidate too short
  if (remaining.length < 3) return null;

  // 6. Check interrogative markers
  const lower = remaining.toLowerCase();
  const hasMarker = INTERROGATIVE_MARKERS.some(m => lower.includes(m));
  if (!hasMarker) return null;

  return remaining;
}

/**
 * Orchestrates fetching logs, invoking Gemini, and displaying the summary.
 */
async function runSummarization(ctx: Context, preParsedTimeframe?: TimeframeResult): Promise<void> {
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
      const timeframe = preParsedTimeframe ?? parseTimeframe(text, tz);
      const { sinceTs, untilTs, desc: timeframeDesc } = timeframe;
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

      // Check if there are ANY messages (text or media) to summarize
      const hasAnyContent = filteredMessages.some(m =>
        (m.text && m.text.trim()) || (m.media_type && m.media_path)
      );

      if (!hasAnyContent) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          locale.noTextMessagesForPeriod(timeframeDesc),
          { parse_mode: 'HTML' }
        );
        return;
      }

      const rawSummaryText = await summarizer.summarizeMessages(filteredMessages, timeframeDesc, tz, text);
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

      // Save to deep-dive cache
      if (deepDiveEnabled()) {
        const cacheKey = `${chatId}:${threadId ?? 0}`;
        summaryCache.set(cacheKey, {
          html: summaryText,
          sinceTs,
          untilTs,
          messageCount: filteredMessages.length,
          createdAt: Date.now(),
        });
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

async function runDeepDive(
  ctx: Context,
  timeframe: TimeframeResult,
  question: string
): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.chat) return;

  const chatId = ctx.chat.id;
  const locale = getLocale();

  const replyOptions: { message_thread_id?: number } = {};
  const threadId = ('message_thread_id' in message ? message.message_thread_id : undefined) || null;
  if (threadId) {
    replyOptions.message_thread_id = threadId;
  }

  const cacheKey = `${chatId}:${threadId ?? 0}`;

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

    const tz = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
    const botUsername = ctx.botInfo?.username;
    const includeLinks = summarizer.linksEnabled() && summarizer.isLinkableChat(chatId);

    let statusMessage: any = null;

    try {
      // ── Gather context ──
      let contextMessages: db.SavedMessage[];
      let cachedSummary: string | undefined;
      let contextDesc: string;

      if (timeframe.explicit) {
        // Scenario: explicit timeframe — fetch messages for the period
        contextMessages = await db.getMessages(chatId, timeframe.sinceTs, threadId, 5000, timeframe.untilTs);
        contextDesc = timeframe.desc;
        cachedSummary = undefined;
      } else {
        // Scenario: no explicit timeframe — use cached summary + raw messages
        const cached = summaryCache.get(cacheKey);
        if (cached) {
          contextMessages = await db.getMessages(chatId, cached.sinceTs, threadId, 5000, cached.untilTs);
          cachedSummary = cached.html;
          contextDesc = `${locale.timeframeDefault} (cached)`;
        } else {
          // No cache — fall back to last 24h
          const since = Math.floor(Date.now() / 1000) - 24 * 3600;
          contextMessages = await db.getMessages(chatId, since, threadId, 5000);
          contextDesc = locale.timeframeDefault;
          cachedSummary = undefined;
        }
      }

      // Filter commands and bot mentions
      const filteredMessages = contextMessages.filter(msg => {
        const msgText = msg.text || '';
        if (msgText.startsWith('/')) return false;
        if (botUsername && isBotMentioned(msg, botUsername)) return false;
        return true;
      });

      const hasAnyContent = filteredMessages.some(m =>
        (m.text && m.text.trim()) || (m.media_type && m.media_path)
      );

      if (!hasAnyContent) {
        await ctx.reply(locale.deepDiveNoContext, replyOptions);
        return;
      }

      statusMessage = await ctx.reply(
        locale.deepDiveGeneratingContext,
        { ...replyOptions, parse_mode: 'HTML' }
      );

      const { transcript } = summarizer.buildBoundedTranscript(
        filteredMessages, tz, summarizer.MAX_TRANSCRIPT_CHARS, includeLinks
      );

      if (!transcript) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          locale.noTextMessages,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const systemInstruction = includeLinks
        ? `${locale.deepDiveSystemInstruction}\n${locale.citationInstruction}`
        : locale.deepDiveSystemInstruction;

      const userPrompt = locale.deepDivePrompt(question, contextDesc, transcript, cachedSummary);

      log("INFO", `Deep-dive request in chat_id=${chatId} (thread_id=${threadId}): "${question.slice(0, 100)}", context: ${contextDesc}`);

      const provider = summarizer.getProvider();
      let summary: string;
      try {
        summary = provider === 'openai'
          ? await summarizer.generateWithOpenAI(systemInstruction, userPrompt)
          : await summarizer.generateWithGemini(systemInstruction, userPrompt);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log("ERROR", `Error calling ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API (deep-dive): ${errMsg}`);
        throw err;
      }

      if (!summary) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          locale.failedToGenerate,
          { parse_mode: 'HTML' }
        );
        return;
      }

      let html = sanitizeHTML(summary);
      if (includeLinks) {
        const byId = new Map(filteredMessages.map((m) => [m.message_id, m]));
        html = summarizer.linkifyCitations(html, byId);
      }

      const maxLength = 4000;
      if (html.length > maxLength) {
        const chunks = splitHTMLText(html, maxLength);
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
            html,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          log("WARN", "HTML error, falling back to plain text:", safeErrorForLog(err));
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            html
          );
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log("ERROR", "Error during deep-dive execution:", safeErrorForLog(err));
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
    // ── Deep-dive routing (must be first — even before trigger-keyword gating
    // in private chats, so questions like "расскажи про миграцию" reach deep-dive) ──
    if (deepDiveEnabled()) {
      const tz = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
      const timeframe = parseTimeframe(text, tz);
      const question = parseDeepDiveRequest(text, timeframe);
      if (question) {
        log("INFO", `Deep-dive request detected: timeframe=${timeframe.desc || 'none'}, question="${question.slice(0, 100)}"`);
        await runDeepDive(ctx, timeframe, question);
        return;
      }
      // If no question detected, save the parsed timeframe for summarization fallback
      // to avoid double-parsing in runSummarization.
      await runSummarization(ctx, timeframe);
      return;
    }

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

  // Multimodal + OpenAI compatibility warning
  if (media.multimodalEnabled() && summarizer.getProvider() === 'openai') {
    log("INFO", "Multimodal is enabled but LLM_PROVIDER=openai does not support native multimodal input. Media will be reduced to text placeholders.");
  }

  // Multimodal without Gemini API key
  if (media.multimodalEnabled() && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    log("WARN", "Multimodal is enabled but no Gemini API key is configured. Media will be logged but cannot be sent to the LLM. Set GEMINI_API_KEY or GOOGLE_API_KEY.");
  }

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

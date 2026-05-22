import { GoogleGenAI } from '@google/genai';
import { SavedMessage } from './db.js';
import { getLocale } from './locales.js';
import { escapeHTML, log } from './utils.js';

let aiInstance: GoogleGenAI | null = null;
export const MAX_TRANSCRIPT_CHARS = 120_000;

interface Target {
  regex: RegExp;
  pseudonym: string;
  length: number;
}

interface BoundedTranscript {
  transcript: string;
  includedTextMessageCount: number;
  skippedTextMessageCount: number;
}

/**
 * Initialize and retrieve the GoogleGenAI client instance.
 * @returns {GoogleGenAI}
 */
export function getAIClient(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("FATAL: Neither GEMINI_API_KEY nor GOOGLE_API_KEY is set. Cannot initialize AI client.");
    }
    // Instantiate GoogleGenAI
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

/**
 * Formats a Unix epoch timestamp into local date-time string YYYY-MM-DD HH:MM:SS
 * @param timestamp 
 * @param timezone 
 * @returns 
 */
export function formatTimestamp(timestamp: number, timezone: string): string {
  try {
    const date = new Date(timestamp * 1000);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(date);
    const p: { [key: string]: string } = {};
    for (const part of parts) {
      p[part.type] = part.value;
    }
    
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch (err: unknown) {
    log("ERROR", `Error formatting timestamp ${timestamp} for timezone ${timezone}: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback to UTC ISO string representation
    return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
  }
}

function formatMessageLine(msg: SavedMessage, timezoneName: string): string | null {
  const locale = getLocale();
  const text = (msg.text || '').trim();
  if (!text) return null;

  const timeStr = formatTimestamp(msg.timestamp, timezoneName);
  const firstName = msg.first_name || locale.noName;
  const lastName = msg.last_name || "";
  const name = `${firstName} ${lastName}`.trim();
  const username = msg.username;
  const userInfo = username ? `${name} (@${username})` : name;

  return `[${timeStr}] ${userInfo}: ${text}`;
}

function getSkippedMessagesLine(skippedCount: number): string {
  return getLocale().skippedMessages(skippedCount);
}

function truncateLineToBudget(line: string, maxChars: number): string {
  const suffix = '... [truncated to fit prompt size limit]';
  if (line.length <= maxChars) return line;
  if (maxChars <= suffix.length) return line.slice(0, Math.max(0, maxChars));
  return `${line.slice(0, maxChars - suffix.length)}${suffix}`;
}

export function buildBoundedTranscript(
  messages: SavedMessage[],
  timezoneName = 'Europe/Moscow',
  maxChars = MAX_TRANSCRIPT_CHARS
): BoundedTranscript {
  const isRedact = process.env.REDACT_USER_IDENTITIES === 'true';

  let formattedLines: string[] = [];

  if (isRedact) {
    const userIdToPseudonym = new Map<number, string>();
    let userCount = 0;

    const targets: Target[] = [];

    const buildTargetRegex = (target: string, pseudonym: string): Target => {
      const isMention = target.startsWith('@');
      const cleanTarget = isMention ? target.slice(1) : target;
      const escaped = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hasCyrillic = /[а-яёА-ЯЁ]/.test(cleanTarget);

      let regex: RegExp;
      if (isMention) {
        regex = new RegExp(`(?<![A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, 'gi');
      } else if (hasCyrillic) {
        const pattern = `(?<=^|[^а-яё])${escaped}(?=$|[^а-яё])`;
        regex = new RegExp(pattern, 'gi');
      } else {
        const pattern = `\\b${escaped}\\b`;
        regex = new RegExp(pattern, 'gi');
      }
      return { regex, pseudonym, length: target.length };
    };

    // First pass: assign pseudonyms and collect targets
    for (const msg of messages) {
      if (msg.user_id === undefined || msg.user_id === null) continue;
      if (!userIdToPseudonym.has(msg.user_id)) {
        userCount++;
        const pseudonym = `User ${userCount}`;
        userIdToPseudonym.set(msg.user_id, pseudonym);

        const first = (msg.first_name || '').trim();
        const last = (msg.last_name || '').trim();
        const username = (msg.username || '').trim();

        if (first && last) {
          const fullName = `${first} ${last}`;
          if (fullName.length > 2) {
            targets.push(buildTargetRegex(fullName, pseudonym));
          }
        }
        if (first && first !== 'Anonymous' && first !== 'Без имени') {
          if (first.length > 2) {
            targets.push(buildTargetRegex(first, pseudonym));
          }
        }
        if (last) {
          if (last.length > 2) {
            targets.push(buildTargetRegex(last, pseudonym));
          }
        }
        if (username) {
          targets.push(buildTargetRegex(`@${username}`, pseudonym));
          targets.push(buildTargetRegex(username, pseudonym));
        }
      }
    }

    // Sort targets by length descending
    targets.sort((a, b) => b.length - a.length);

    // Second pass: format and redact
    formattedLines = messages
      .map((msg) => {
        const text = (msg.text || '').trim();
        if (!text) return null;

        let redactedText = text;
        for (const target of targets) {
          redactedText = redactedText.replace(target.regex, target.pseudonym);
        }

        // Redact any remaining usernames
        redactedText = redactedText.replace(/@\w+/g, '@user_redacted');

        const timeStr = formatTimestamp(msg.timestamp, timezoneName);
        const pseudonym = userIdToPseudonym.get(msg.user_id) || 'User Unknown';

        return `[${timeStr}] ${pseudonym}: ${redactedText}`;
      })
      .filter((line): line is string => Boolean(line));

  } else {
    formattedLines = messages
      .map((msg) => formatMessageLine(msg, timezoneName))
      .filter((line): line is string => Boolean(line));
  }

  if (formattedLines.length === 0 || maxChars <= 0) {
    return {
      transcript: '',
      includedTextMessageCount: 0,
      skippedTextMessageCount: formattedLines.length
    };
  }

  const selectLatestLines = (budget: number): string[] => {
    if (budget <= 0) return [];

    const selectedLines: string[] = [];
    let usedChars = 0;

    for (let i = formattedLines.length - 1; i >= 0; i--) {
      const line = formattedLines[i];
      const separatorLength = selectedLines.length > 0 ? 1 : 0;
      const remainingChars = budget - usedChars - separatorLength;

      if (remainingChars <= 0) break;

      if (line.length <= remainingChars) {
        selectedLines.push(line);
        usedChars += separatorLength + line.length;
        continue;
      }

      if (selectedLines.length === 0) {
        selectedLines.push(truncateLineToBudget(line, remainingChars));
      }
      break;
    }

    return selectedLines.reverse();
  };

  let selectedLines = selectLatestLines(maxChars);
  let skippedTextMessageCount = formattedLines.length - selectedLines.length;
  if (skippedTextMessageCount === 0) {
    return {
      transcript: selectedLines.join('\n'),
      includedTextMessageCount: selectedLines.length,
      skippedTextMessageCount
    };
  }

  for (let attempts = 0; attempts < 3; attempts++) {
    const skippedLine = getSkippedMessagesLine(skippedTextMessageCount);
    const contentBudget = maxChars - skippedLine.length - 1;

    if (contentBudget <= 0) {
      const transcript = truncateLineToBudget(skippedLine, maxChars);
      return {
        transcript,
        includedTextMessageCount: 0,
        skippedTextMessageCount: formattedLines.length
      };
    }

    selectedLines = selectLatestLines(contentBudget);
    const adjustedSkippedTextMessageCount = formattedLines.length - selectedLines.length;

    if (adjustedSkippedTextMessageCount === skippedTextMessageCount) {
      return {
        transcript: [skippedLine, ...selectedLines].join('\n'),
        includedTextMessageCount: selectedLines.length,
        skippedTextMessageCount
      };
    }

    skippedTextMessageCount = adjustedSkippedTextMessageCount;
  }

  const skippedLine = getSkippedMessagesLine(skippedTextMessageCount);
  return {
    transcript: [skippedLine, ...selectedLines].join('\n').slice(0, maxChars),
    includedTextMessageCount: selectedLines.length,
    skippedTextMessageCount
  };
}

/**
 * Format chat messages and generate a structured summary using gemini-3.1-flash-lite.
 * @param messages List of message objects.
 * @param timeframeDesc Description of timeframe range.
 * @param timezoneName Target timezone (e.g. Europe/Moscow).
 * @returns Structured summary.
 */
export async function summarizeMessages(
  messages: SavedMessage[], 
  timeframeDesc: string, 
  timezoneName = 'Europe/Moscow'
): Promise<string> {
  const locale = getLocale();
  if (!messages || messages.length === 0) {
    return locale.noMessages;
  }

  const { transcript, includedTextMessageCount, skippedTextMessageCount } = buildBoundedTranscript(messages, timezoneName);
  if (!transcript) {
    return locale.noTextMessages;
  }
  if (skippedTextMessageCount > 0) {
    log("INFO", `Gemini transcript was truncated: skipped ${skippedTextMessageCount} older text messages, included ${includedTextMessageCount}.`);
  }

  const systemInstruction = locale.systemInstruction;
  const userPrompt = locale.userPromptTemplate(timeframeDesc, includedTextMessageCount, transcript);

  try {
    const aiClient = getAIClient();
    
    log("DEBUG", "==================== [GEMINI API REQUEST] ====================");
    log("DEBUG", `Model: gemini-3.1-flash-lite`);
    log("DEBUG", "=============================================================");

    const response = await aiClient.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.3
      }
    });

    return response.text || locale.failedToGenerate;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Error calling Gemini API: ${errMsg}`);
    return locale.geminiError(escapeHTML(errMsg));
  }
}

import { GoogleGenAI } from '@google/genai';
import { SavedMessage } from './db.js';
import { getLocale } from './locales.js';
import { escapeHTML, log } from './utils.js';

let aiInstance: GoogleGenAI | null = null;
export const MAX_TRANSCRIPT_CHARS = 1_000_000;

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export type LLMProvider = 'gemini' | 'openai';

/**
 * Resolve the configured LLM provider. Defaults to 'gemini' for backward
 * compatibility; set LLM_PROVIDER=openai to use an OpenAI-compatible endpoint.
 */
export function getProvider(): LLMProvider {
  return (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase() === 'openai'
    ? 'openai'
    : 'gemini';
}

/**
 * Whether to append source-message links to each topic in the summary.
 * Opt-in; defaults to false for backward compatibility.
 */
export function linksEnabled(): boolean {
  return (process.env.INCLUDE_MESSAGE_LINKS || '').trim().toLowerCase() === 'true';
}

/**
 * A chat supports t.me/c/ message links only when it is a supergroup/channel
 * (id of the form -100…). Basic groups and DMs have no message links.
 */
export function isLinkableChat(chatId: number): boolean {
  return /^-100\d+$/.test(String(chatId));
}

/**
 * Build a Telegram deep link to a specific message. Returns null for
 * non-linkable chats. Includes the thread id for forum-topic messages.
 */
export function buildMessageLink(
  chatId: number,
  threadId: number | null,
  messageId: number
): string | null {
  const match = String(chatId).match(/^-100(\d+)$/);
  if (!match) return null;
  const internal = match[1];
  return threadId != null
    ? `https://t.me/c/${internal}/${threadId}/${messageId}`
    : `https://t.me/c/${internal}/${messageId}`;
}

/**
 * Replace LLM-emitted [src:<id>] markers with Telegram HTML links. An id is
 * linked only if it exists in messagesById AND the chat supports message links;
 * any other marker (hallucinated / out-of-window / non-linkable chat) is removed.
 */
export function linkifyCitations(
  html: string,
  messagesById: Map<number, SavedMessage>
): string {
  const locale = getLocale();
  return html.replace(/\s*\[src:\s*#?(\d+)\]/gi, (_match, idStr: string) => {
    const msg = messagesById.get(Number(idStr));
    if (!msg) return '';
    const url = buildMessageLink(msg.chat_id, msg.thread_id, msg.message_id);
    if (!url) return '';
    return ` <a href="${url}">🔗 ${locale.messageLinkText}</a>`;
  });
}

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

function formatMessageLine(msg: SavedMessage, timezoneName: string, includeIds = false): string | null {
  const locale = getLocale();
  const text = (msg.text || '').trim();
  if (!text) return null;

  const timeStr = formatTimestamp(msg.timestamp, timezoneName);
  const firstName = msg.first_name || locale.noName;
  const lastName = msg.last_name || "";
  const name = `${firstName} ${lastName}`.trim();
  const username = msg.username;
  const userInfo = username ? `${name} (@${username})` : name;

  const prefix = includeIds ? `#${msg.message_id} | ` : '';
  return `[${prefix}${timeStr}] ${userInfo}: ${text}`;
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
  maxChars = MAX_TRANSCRIPT_CHARS,
  includeIds = false
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

        const prefix = includeIds ? `#${msg.message_id} | ` : '';
        return `[${prefix}${timeStr}] ${pseudonym}: ${redactedText}`;
      })
      .filter((line): line is string => Boolean(line));

  } else {
    formattedLines = messages
      .map((msg) => formatMessageLine(msg, timezoneName, includeIds))
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
 * Generate a summary via the Google Gemini SDK.
 */
async function generateWithGemini(systemInstruction: string, userPrompt: string): Promise<string> {
  const aiClient = getAIClient();
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  log("DEBUG", "==================== [GEMINI API REQUEST] ====================");
  log("DEBUG", `Model: ${model}`);
  log("DEBUG", "=============================================================");

  const response = await aiClient.models.generateContent({
    model,
    contents: userPrompt,
    config: {
      systemInstruction,
      temperature: 0.3
    }
  });

  return response.text || '';
}

/**
 * Generate a summary via any OpenAI-compatible Chat Completions endpoint
 * (OpenAI, OpenRouter, local servers, ...). Uses the native fetch client so
 * no extra dependency is required.
 */
async function generateWithOpenAI(systemInstruction: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("FATAL: OPENAI_API_KEY is not set. Cannot use the OpenAI-compatible provider.");
  }
  const baseURL = (process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;

  log("DEBUG", "==================== [OPENAI API REQUEST] ====================");
  log("DEBUG", `Model: ${model} @ ${baseURL}`);
  log("DEBUG", "=============================================================");

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`OpenAI API returned ${response.status} ${response.statusText}: ${errorBody.slice(0, 500)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Format chat messages and generate a structured summary using the configured
 * LLM provider (Gemini by default, or an OpenAI-compatible endpoint).
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

  const includeLinks = linksEnabled() && isLinkableChat(messages[0].chat_id);

  const { transcript, includedTextMessageCount, skippedTextMessageCount } =
    buildBoundedTranscript(messages, timezoneName, MAX_TRANSCRIPT_CHARS, includeLinks);
  if (!transcript) {
    return locale.noTextMessages;
  }
  if (skippedTextMessageCount > 0) {
    log("INFO", `Gemini transcript was truncated: skipped ${skippedTextMessageCount} older text messages, included ${includedTextMessageCount}.`);
  }

  const systemInstruction = includeLinks
    ? `${locale.systemInstruction}\n${locale.citationInstruction}`
    : locale.systemInstruction;
  const userPrompt = locale.userPromptTemplate(timeframeDesc, includedTextMessageCount, transcript);

  const provider = getProvider();
  try {
    const summary = provider === 'openai'
      ? await generateWithOpenAI(systemInstruction, userPrompt)
      : await generateWithGemini(systemInstruction, userPrompt);

    if (!summary) {
      return locale.failedToGenerate;
    }
    if (!includeLinks) {
      return summary;
    }
    const byId = new Map(messages.map((m) => [m.message_id, m]));
    return linkifyCitations(summary, byId);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Error calling ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API: ${errMsg}`);
    return locale.geminiError(escapeHTML(errMsg));
  }
}

import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { SavedMessage } from './db.js';
import { getLocale, Locales } from './locales.js';
import { shouldIncludeMedia, includeByDefault as mediaIncludeByDefault, filesApiMode } from './media.js';
import * as db from './db.js';
import { escapeHTML, log } from './utils.js';

let aiInstance: GoogleGenAI | null = null;
export const MAX_TRANSCRIPT_CHARS = 1_000_000;
export const MAX_MULTIMODAL_BASE64_BYTES = 10_000_000; // 10 MB base64-encoded — grace skip before hitting Gemini API limit

// MIME types we are willing to send as inlineData. Anything else (notably
// application/octet-stream from an unrecognized file extension) is skipped
// rather than sent, since the LLM rejects unsupported types with a 400 that
// would otherwise fail the entire request.
export const SUPPORTED_MULTIMODAL_MIME_TYPES = new Set<string>([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'audio/ogg', 'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/flac',
  'video/mp4', 'video/mpeg', 'video/webm', 'video/mov', 'video/3gpp',
]);

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

// ── Gemini Files API upload ──

export const FILES_API_POLL_INTERVAL_MS = 1000;
export const FILES_API_POLL_TIMEOUT_MS = 60_000;
// Refresh a cached URI if it has less than this many seconds of life left.
const FILES_API_EXPIRY_MARGIN_SEC = 5 * 60;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface UploadedFile {
  fileUri: string;
  mimeType: string;
  expiresAt: number; // unix seconds
}

/**
 * Upload a local media file to the Gemini Files API and wait until it is ACTIVE
 * (audio/video are processed asynchronously). Returns null on failure so the
 * caller can fall back to inline / skip. Files are retained by Google for ~48h.
 */
export async function uploadMediaToGemini(
  aiClient: GoogleGenAI,
  absPath: string,
  mimeType: string,
  displayName: string,
): Promise<UploadedFile | null> {
  try {
    let file = await aiClient.files.upload({
      file: absPath,
      config: { mimeType, displayName },
    });

    const deadline = Date.now() + FILES_API_POLL_TIMEOUT_MS;
    while (file.state === 'PROCESSING' && Date.now() < deadline) {
      await sleep(FILES_API_POLL_INTERVAL_MS);
      if (!file.name) break;
      file = await aiClient.files.get({ name: file.name });
    }

    if (file.state !== 'ACTIVE' || !file.uri) {
      log("WARN", `Files API upload not ACTIVE for ${absPath} (state=${file.state ?? 'unknown'})`);
      return null;
    }

    const expiresAt = file.expirationTime
      ? Math.floor(new Date(file.expirationTime).getTime() / 1000)
      : Math.floor(Date.now() / 1000) + 47 * 3600;

    return { fileUri: file.uri, mimeType: file.mimeType || mimeType, expiresAt };
  } catch (err) {
    log("WARN", `Files API upload failed for ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * For each included media message, obtain a Gemini Files API URI. In 'cache'
 * mode a still-valid URI stored in the DB is reused; otherwise the local file is
 * uploaded and (in 'cache' mode) the resulting URI is persisted for reuse.
 * Returns a map keyed by media_path. Used only when filesApiMode() !== 'off'.
 */
export async function resolveFileUris(
  messages: SavedMessage[],
  includeFlags: { images: boolean; voice: boolean; videoNote: boolean },
): Promise<Map<string, { fileUri: string; mimeType: string }>> {
  const map = new Map<string, { fileUri: string; mimeType: string }>();
  const mode = filesApiMode();
  if (mode === 'off') return map;

  const aiClient = getAIClient();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const msg of messages) {
    if (!msg.media_type || !msg.media_path) continue;

    const include =
      (msg.media_type === 'image' && includeFlags.images) ||
      (msg.media_type === 'voice' && includeFlags.voice) ||
      (msg.media_type === 'video_note' && includeFlags.videoNote);
    if (!include) continue;

    const mimeType = msg.media_mime_type || '';
    if (!SUPPORTED_MULTIMODAL_MIME_TYPES.has(mimeType)) continue;

    // Reuse a cached, not-yet-expired URI.
    if (
      mode === 'cache' &&
      msg.media_file_uri &&
      msg.media_file_uri_expires &&
      msg.media_file_uri_expires - nowSec > FILES_API_EXPIRY_MARGIN_SEC
    ) {
      map.set(msg.media_path, { fileUri: msg.media_file_uri, mimeType });
      continue;
    }

    const absPath = path.resolve(msg.media_path);
    if (!fs.existsSync(absPath)) continue;

    const uploaded = await uploadMediaToGemini(
      aiClient, absPath, mimeType, `msg-${msg.chat_id}-${msg.message_id}`
    );
    if (!uploaded) continue;

    map.set(msg.media_path, { fileUri: uploaded.fileUri, mimeType: uploaded.mimeType });

    if (mode === 'cache') {
      try {
        await db.setMediaFileUri(msg.chat_id, msg.message_id, uploaded.fileUri, uploaded.expiresAt);
      } catch (err) {
        log("DEBUG", `Failed to cache Files API URI for msg ${msg.message_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return map;
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

export interface MultimodalContent {
  contents: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  mediaCount: number;
  skippedMediaCount: number;
}

/**
 * Build a multimodal Gemini contents array with intermixed text and inline-data parts.
 * Media is read from disk and base64-encoded. Only media types with includeFlags=true
 * get inlineData parts; others get text placeholders only.
 */
export function buildMultimodalContents(
  messages: SavedMessage[],
  timeframeDesc: string,
  timezoneName: string,
  includeFlags: { images: boolean; voice: boolean; videoNote: boolean },
  locale: Locales,
  includeIds: boolean,
  // When present, an entry for a message's media_path means the media is sent as
  // a Gemini Files API reference (fileData) instead of inline base64. Populated
  // by resolveFileUris() when filesApiMode() !== 'off'.
  fileUriMap?: Map<string, { fileUri: string; mimeType: string }>
): MultimodalContent {
  const parts: Array<Record<string, unknown>> = [];
  let mediaCount = 0;
  let skippedMediaCount = 0;
  let totalBase64Bytes = 0;
  const isRedact = process.env.REDACT_USER_IDENTITIES === 'true';

  // Build text preamble (rules + instructions, without the transcript)
  const preambleText = locale.userPromptTemplate(timeframeDesc, messages.length, '')
    .replace('\n---\n<untrusted_transcript>\n\n</untrusted_transcript>\n---\n', '');

  parts.push({ text: preambleText + '\n\nHere is the message history to analyze:\n---' });

  // PII redaction prep (mirrors buildBoundedTranscript logic)
  let userIdToPseudonym: Map<number, string> | null = null;
  let redactTargets: Target[] = [];

  if (isRedact) {
    userIdToPseudonym = new Map<number, string>();
    let userCount = 0;

    const buildTargetRegex = (target: string, pseudonym: string): Target => {
      const isMention = target.startsWith('@');
      const cleanTarget = isMention ? target.slice(1) : target;
      const escaped = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hasCyrillic = /[а-яёА-ЯЁ]/.test(cleanTarget);

      let regex: RegExp;
      if (isMention) {
        regex = new RegExp(`(?<![A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, 'gi');
      } else if (hasCyrillic) {
        regex = new RegExp(`(?<=^|[^а-яё])${escaped}(?=$|[^а-яё])`, 'gi');
      } else {
        regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      }
      return { regex, pseudonym, length: target.length };
    };

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
          if (fullName.length > 2) redactTargets.push(buildTargetRegex(fullName, pseudonym));
        }
        if (first && first !== 'Anonymous' && first !== 'Без имени' && first.length > 2) {
          redactTargets.push(buildTargetRegex(first, pseudonym));
        }
        if (last && last.length > 2) {
          redactTargets.push(buildTargetRegex(last, pseudonym));
        }
        if (username) {
          redactTargets.push(buildTargetRegex(`@${username}`, pseudonym));
          redactTargets.push(buildTargetRegex(username, pseudonym));
        }
      }
    }
    redactTargets.sort((a, b) => b.length - a.length);
  }

  // Walk messages in chronological order
  for (const msg of messages) {
    const hasMedia = !!(msg.media_type && msg.media_path);
    let includeThisMedia = false;

    if (hasMedia) {
      switch (msg.media_type) {
        case 'image':      includeThisMedia = includeFlags.images; break;
        case 'voice':      includeThisMedia = includeFlags.voice; break;
        case 'video_note': includeThisMedia = includeFlags.videoNote; break;
      }
    }

    // Build text line for this message
    let textLine: string | null = null;
    const rawText = (msg.text || '').trim();
    const timeStr = formatTimestamp(msg.timestamp, timezoneName);
    const prefix = includeIds ? `#${msg.message_id} | ` : '';

    if (isRedact && userIdToPseudonym) {
      // PII mode: pseudonymize name and redact text
      const pseudonym = userIdToPseudonym.get(msg.user_id) || 'User Unknown';
      let redactedText = rawText;
      for (const target of redactTargets) {
        redactedText = redactedText.replace(target.regex, target.pseudonym);
      }
      redactedText = redactedText.replace(/@\w+/g, '@user_redacted');
      if (!rawText && !hasMedia) continue; // skip empty text-only messages in redact mode
      textLine = rawText
        ? `[${prefix}${timeStr}] ${pseudonym}: ${redactedText}`
        : `[${prefix}${timeStr}] ${pseudonym}: `;
    } else {
      // Normal mode: use formatMessageLine
      textLine = formatMessageLine(msg, timezoneName, includeIds);
      if (!textLine) {
        const firstName = msg.first_name || locale.noName;
        textLine = `[${prefix}${timeStr}] ${firstName}: `;
      }
    }

    // Append media placeholder to text line
    if (hasMedia) {
      switch (msg.media_type) {
        case 'image':      textLine += ` ${locale.photoAttached}`; break;
        case 'voice':      textLine += ` ${locale.voiceAttached}`; break;
        case 'video_note': textLine += ` ${locale.videoNoteAttached}`; break;
      }
    }

    parts.push({ text: textLine });

    // Prefer a Gemini Files API reference when one was resolved for this media —
    // this sends large files by URI with no inline base64 size limit.
    if (hasMedia && includeThisMedia && msg.media_path) {
      const fileRef = fileUriMap?.get(msg.media_path);
      if (fileRef) {
        parts.push({ fileData: { fileUri: fileRef.fileUri, mimeType: fileRef.mimeType } });
        mediaCount++;
        continue;
      }
    }

    // Append inlineData part if media is included and within size budget
    if (hasMedia && includeThisMedia && msg.media_path) {
      const mimeType = msg.media_mime_type || '';
      // Skip unsupported MIME types before touching the disk — sending one to
      // the LLM fails the whole request with a 400 (e.g. application/octet-stream).
      if (!SUPPORTED_MULTIMODAL_MIME_TYPES.has(mimeType)) {
        // Text line (with media placeholder) was already pushed above; just
        // record the skip and move on without attaching the binary.
        skippedMediaCount++;
        log("WARN", `Skipping media ${msg.media_path}: unsupported MIME type "${mimeType || '(none)'}" for multimodal input`);
        continue;
      }
      try {
        const absPath = path.resolve(msg.media_path);
        if (fs.existsSync(absPath)) {
          const buffer = fs.readFileSync(absPath);
          const base64 = buffer.toString('base64');

          if (totalBase64Bytes + base64.length > MAX_MULTIMODAL_BASE64_BYTES) {
            skippedMediaCount++;
            log("DEBUG", `Skipping media file ${msg.media_path}: would exceed multimodal payload limit (${(totalBase64Bytes + base64.length).toLocaleString()} > ${MAX_MULTIMODAL_BASE64_BYTES.toLocaleString()} bytes)`);
          } else {
            parts.push({
              inlineData: {
                mimeType,
                data: base64,
              },
            });
            totalBase64Bytes += base64.length;
            mediaCount++;
          }
        } else {
          skippedMediaCount++;
          log("DEBUG", `Media file not found on disk: ${msg.media_path}`);
        }
      } catch (err) {
        skippedMediaCount++;
        log("WARN", `Failed to read media file ${msg.media_path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  parts.push({ text: '\n---\n' });

  return {
    contents: [{ role: 'user', parts }],
    mediaCount,
    skippedMediaCount,
  };
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
 * Accepts either a plain text prompt (string) or a multimodal contents array.
 */
async function generateWithGemini(
  systemInstruction: string,
  userPromptOrContents: string | Array<{ role: string; parts: Array<Record<string, unknown>> }>
): Promise<string> {
  const aiClient = getAIClient();
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  log("DEBUG", "==================== [GEMINI API REQUEST] ====================");
  log("DEBUG", `Model: ${model}`);
  const isMultimodal = typeof userPromptOrContents !== 'string';
  if (isMultimodal) {
    log("DEBUG", `Multimodal request with ${(userPromptOrContents as any[])?.[0]?.parts?.length || 0} parts`);
  }
  log("DEBUG", "=============================================================");

  const response = await aiClient.models.generateContent({
    model,
    contents: userPromptOrContents,
    config: {
      systemInstruction,
      temperature: 0.3,
    },
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
 * @param userRequestText Optional original user request text for media keyword detection.
 * @returns Structured summary.
 */
export async function summarizeMessages(
  messages: SavedMessage[],
  timeframeDesc: string,
  timezoneName = 'Europe/Moscow',
  userRequestText?: string
): Promise<string> {
  const locale = getLocale();
  if (!messages || messages.length === 0) {
    return locale.noMessages;
  }

  const provider = getProvider();
  const includeLinks = linksEnabled() && isLinkableChat(messages[0].chat_id);

  // ── Multimodal path: detect media and route if applicable ──
  const hasMediaMessages = messages.some(m => m.media_type && m.media_path);

  // Determine media include flags
  let includeFlags: { images: boolean; voice: boolean; videoNote: boolean } = { images: false, voice: false, videoNote: false };
  if (hasMediaMessages && provider === 'gemini') {
    if (userRequestText) {
      includeFlags = shouldIncludeMedia(userRequestText);
    } else {
      includeFlags = { images: mediaIncludeByDefault(), voice: mediaIncludeByDefault(), videoNote: mediaIncludeByDefault() };
    }
  }

  const useMultimodal = hasMediaMessages && provider === 'gemini' &&
    (includeFlags.images || includeFlags.voice || includeFlags.videoNote);

  if (useMultimodal) {
    // When Files API is enabled, upload (or reuse cached) media URIs first so
    // large files are sent by reference instead of inline base64.
    let fileUriMap: Map<string, { fileUri: string; mimeType: string }> | undefined;
    if (filesApiMode() !== 'off') {
      try {
        fileUriMap = await resolveFileUris(messages, includeFlags);
        log("INFO", `Files API (${filesApiMode()}): ${fileUriMap.size} media files referenced by URI.`);
      } catch (err) {
        log("WARN", `Files API resolution failed, falling back to inline: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const multimodal = buildMultimodalContents(
      messages, timeframeDesc, timezoneName, includeFlags, locale, includeLinks, fileUriMap
    );
    log("INFO", `Multimodal request: ${multimodal.mediaCount} media parts included, ${multimodal.skippedMediaCount} skipped.`);

    const systemInstruction = includeLinks
      ? `${locale.systemInstruction}\n${locale.citationInstruction}`
      : locale.systemInstruction;

    try {
      const summary = await generateWithGemini(systemInstruction, multimodal.contents);
      if (!summary) return locale.failedToGenerate;
      if (!includeLinks) return summary;
      const byId = new Map(messages.map((m) => [m.message_id, m]));
      return linkifyCitations(summary, byId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log("ERROR", `Error calling Gemini API (multimodal): ${errMsg}`);
      return locale.geminiError(escapeHTML(errMsg));
    }
  }

  // If media exists but provider is openai, warn
  if (hasMediaMessages && provider === 'openai') {
    log("WARN", "Media messages present but LLM_PROVIDER=openai — media will be text placeholders only.");
  }

  // ── Text-only path ──
  const { transcript, includedTextMessageCount, skippedTextMessageCount } =
    buildBoundedTranscript(messages, timezoneName, MAX_TRANSCRIPT_CHARS, includeLinks);
  if (!transcript) {
    return locale.noTextMessages;
  }
  if (skippedTextMessageCount > 0) {
    log("INFO", `Transcript was truncated: skipped ${skippedTextMessageCount} older text messages, included ${includedTextMessageCount}.`);
  }

  const systemInstruction = includeLinks
    ? `${locale.systemInstruction}\n${locale.citationInstruction}`
    : locale.systemInstruction;
  const userPrompt = locale.userPromptTemplate(timeframeDesc, includedTextMessageCount, transcript);

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

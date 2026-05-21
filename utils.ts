/**
 * Escapes characters that have special meaning in HTML (&, <, >).
 * Used to prevent HTML injection/parsing errors for error logs and dynamic texts.
 */
export function escapeHTML(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sanitizes HTML output from Gemini. Escapes all `<`, `>`, and `&` characters
 * except for whitelisted safe Telegram formatting tags: b, i, code, pre.
 */
export function sanitizeHTML(input: string): string {
  if (!input) return "";

  // Split string by HTML tags: </?[tagName] ...>
  // Capturing parentheses in split() ensures the tags are returned as elements of the array.
  const parts = input.split(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g);
  
  // Whitelisted tags that are safe for Telegram.
  const allowedTags = new Set(['b', 'i', 'code', 'pre', '/b', '/i', '/code', '/pre']);

  return parts.map((part, index) => {
    // Odd indices correspond to matched tag tokens
    if (index % 2 === 1) {
      const match = part.match(/^<\/?([a-zA-Z0-9]+)/);
      if (match) {
        const tagName = match[1].toLowerCase();
        const fullTagName = part.startsWith('</') ? `/${tagName}` : tagName;
        
        if (allowedTags.has(fullTagName)) {
          // Normalize to clean standard tag without attributes (to avoid any HTML parser issues)
          return part.startsWith('</') ? `</${tagName}>` : `<${tagName}>`;
        }
      }
      // If tag is not whitelisted, treat it as plain text and escape
      return escapeHTML(part);
    } else {
      // Plain text token
      return escapeHTML(part);
    }
  }).join('');
}

// In-memory store for tracking chat rate limits
interface RateLimitInfo {
  timestamps: number[];
}
const rateLimits = new Map<number, RateLimitInfo>();

/**
 * Checks if a chat is rate-limited based on configuration in .env.
 * If limited, returns { limited: true, retryAfter: seconds }.
 * Otherwise, records the timestamp and returns { limited: false }.
 */
export function isRateLimited(chatId: number): { limited: boolean; retryAfter?: number } {
  const maxRequestsStr = process.env.RATE_LIMIT_MAX_REQUESTS;
  if (!maxRequestsStr) {
    return { limited: false };
  }
  const maxRequests = parseInt(maxRequestsStr, 10);
  if (isNaN(maxRequests) || maxRequests <= 0) {
    return { limited: false };
  }

  const windowSecStr = process.env.RATE_LIMIT_WINDOW_SEC || '3600';
  const windowSec = parseInt(windowSecStr, 10);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSec;

  let info = rateLimits.get(chatId);
  if (!info) {
    info = { timestamps: [] };
    rateLimits.set(chatId, info);
  }

  // Filter out timestamps older than the window
  info.timestamps = info.timestamps.filter(ts => ts > cutoff);

  // Clean up empty entries to prevent memory leak (NEW-3)
  if (info.timestamps.length === 0) {
    rateLimits.delete(chatId);
  }

  if (info.timestamps.length >= maxRequests) {
    const oldestTs = info.timestamps[0];
    const retryAfter = (oldestTs + windowSec) - now;
    return { limited: true, retryAfter: retryAfter > 0 ? retryAfter : 1 };
  }

  // Record current request
  let currentInfo = rateLimits.get(chatId);
  if (!currentInfo) {
    currentInfo = { timestamps: [] };
    rateLimits.set(chatId, currentInfo);
  }
  currentInfo.timestamps.push(now);
  return { limited: false };
}

/**
 * Resets the in-memory rate limits tracker (useful for tests).
 */
export function resetRateLimits(): void {
  rateLimits.clear();
}

/**
 * Validates if the chat is authorized to use the bot based on whitelist in .env.
 * If ALLOWED_CHATS is not set, authorization is disabled and all chats are allowed.
 */
// Cached allowed chats set for O(1) lookup (NEW-2)
let cachedAllowedChats: Set<number> | null = null;
let cachedAllowedChatsRaw: string | undefined = undefined;

export function isChatAuthorized(chatId: number): boolean {
  const raw = process.env.ALLOWED_CHATS;
  if (!raw) return true; // Authorization disabled (any chat allowed)

  // Re-parse only if the env value changed
  if (raw !== cachedAllowedChatsRaw) {
    cachedAllowedChatsRaw = raw;
    cachedAllowedChats = new Set(
      raw.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n))
    );
  }

  return cachedAllowedChats!.size === 0 || cachedAllowedChats!.has(chatId);
}

/**
 * Splits HTML text into chunks of maximum character length, ensuring that HTML tags
 * are not cut in half, and that any tags open at the end of a chunk are closed
 * and then reopened at the start of the next chunk.
 */
export function splitHTMLText(text: string, maxLength = 4000): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const parts = text.split(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g);
  const chunks: string[] = [];
  let currentChunk = "";
  const openTags: string[] = []; // Stack of currently open tags

  // Helper to compute size of closing tags for openTags stack
  const getCloseTagsString = () => openTags.map(tag => `</${tag}>`).reverse().join('');
  // Helper to compute size of opening tags for openTags stack
  const getOpenTagsString = () => openTags.map(tag => `<${tag}>`).join('');

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    // Check if it is a tag
    const isTag = i % 2 === 1;
    let tagName = "";
    let isCloseTag = false;

    if (isTag) {
      const match = part.match(/^<\/?([a-zA-Z0-9]+)/);
      if (match) {
        tagName = match[1].toLowerCase();
        isCloseTag = part.startsWith('</');
      }
    }

    if (!isTag) {
      // Split the text token into words and spaces to allow fine-grained splitting
      const words = part.split(/(\s+)/);
      for (const word of words) {
        if (!word) continue;

        const closeTagsStr = getCloseTagsString();
        const potentialLength = currentChunk.length + word.length + closeTagsStr.length;

        // Check if the current chunk has text content before deciding to push it.
        // We shouldn't push a chunk that has no text content (only tags).
        const hasTextContent = currentChunk.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0;

        if (potentialLength > maxLength && hasTextContent) {
          chunks.push(currentChunk + closeTagsStr);
          currentChunk = getOpenTagsString();
        }

        // If the single word itself is still longer than maxLength (even when starting a fresh chunk),
        // we have to split it by characters.
        if (currentChunk.length + word.length + getCloseTagsString().length > maxLength) {
          let wordRemaining = word;
          while (wordRemaining.length > 0) {
            const currentCloseTags = getCloseTagsString();
            const currentOpenTags = getOpenTagsString();
            const spaceLeft = maxLength - currentChunk.length - currentCloseTags.length;

            const currentHasText = currentChunk.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0;

            if (spaceLeft <= 0 || (!currentHasText && spaceLeft < maxLength / 2)) {
              if (currentHasText) {
                chunks.push(currentChunk + currentCloseTags);
              }
              // Guard against infinite loop (NEW-4): if no text was pushed and
              // spaceLeft <= 0, force at least 1 character of progress
              if (!currentHasText && spaceLeft <= 0) {
                const forceLen = Math.min(wordRemaining.length, Math.max(1, maxLength - currentOpenTags.length - currentCloseTags.length));
                currentChunk = currentOpenTags + wordRemaining.substring(0, forceLen);
                wordRemaining = wordRemaining.substring(forceLen);
                if (wordRemaining.length > 0) {
                  chunks.push(currentChunk + currentCloseTags);
                  currentChunk = currentOpenTags;
                }
                continue;
              }
              currentChunk = currentOpenTags;
              continue;
            }

            const sliceLen = Math.min(wordRemaining.length, spaceLeft);
            currentChunk += wordRemaining.substring(0, sliceLen);
            wordRemaining = wordRemaining.substring(sliceLen);

            if (wordRemaining.length > 0) {
              chunks.push(currentChunk + getCloseTagsString());
              currentChunk = getOpenTagsString();
            }
          }
        } else {
          currentChunk += word;
        }
      }
      continue;
    }

    // Processing tag tokens
    const closeTagsStr = getCloseTagsString();
    const potentialLength = currentChunk.length + part.length + closeTagsStr.length;
    const hasTextContent = currentChunk.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0;

    if (potentialLength > maxLength && hasTextContent) {
      chunks.push(currentChunk + closeTagsStr);
      currentChunk = getOpenTagsString();
    }

    currentChunk += part;

    if (isTag && tagName) {
      if (isCloseTag) {
        const lastIdx = openTags.lastIndexOf(tagName);
        if (lastIdx !== -1) {
          openTags.splice(lastIdx, 1);
        }
      } else {
        openTags.push(tagName);
      }
    }
  }

  if (currentChunk.trim().length > 0 || openTags.length > 0) {
    const finalCloseTags = getCloseTagsString();
    const finalStr = currentChunk + finalCloseTags;
    // Only push if it has text content other than HTML tags
    if (finalStr.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0) {
      chunks.push(finalStr);
    }
  }

  return chunks;
}

/**
 * Standard log function that filters out DEBUG messages unless debug mode is enabled.
 * Debug mode is enabled via environment variables: DEBUG=true/1 or LOG_LEVEL=debug.
 */
export function log(level: string, message: string, ...args: unknown[]): void {
  if (level.toUpperCase() === 'DEBUG') {
    const isDebugMode = process.env.DEBUG === 'true' || process.env.DEBUG === '1' || process.env.LOG_LEVEL?.toLowerCase() === 'debug';
    if (!isDebugMode) {
      return;
    }
  }
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${message}`, ...args);
}


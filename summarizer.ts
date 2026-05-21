import { GoogleGenAI } from '@google/genai';
import { SavedMessage } from './db.js';
import { getLocale } from './locales.js';
import { escapeHTML } from './utils.js';

let aiInstance: GoogleGenAI | null = null;

/**
 * Initialize and retrieve the GoogleGenAI client instance.
 * @returns {GoogleGenAI}
 */
export function getAIClient(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      console.warn("⚠️ Neither GEMINI_API_KEY nor GOOGLE_API_KEY environment variable is set.");
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
  } catch (err: any) {
    console.error(`Error formatting timestamp ${timestamp} for timezone ${timezone}:`, err);
    // Fallback to UTC ISO string representation
    return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
  }
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

  const transcriptLines: string[] = [];
  for (const msg of messages) {
    const timeStr = formatTimestamp(msg.timestamp, timezoneName);
    
    // Format sender details
    const firstName = msg.first_name || locale.noName;
    const lastName = msg.last_name || "";
    const name = `${firstName} ${lastName}`.trim();
    const username = msg.username;
    const userInfo = username ? `${name} (@${username})` : name;

    const text = (msg.text || '').trim();
    if (!text) continue;

    transcriptLines.push(`[${timeStr}] ${userInfo}: ${text}`);
  }

  const transcript = transcriptLines.join('\n');
  if (!transcript) {
    return locale.noTextMessages;
  }

  const systemInstruction = locale.systemInstruction;
  const userPrompt = locale.userPromptTemplate(timeframeDesc, messages.length, transcript);

  try {
    const aiClient = getAIClient();
    
    console.log("==================== [GEMINI API REQUEST] ====================");
    console.log(`Model: gemini-3.1-flash-lite`);
    console.log("=============================================================");

    const response = await aiClient.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.3
      }
    });

    return response.text || locale.failedToGenerate;
  } catch (err: any) {
    console.error("Error calling Gemini API:", err);
    return locale.geminiError(escapeHTML(err.message || String(err)));
  }
}

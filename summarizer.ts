import { GoogleGenAI } from '@google/genai';
import { SavedMessage } from './db.js';

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
 * Format chat messages and generate a structured summary in Russian using gemini-3.1-flash-lite.
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
  if (!messages || messages.length === 0) {
    return "Нет сообщений для суммаризации.";
  }

  const transcriptLines: string[] = [];
  for (const msg of messages) {
    const timeStr = formatTimestamp(msg.timestamp, timezoneName);
    
    // Format sender details
    const firstName = msg.first_name || "Без имени";
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
    return "В выбранном периоде нет текстовых сообщений.";
  }

  const systemInstruction = (
    "You are an expert Telegram chat summarizer bot. Your task is to analyze the provided chat log " +
    "and generate a high-quality, structured summary in Russian. " +
    "Focus on the main topics of discussion, questions asked, decisions made, and follow-up tasks."
  );

  const userPrompt = `
Проанализируй историю сообщений из группового чата Telegram за следующий период: ${timeframeDesc}.
Всего сообщений для анализа: ${messages.length}.

Напиши структурированный и краткий (но содержательный) отчет на русском языке по следующей схеме:

1. <b>Основные темы обсуждения</b>:
   Сгруппируй обсуждения по темам/сюжетам. Для каждой темы выдели:
   - Суть вопроса или проблемы.
   - Главные аргументы или мнения участников.
   - Чем закончилось обсуждение (решение, открытый вопрос, задача).

2. <b>Ключевые договоренности и решения</b>:
   Выпиши отдельным списком все принятые решения, договоренности, назначенные задачи или планы действий.

3. <b>Активные участники</b>:
   Упомяни самых активных участников обсуждений по именам или юзернеймам (через <code>@username</code>), если они важны для контекста тем.

Правила:
- Пиши только на русском языке.
- Используй исключительно HTML-разметку, поддерживаемую Telegram. Разрешены только теги: <b>текст</b> (для жирности), <i>текст</i> (для курсива), <code>текст</code> (для моноширинного шрифта). Категорически запрещено использовать разметку Markdown (символы *, _, \`, ** и т.д.).
- Для списков используй обычный перенос строки и дефисы "-" или маркеры "•" в начале строки. Не используй HTML-теги списков <ul>, <li>.
- Сохраняй объективность, не придумывай факты (галлюцинации недопустимы).
- Игнорируй служебные сообщения (команды боту, приветствия, спам).
- Если обсуждение было сумбурным, постарайся выделить главное.

Вот история сообщений для анализа:
---
${transcript}
---
`;

  try {
    const aiClient = getAIClient();
    
    console.log("==================== [GEMINI API REQUEST] ====================");
    console.log(`Model: gemini-3.1-flash-lite`);
    console.log(`System Instruction: ${systemInstruction}`);
    console.log(`User Prompt: ${userPrompt}`);
    console.log("=============================================================");

    const response = await aiClient.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.3
      }
    });

    console.log("==================== [GEMINI API RESPONSE] ====================");
    console.log(JSON.stringify(response, null, 2));
    console.log("==============================================================");

    return response.text || "Не удалось сгенерировать текст выжимки.";
  } catch (err: any) {
    console.error("Error calling Gemini API:", err);
    return `⚠️ Произошла ошибка при обращении к Gemini API: ${err.message || err}`;
  }
}

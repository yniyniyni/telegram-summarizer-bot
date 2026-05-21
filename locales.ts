export interface Locales {
  noMessages: string;
  noName: string;
  noTextMessages: string;
  systemInstruction: string;
  userPromptTemplate: (timeframeDesc: string, count: number, transcript: string) => string;
  geminiError: (err: string) => string;
  failedToGenerate: string;
  
  gatheringMessages: string;
  noTextMessagesForPeriod: (timeframeDesc: string) => string;
  failedToGenerateWithError: (err: string) => string;
  welcomeMessage: (botUsername: string) => string;
  
  timeframeDefault: string;
  timeframeHour: (hours: number) => string;
  timeframeHourSingle: string;
  timeframeMin: (mins: number) => string;
  timeframeMinSingle: string;
  timeframeDay: (days: number) => string;
  timeframeDaySingle: string;
  timeframe24h: string;
  timeframeToday: string;
  timeframeYesterday: string;
  timeframeWeek: string;
}

const ruLocale: Locales = {
  noMessages: "Нет сообщений для суммаризации.",
  noName: "Без имени",
  noTextMessages: "В выбранном периоде нет текстовых сообщений.",
  systemInstruction: 
    "You are an expert Telegram chat summarizer bot. Your task is to analyze the provided chat log " +
    "and generate a high-quality, structured summary in Russian. " +
    "Focus on the main topics of discussion, questions asked, decisions made, and follow-up tasks.",
  userPromptTemplate: (timeframeDesc, count, transcript) => `
Проанализируй историю сообщений из группового чата Telegram за следующий период: ${timeframeDesc}.
Всего сообщений для анализа: ${count}.

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
`,
  geminiError: (err) => `⚠️ Произошла ошибка при обращении к Gemini API: ${err}`,
  failedToGenerate: "Не удалось сгенерировать текст выжимки.",
  
  gatheringMessages: "⏳ <b>Собираю сообщения и генерирую выжимку через Gemini...</b>",
  noTextMessagesForPeriod: (timeframeDesc) => `📭 За период <b>${timeframeDesc}</b> не найдено текстовых сообщений для анализа.`,
  failedToGenerateWithError: (err) => `❌ Не удалось сгенерировать выжимку из-за ошибки: <code>${err}</code>`,
  welcomeMessage: (botUsername) => 
    "👋 <b>Привет! Я Gemini Суммаризатор чатов.</b>\n\n" +
    "Чтобы сделать краткую выжимку переписки:\n" +
    "1. Добавьте меня в групповой чат.\n" +
    "2. Убедитесь, что у меня <b>отключена Group Privacy</b> (в настройках бота у @BotFather) " +
    "или сделайте меня администратором, чтобы я мог видеть сообщения.\n" +
    "3. Напишите в группе запрос через мой тег, например:\n" +
    "<code>@" + botUsername + " суммаризуй чат за последние 3 часа</code>\n\n" +
    "Также вы можете отправить запрос <code>суммаризуй за час</code> прямо здесь, чтобы получить выжимку нашего диалога.",
  
  timeframeDefault: "последние 24 часа",
  timeframeHour: (hours) => {
    if (hours % 10 === 1 && hours % 100 !== 11) {
      return `последний ${hours} час`;
    } else if ([2, 3, 4].includes(hours % 10) && ![12, 13, 14].includes(hours % 100)) {
      return `последние ${hours} часа`;
    } else {
      return `последние ${hours} часов`;
    }
  },
  timeframeHourSingle: "последний час",
  timeframeMin: (mins) => {
    if (mins % 10 === 1 && mins % 100 !== 11) {
      return `последнюю ${mins} минуту`;
    } else if ([2, 3, 4].includes(mins % 10) && ![12, 13, 14].includes(mins % 100)) {
      return `последние ${mins} минуты`;
    } else {
      return `последние ${mins} минут`;
    }
  },
  timeframeMinSingle: "последние 10 минут",
  timeframeDay: (days) => {
    if (days % 10 === 1 && days % 100 !== 11) {
      return `последний ${days} день`;
    } else if ([2, 3, 4].includes(days % 10) && ![12, 13, 14].includes(days % 100)) {
      return `последние ${days} дня`;
    } else {
      return `последние ${days} дней`;
    }
  },
  timeframeDaySingle: "последний день",
  timeframe24h: "последние сутки",
  timeframeToday: "сегодня",
  timeframeYesterday: "вчера и сегодня",
  timeframeWeek: "последнюю неделю",
};

const enLocale: Locales = {
  noMessages: "No messages to summarize.",
  noName: "Anonymous",
  noTextMessages: "There are no text messages in the selected period.",
  systemInstruction: 
    "You are an expert Telegram chat summarizer bot. Your task is to analyze the provided chat log " +
    "and generate a high-quality, structured summary in English. " +
    "Focus on the main topics of discussion, questions asked, decisions made, and follow-up tasks.",
  userPromptTemplate: (timeframeDesc, count, transcript) => `
Analyze the message history of the Telegram group chat for the following period: ${timeframeDesc}.
Total messages to analyze: ${count}.

Write a structured and concise (yet informative) report in English according to the following scheme:

1. <b>Main Topics of Discussion</b>:
   Group discussions by topic/thread. For each topic, highlight:
   - The essence of the issue or question.
   - Key arguments or opinions of the participants.
   - The outcome of the discussion (decision, open question, task).

2. <b>Key Agreements and Decisions</b>:
   Provide a separate list of all decisions made, agreements, assigned tasks, or action plans.

3. <b>Active Participants</b>:
   Mention the most active participants by names or usernames (using <code>@username</code>) if they are important for the context of the topics.

Rules:
- Write only in English.
- Use only HTML markup supported by Telegram. Allowed tags are: <b>text</b> (for bold), <i>text</i> (for italic), <code>text</code> (for monospace). It is strictly forbidden to use Markdown markup (symbols like *, _, \`, ** etc.).
- For lists, use normal line breaks and hyphens "-" or bullet points "•" at the beginning of the line. Do not use HTML list tags like <ul>, <li>.
- Remain objective; do not invent facts (hallucinations are unacceptable).
- Ignore service messages (bot commands, greetings, spam).
- If the discussion was chaotic, try to highlight the main points.

Here is the message history to analyze:
---
${transcript}
---
`,
  geminiError: (err) => `⚠️ An error occurred while contacting Gemini API: ${err}`,
  failedToGenerate: "Failed to generate summary text.",
  
  gatheringMessages: "⏳ <b>Gathering messages and generating summary via Gemini...</b>",
  noTextMessagesForPeriod: (timeframeDesc) => `📭 No text messages found for analysis during the period <b>${timeframeDesc}</b>.`,
  failedToGenerateWithError: (err) => `❌ Failed to generate summary due to error: <code>${err}</code>`,
  welcomeMessage: (botUsername) => 
    "👋 <b>Hello! I am the Gemini Chat Summarizer Bot.</b>\n\n" +
    "To summarize group chat history:\n" +
    "1. Add me to a group chat.\n" +
    "2. Make sure <b>Group Privacy is disabled</b> in my @BotFather settings, " +
    "or promote me to admin, so that I can see the messages.\n" +
    "3. Ask for a summary in the group by mentioning me, e.g.:\n" +
    "<code>@" + botUsername + " summarize the chat for the last 3 hours</code>\n\n" +
    "You can also send a request like <code>summarize the last hour</code> here in private to get a summary of our chat.",
  
  timeframeDefault: "the last 24 hours",
  timeframeHour: (hours) => hours === 1 ? "the last 1 hour" : `the last ${hours} hours`,
  timeframeHourSingle: "the last hour",
  timeframeMin: (mins) => mins === 1 ? "the last 1 minute" : `the last ${mins} minutes`,
  timeframeMinSingle: "the last 10 minutes",
  timeframeDay: (days) => days === 1 ? "the last 1 day" : `the last ${days} days`,
  timeframeDaySingle: "the last day",
  timeframe24h: "the last 24 hours",
  timeframeToday: "today",
  timeframeYesterday: "yesterday and today",
  timeframeWeek: "the last week",
};

/**
 * Returns the Locales object based on the BOT_LANGUAGE environment variable.
 * Defaults to 'en'.
 */
export function getLocale(): Locales {
  const lang = (process.env.BOT_LANGUAGE || 'en').toLowerCase();
  return lang === 'ru' ? ruLocale : enLocale;
}

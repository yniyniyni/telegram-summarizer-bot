import assert from 'node:assert/strict';
import { parseDeepDiveRequest, parseTimeframe, deepDiveEnabled, CachedSummary, summaryCache } from './main.js';
import * as loc from './locales.js';

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    testsPassed++;
  } catch (err) {
    testsFailed++;
    console.error(`FAIL: ${name}: `, err instanceof Error ? err.message : String(err));
  }
}

// --- Flag gating ---

test('deepDiveEnabled defaults to false', () => {
  delete process.env.DEEP_DIVE_ENABLED;
  assert.equal(deepDiveEnabled(), false);
});

test('deepDiveEnabled returns true when set', () => {
  process.env.DEEP_DIVE_ENABLED = 'true';
  assert.equal(deepDiveEnabled(), true);
  delete process.env.DEEP_DIVE_ENABLED;
});

// --- Detection: positive ---

test('detects question with "расскажи"', () => {
  const result = parseDeepDiveRequest(
    '@bot расскажи подробнее про миграцию',
    { sinceTs: 0, desc: '' }
  );
  assert.equal(result, 'расскажи подробнее про миграцию');
});

test('detects question with "?"', () => {
  const result = parseDeepDiveRequest(
    '@bot что обсуждали про деплой?',
    { sinceTs: 0, desc: '' }
  );
  assert.ok(result !== null);
  assert.ok(result!.includes('что обсуждали про деплой?'));
});

test('detects question with "how"', () => {
  const result = parseDeepDiveRequest(
    '@bot how did the migration go',
    { sinceTs: 0, desc: '' }
  );
  assert.equal(result, 'how did the migration go');
});

test('detects "deep dive" as trigger', () => {
  const result = parseDeepDiveRequest(
    '@bot deep dive into the database changes',
    { sinceTs: 0, desc: '' }
  );
  assert.equal(result, 'deep dive into the database changes');
});

// --- Detection: negative (fallback to summarization) ---

test('plain timeframe request returns null', () => {
  const result = parseDeepDiveRequest(
    '@bot суммаризуй за 3 часа',
    { sinceTs: 0, desc: 'последние 3 часа' }
  );
  assert.equal(result, null);
});

test('no interrogative markers returns null', () => {
  const result = parseDeepDiveRequest(
    '@bot миграция деплой база',
    { sinceTs: 0, desc: '' }
  );
  assert.equal(result, null);
});

// --- Question extraction: removes bot mention ---

test('removes @bot mention prefix', () => {
  const result = parseDeepDiveRequest(
    '@mybot расскажи про архитектуру',
    { sinceTs: 0, desc: '' }
  );
  assert.equal(result, 'расскажи про архитектуру');
});

// --- Short question rejection ---

test('question shorter than 3 chars returns null', () => {
  const result = parseDeepDiveRequest(
    '@bot чт',
    { sinceTs: 0, desc: '' }
  );
  assert.equal(result, null);
});

test('question of exactly 3 chars passes if has marker', () => {
  const result = parseDeepDiveRequest(
    '@bot как',
    { sinceTs: 0, desc: '' }
  );
  assert.ok(result !== null);
});

// --- All interrogative markers ---

const ENGLISH_MARKERS = ['how', 'what', 'why', 'who', 'when', 'where', 'tell', 'explain', 'describe', 'elaborate', 'detail', 'details'];
const RUSSIAN_MARKERS = ['как', 'что', 'почему', 'кто', 'когда', 'где', 'зачем', 'какой', 'какая', 'какие', 'расскажи', 'распиши', 'объясни', 'поясни', 'опиши', 'подробнее', 'углубись'];

for (const marker of ENGLISH_MARKERS) {
  test(`EN marker "${marker}" detected`, () => {
    const result = parseDeepDiveRequest(
      `@bot ${marker} something interesting`,
      { sinceTs: 0, desc: '' }
    );
    assert.ok(result !== null, `Expected "${marker}" to trigger deep-dive`);
  });
}

for (const marker of RUSSIAN_MARKERS) {
  test(`RU marker "${marker}" detected`, () => {
    const result = parseDeepDiveRequest(
      `@bot ${marker} что-то интересное`,
      { sinceTs: 0, desc: '' }
    );
    assert.ok(result !== null, `Expected "${marker}" to trigger deep-dive`);
  });
}

// --- Cache behavior ---

test('summaryCache: stores and retrieves CachedSummary', () => {
  summaryCache.clear();
  const entry: CachedSummary = {
    html: '<b>Test summary</b>',
    sinceTs: 1000000,
    untilTs: 2000000,
    messageCount: 42,
    createdAt: Date.now(),
  };
  summaryCache.set('-100123:0', entry);
  const retrieved = summaryCache.get('-100123:0');
  assert.ok(retrieved !== undefined);
  assert.equal(retrieved!.html, '<b>Test summary</b>');
  assert.equal(retrieved!.sinceTs, 1000000);
  assert.equal(retrieved!.messageCount, 42);
  summaryCache.clear();
});

test('summaryCache: thread isolation — different threads get different entries', () => {
  summaryCache.clear();
  const entry1: CachedSummary = { html: 'thread 1', sinceTs: 1, messageCount: 10, createdAt: 0 };
  const entry2: CachedSummary = { html: 'thread 2', sinceTs: 1, messageCount: 20, createdAt: 0 };
  summaryCache.set('-100123:42', entry1);
  summaryCache.set('-100123:99', entry2);
  assert.equal(summaryCache.get('-100123:42')!.html, 'thread 1');
  assert.equal(summaryCache.get('-100123:99')!.html, 'thread 2');
  assert.equal(summaryCache.get('-100123:0'), undefined);
  summaryCache.clear();
});

test('summaryCache: overwrite on new summary', () => {
  summaryCache.clear();
  const first: CachedSummary = { html: 'first', sinceTs: 1, messageCount: 5, createdAt: 0 };
  const second: CachedSummary = { html: 'second', sinceTs: 2, messageCount: 10, createdAt: 0 };
  summaryCache.set('-100123:0', first);
  summaryCache.set('-100123:0', second);
  assert.equal(summaryCache.get('-100123:0')!.html, 'second');
  summaryCache.clear();
});

// --- Deep-dive prompt contains expected elements ---

test('deepDivePrompt includes question, period, and transcript', () => {
  const locale = loc.getLocale();
  const prompt = locale.deepDivePrompt(
    'как прошла миграция?',
    'последние 3 часа',
    '[2026-01-01 12:00:00] User1: миграция началась',
    undefined
  );
  assert.ok(prompt.includes('как прошла миграция?'));
  assert.ok(prompt.includes('последние 3 часа'));
  assert.ok(prompt.includes('миграция началась'));
  assert.ok(prompt.includes('<untrusted_transcript>'));
  assert.ok(prompt.includes('</untrusted_transcript>'));
});

test('deepDivePrompt includes cached summary when provided', () => {
  const locale = loc.getLocale();
  const cachedHtml = '<b>Сводка:</b> обсуждали миграцию, решили перенести';
  const prompt = locale.deepDivePrompt(
    'расскажи подробнее',
    'последние сутки',
    '[2026-01-01 12:00:00] User1: переносим',
    cachedHtml
  );
  assert.ok(prompt.includes('расскажи подробнее'));
  assert.ok(prompt.includes('Previous summary'));
  assert.ok(prompt.includes('Сводка'));
});

test('deepDivePrompt without cached summary has no summary section', () => {
  const locale = loc.getLocale();
  const prompt = locale.deepDivePrompt(
    'what happened?',
    'the last week',
    '[2026-01-01 12:00:00] User1: something',
    undefined
  );
  assert.ok(!prompt.includes('Previous summary'));
  assert.ok(!prompt.includes('Предыдущая суммаризация'));
});

// --- Async: parseDeepDiveRequest + timeframe parsing integration ---

test('parseDeepDiveRequest extracts question from "3h + про миграцию"', () => {
  const tz = 'UTC';
  const now = 1700000000;
  const text = '@bot за 3 часа расскажи про миграцию';
  const timeframe = parseTimeframe(text, tz, now);
  assert.ok(timeframe.sinceTs !== undefined, 'timeframe should be parsed');
  const question = parseDeepDiveRequest(text, timeframe);
  assert.ok(question !== null);
  assert.ok(question!.includes('расскажи про миграцию'));
});

test('parseDeepDiveRequest with "сегодня" + question', () => {
  const tz = 'Europe/Moscow';
  const text = '@bot сегодня что обсуждали про деплой?';
  const timeframe = parseTimeframe(text, tz);
  assert.ok(timeframe.sinceTs !== undefined);
  const question = parseDeepDiveRequest(text, timeframe);
  assert.ok(question !== null);
  assert.ok(question!.includes('обсуждали про деплой'));
});

function runTests() {
  console.log('Starting deep-dive tests...\n');
  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) process.exit(1);
}

runTests();

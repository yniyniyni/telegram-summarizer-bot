import assert from 'assert';
import { parseTimeframe } from './main.js';

// Helper to compute local midnight in timezone
function computeLocalMidnight(timezoneName: string): number {
  const nowObj = new Date();
  const tzString = nowObj.toLocaleString('sv-SE', { timeZone: timezoneName });
  const [datePart] = tzString.split(' ');
  
  const localTime = new Date(nowObj.toLocaleString('en-US', { timeZone: timezoneName }));
  const utcTime = new Date(nowObj.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = localTime.getTime() - utcTime.getTime();
  
  const midnightUtc = new Date(`${datePart}T00:00:00Z`);
  return Math.floor((midnightUtc.getTime() - offsetMs) / 1000);
}

function runTestsForLanguage(lang: 'ru' | 'en'): void {
  console.log(`Running timeframe parser tests for language: ${lang}...`);
  process.env.BOT_LANGUAGE = lang;
  
  const now = Math.floor(Date.now() / 1000);
  const tz = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';

  // Test cases mapping raw text query to expected time delta and description
  const tests: [string, number, string][] = lang === 'ru' ? [
    ["суммаризуй за последние 3 часа", 3 * 3600, "последние 3 часа"],
    ["суммаризуй за 1 час", 3600, "последний 1 час"],
    ["суммаризуй за час", 3600, "последний час"],
    ["за 45 минут", 45 * 60, "последние 45 минут"],
    ["за 1 минуту", 60, "последнюю 1 минуту"],
    ["за 5 дней", 5 * 24 * 3600, "последние 5 дней"],
    ["за последние сутки", 24 * 3600, "последние сутки"],
    ["суммаризуй за неделю", 7 * 24 * 3600, "последнюю неделю"],
  ] : [
    ["summarize the last 3 hours", 3 * 3600, "the last 3 hours"],
    ["summarize the last 1 hour", 3600, "the last 1 hour"],
    ["summarize the last hour", 3600, "the last hour"],
    ["last 45 minutes", 45 * 60, "the last 45 minutes"],
    ["last 1 minute", 60, "the last 1 minute"],
    ["last 5 days", 5 * 24 * 3600, "the last 5 days"],
    ["for the last day", 24 * 3600, "the last day"],
    ["summarize for the last week", 7 * 24 * 3600, "the last week"],
  ];

  for (const [text, expectedDelta, expectedDesc] of tests) {
    const [ts, desc] = parseTimeframe(text, tz);
    const actualDelta = now - ts;
    // Assert within a 5-second tolerance since Date.now() ticks during execution
    assert.ok(Math.abs(actualDelta - expectedDelta) < 5, `Failed for '${text}' (${lang}): expected delta ${expectedDelta}, got ${actualDelta}`);
    assert.strictEqual(desc, expectedDesc, `Failed for '${text}' (${lang}): expected description '${expectedDesc}', got '${desc}'`);
    console.log(`  Passed (${lang}): '${text}' -> '${desc}' (delta: ${actualDelta}s)`);
  }

  // Test special keyword 'сегодня'/'today'
  console.log(`Testing special keyword 'сегодня'/'today' for (${lang})...`);
  const queryToday = lang === 'ru' ? "за сегодня" : "for today";
  const expectedTodayDesc = lang === 'ru' ? "сегодня" : "today";
  const [todayTs, todayDesc] = parseTimeframe(queryToday, tz);
  assert.strictEqual(todayDesc, expectedTodayDesc, `Expected description '${expectedTodayDesc}', got '${todayDesc}'`);
  const expectedTodayMidnight = computeLocalMidnight(tz);
  assert.strictEqual(todayTs, expectedTodayMidnight, `Expected midnight timestamp ${expectedTodayMidnight}, got ${todayTs}`);
  console.log(`  Passed (${lang}): '${queryToday}' -> ${todayDesc} at timestamp ${todayTs}`);

  // Test special keyword 'вчера'/'yesterday'
  console.log(`Testing special keyword 'вчера'/'yesterday' for (${lang})...`);
  const queryYesterday = lang === 'ru' ? "за вчера" : "for yesterday";
  const expectedYesterdayDesc = lang === 'ru' ? "вчера и сегодня" : "yesterday and today";
  const [yesterdayTs, yesterdayDesc] = parseTimeframe(queryYesterday, tz);
  assert.strictEqual(yesterdayDesc, expectedYesterdayDesc, `Expected description '${expectedYesterdayDesc}', got '${yesterdayDesc}'`);
  const expectedYesterdayMidnight = computeLocalMidnight(tz) - (24 * 3600);
  assert.strictEqual(yesterdayTs, expectedYesterdayMidnight, `Expected yesterday midnight timestamp ${expectedYesterdayMidnight}, got ${yesterdayTs}`);
  console.log(`  Passed (${lang}): '${queryYesterday}' -> ${yesterdayDesc} at timestamp ${yesterdayTs}`);

  // Test fallback default timeframe
  console.log(`Testing fallback/default timeframe for (${lang})...`);
  const queryFallback = "random text without parameters";
  const expectedFallbackDesc = lang === 'ru' ? "последние 24 часа" : "the last 24 hours";
  const [fallbackTs, fallbackDesc] = parseTimeframe(queryFallback, tz);
  assert.strictEqual(fallbackDesc, expectedFallbackDesc, `Expected default '${expectedFallbackDesc}', got '${fallbackDesc}'`);
  assert.ok(Math.abs((now - fallbackTs) - 24 * 3600) < 5, `Expected 24h delta, got ${now - fallbackTs}`);
  console.log(`  Passed (${lang}): fallback -> '${fallbackDesc}'`);
}

function runTests(): void {
  console.log("Starting timeframe parser tests...");
  // Save original language to restore after tests
  const originalLang = process.env.BOT_LANGUAGE;
  try {
    runTestsForLanguage('ru');
    runTestsForLanguage('en');
    console.log("✅ All parser verification tests passed successfully!");
  } finally {
    process.env.BOT_LANGUAGE = originalLang;
  }
}

runTests();

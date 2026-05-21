import assert from 'assert';
import { parseTimeframe, getMidnightTimestampForDate, validateTimezone } from './main.js';

// Helper to compute local midnight in timezone
function computeLocalMidnight(timezoneName: string): number {
  const nowObj = new Date();
  const tzString = nowObj.toLocaleString('sv-SE', { timeZone: timezoneName });
  const [datePart] = tzString.split(' ');
  
  return getMidnightTimestampForDate(datePart, timezoneName);
}

function runTestsForLanguage(lang: 'ru' | 'en'): void {
  console.log(`Running timeframe parser tests for language: ${lang}...`);
  process.env.BOT_LANGUAGE = lang;
  
  const now = Math.floor(Date.now() / 1000);
  const tz = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
  const defaultSeconds = 24 * 3600;
  const expectedFallbackDesc = lang === 'ru' ? "последние 24 часа" : "the last 24 hours";

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
    const { sinceTs, untilTs, desc } = parseTimeframe(text, tz);
    const actualDelta = now - sinceTs;
    // Assert within a 5-second tolerance since Date.now() ticks during execution
    assert.ok(Math.abs(actualDelta - expectedDelta) < 5, `Failed for '${text}' (${lang}): expected delta ${expectedDelta}, got ${actualDelta}`);
    assert.strictEqual(desc, expectedDesc, `Failed for '${text}' (${lang}): expected description '${expectedDesc}', got '${desc}'`);
    assert.strictEqual(untilTs, undefined, `Expected untilTs to be undefined for '${text}'`);
    console.log(`  Passed (${lang}): '${text}' -> '${desc}' (delta: ${actualDelta}s)`);
  }

  // Test special keyword 'сегодня'/'today'
  console.log(`Testing special keyword 'сегодня'/'today' for (${lang})...`);
  const queryToday = lang === 'ru' ? "за сегодня" : "for today";
  const expectedTodayDesc = lang === 'ru' ? "сегодня" : "today";
  const { sinceTs: todayTs, untilTs: todayUntilTs, desc: todayDesc } = parseTimeframe(queryToday, tz);
  assert.strictEqual(todayDesc, expectedTodayDesc, `Expected description '${expectedTodayDesc}', got '${todayDesc}'`);
  const expectedTodayMidnight = computeLocalMidnight(tz);
  assert.strictEqual(todayTs, expectedTodayMidnight, `Expected midnight timestamp ${expectedTodayMidnight}, got ${todayTs}`);
  assert.strictEqual(todayUntilTs, undefined, `Expected today untilTs to be undefined, got ${todayUntilTs}`);
  console.log(`  Passed (${lang}): '${queryToday}' -> ${todayDesc} at timestamp ${todayTs}`);

  // Test special keyword 'вчера'/'yesterday'
  console.log(`Testing special keyword 'вчера'/'yesterday' for (${lang})...`);
  const queryYesterday = lang === 'ru' ? "за вчера" : "for yesterday";
  const expectedYesterdayDesc = lang === 'ru' ? "вчера" : "yesterday";
  const { sinceTs: yesterdayTs, untilTs: yesterdayUntilTs, desc: yesterdayDesc } = parseTimeframe(queryYesterday, tz);
  assert.strictEqual(yesterdayDesc, expectedYesterdayDesc, `Expected description '${expectedYesterdayDesc}', got '${yesterdayDesc}'`);
  const expectedYesterdayMidnight = computeLocalMidnight(tz) - (24 * 3600);
  assert.strictEqual(yesterdayTs, expectedYesterdayMidnight, `Expected yesterday midnight timestamp ${expectedYesterdayMidnight}, got ${yesterdayTs}`);
  const expectedTodayMidnightTs = computeLocalMidnight(tz);
  assert.strictEqual(yesterdayUntilTs, expectedTodayMidnightTs, `Expected yesterday untilTs to be today's midnight ${expectedTodayMidnightTs}, got ${yesterdayUntilTs}`);
  console.log(`  Passed (${lang}): '${queryYesterday}' -> ${yesterdayDesc} at timestamp ${yesterdayTs} until ${yesterdayUntilTs}`);

  // Test fallback default timeframe
  console.log(`Testing fallback/default timeframe for (${lang})...`);
  const queryFallback = "random text without parameters";
  const { sinceTs: fallbackTs, untilTs: fallbackUntilTs, desc: fallbackDesc } = parseTimeframe(queryFallback, tz);
  assert.strictEqual(fallbackDesc, expectedFallbackDesc, `Expected default '${expectedFallbackDesc}', got '${fallbackDesc}'`);
  assert.ok(Math.abs((now - fallbackTs) - 24 * 3600) < 5, `Expected 24h delta, got ${now - fallbackTs}`);
  assert.strictEqual(fallbackUntilTs, undefined, `Expected fallback untilTs to be undefined`);
  console.log(`  Passed (${lang}): fallback -> '${fallbackDesc}'`);

  // Test negative cases (false positives)
  console.log(`Testing timeframe parser false positives for (${lang})...`);
  const negativeTests = lang === 'ru' ? [
    "что обсуждали сейчас",
    "обсуждение админа",
    "суммаризуй повестку",
    "обсуждение в понедельник"
  ] : [
    "summarize minor topics",
    "summarize admin discussion",
    "summarize monday planning"
  ];
  for (const negText of negativeTests) {
    const { sinceTs, untilTs, desc } = parseTimeframe(negText, tz);
    assert.strictEqual(desc, expectedFallbackDesc, `Expected fallback description for '${negText}', got '${desc}'`);
    assert.strictEqual(untilTs, undefined, `Expected untilTs to be undefined for '${negText}'`);
    assert.ok(Math.abs((now - sinceTs) - defaultSeconds) < 5, `Expected default timeframe for '${negText}'`);
  }
  console.log(`  Passed false positives tests for (${lang})`);
}

function runTests(): void {
  console.log("Starting timeframe parser tests...");
  
  // America/New_York DST boundary test
  console.log("Testing America/New_York DST boundary on 2024-03-10...");
  const midnightTs = getMidnightTimestampForDate("2024-03-10", "America/New_York");
  assert.strictEqual(midnightTs, 1710046800, `Expected 1710046800, got ${midnightTs}`);
  console.log("  Passed DST boundary test.");

  // America/New_York DST boundary test for yesterday on 2024-03-11
  console.log("Testing America/New_York DST boundary for yesterday on 2024-03-11...");
  const nowOverride = 1710129600 + 12 * 3600; // 1710172800 (midday of 2024-03-11 in NY)
  const result = parseTimeframe("yesterday", "America/New_York", nowOverride);
  assert.strictEqual(result.sinceTs, 1710046800, `Expected sinceTs to be 1710046800 (2024-03-10T05:00:00Z), got ${result.sinceTs}`);
  assert.strictEqual(result.untilTs, 1710129600, `Expected untilTs to be 1710129600 (2024-03-11T04:00:00Z), got ${result.untilTs}`);
  console.log("  Passed yesterday DST boundary test.");

  // Test timezone validation and invalid timezone behavior in parseTimeframe
  console.log("Testing timezone validation and invalid timezone error throwing...");
  assert.strictEqual(validateTimezone('America/New_York'), true, "Expected 'America/New_York' to be valid");
  assert.strictEqual(validateTimezone('Bad/Zone'), false, "Expected 'Bad/Zone' to be invalid");

  assert.throws(() => {
    parseTimeframe('today', 'Bad/Zone');
  }, RangeError, "Expected RangeError when calling parseTimeframe with an invalid timezone");
  console.log("  Passed timezone validation tests.");

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

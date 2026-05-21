import assert from 'assert';
import { parseTimeframe } from './main.js';

function runTests(): void {
  console.log("Starting timeframe parser tests...");
  const now = Math.floor(Date.now() / 1000);
  const tz = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';

  // Test cases mapping raw text query to expected time delta and description
  const tests: [string, number, string][] = [
    ["суммаризуй за последние 3 часа", 3 * 3600, "последние 3 часа"],
    ["суммаризуй за 1 час", 3600, "последний 1 час"],
    ["суммаризуй за час", 3600, "последний час"],
    ["за 45 минут", 45 * 60, "последние 45 минут"],
    ["за 1 минуту", 60, "последнюю 1 минуту"],
    ["за 5 дней", 5 * 24 * 3600, "последние 5 дней"],
    ["за последние сутки", 24 * 3600, "последние сутки"],
    ["суммаризуй за неделю", 7 * 24 * 3600, "последнюю неделю"],
  ];

  for (const [text, expectedDelta, expectedDesc] of tests) {
    const [ts, desc] = parseTimeframe(text, tz);
    const actualDelta = now - ts;
    // Assert within a 5-second tolerance since Date.now() ticks during execution
    assert.ok(Math.abs(actualDelta - expectedDelta) < 5, `Failed for '${text}': expected delta ${expectedDelta}, got ${actualDelta}`);
    assert.strictEqual(desc, expectedDesc, `Failed for '${text}': expected description '${expectedDesc}', got '${desc}'`);
    console.log(`  Passed: '${text}' -> '${desc}' (delta: ${actualDelta}s)`);
  }

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

  // Test 'сегодня' (today) separately because it evaluates relative to local calendar day
  console.log("Testing special keyword 'сегодня'...");
  const [todayTs, todayDesc] = parseTimeframe("за сегодня", tz);
  assert.strictEqual(todayDesc, "сегодня", `Expected description 'сегодня', got '${todayDesc}'`);
  const expectedTodayMidnight = computeLocalMidnight(tz);
  assert.strictEqual(todayTs, expectedTodayMidnight, `Expected midnight timestamp ${expectedTodayMidnight}, got ${todayTs}`);
  console.log(`  Passed: 'сегодня' -> ${todayDesc} at timestamp ${todayTs}`);

  // Test 'вчера' (yesterday)
  console.log("Testing special keyword 'вчера'...");
  const [yesterdayTs, yesterdayDesc] = parseTimeframe("за вчера", tz);
  assert.strictEqual(yesterdayDesc, "вчера и сегодня", `Expected description 'вчера и сегодня', got '${yesterdayDesc}'`);
  const expectedYesterdayMidnight = computeLocalMidnight(tz) - (24 * 3600);
  assert.strictEqual(yesterdayTs, expectedYesterdayMidnight, `Expected yesterday midnight timestamp ${expectedYesterdayMidnight}, got ${yesterdayTs}`);
  console.log(`  Passed: 'вчера' -> ${yesterdayDesc} at timestamp ${yesterdayTs}`);

  // Test fallback default timeframe
  console.log("Testing fallback/default timeframe...");
  const [fallbackTs, fallbackDesc] = parseTimeframe("просто тег без параметров", tz);
  assert.strictEqual(fallbackDesc, "последние 24 часа", `Expected default 'последние 24 часа', got '${fallbackDesc}'`);
  assert.ok(Math.abs((now - fallbackTs) - 24 * 3600) < 5, `Expected 24h delta, got ${now - fallbackTs}`);
  console.log(`  Passed: fallback -> '${fallbackDesc}'`);

  console.log("✅ All parser verification tests passed successfully!");
}

runTests();

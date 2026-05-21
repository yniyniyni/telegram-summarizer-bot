import assert from 'assert';
import { buildBoundedTranscript, MAX_TRANSCRIPT_CHARS } from './summarizer.js';
import { SavedMessage } from './db.js';
import { getLocale, COMMON_RULES } from './locales.js';

function makeMessage(messageId: number, text: string): SavedMessage {
  return {
    chat_id: 1,
    message_id: messageId,
    user_id: messageId,
    username: `user${messageId}`,
    first_name: `User${messageId}`,
    last_name: null,
    text,
    timestamp: 1_700_000_000 + messageId,
    thread_id: null
  };
}

function runTests(): void {
  console.log("Starting summarizer tests...");

  const originalLang = process.env.BOT_LANGUAGE;
  try {
    process.env.BOT_LANGUAGE = 'en';

    console.log("Testing bounded transcript keeps latest messages under budget...");
    const manyMessages = Array.from({ length: 5000 }, (_, index) =>
      makeMessage(index + 1, `message-index-${index + 1} ${'x'.repeat(300)}`)
    );
    const bounded = buildBoundedTranscript(manyMessages, 'UTC', 10_000);

    assert.ok(bounded.transcript.length <= 10_000, `Transcript exceeded budget: ${bounded.transcript.length}`);
    assert.ok(bounded.skippedTextMessageCount > 0, "Expected older messages to be skipped");
    assert.ok(bounded.includedTextMessageCount > 0, "Expected latest messages to be included");
    assert.ok(
      bounded.transcript.includes(`[Skipped ${bounded.skippedTextMessageCount} older text messages due to the prompt size limit.]`),
      "Expected explicit skipped-message marker"
    );
    assert.ok(!bounded.transcript.includes('message-index-1 '), "Oldest message should be omitted");
    assert.ok(bounded.transcript.includes('message-index-5000 '), "Latest message should be preserved");
    assert.ok(
      bounded.transcript.indexOf('message-index-4999 ') < bounded.transcript.indexOf('message-index-5000 '),
      "Included messages should remain chronological"
    );

    console.log("Testing one oversized latest message is truncated under budget...");
    const oversized = buildBoundedTranscript(
      [makeMessage(1, 'small old message'), makeMessage(2, 'latest ' + 'y'.repeat(MAX_TRANSCRIPT_CHARS))],
      'UTC',
      400
    );

    assert.ok(oversized.transcript.length <= 400, `Oversized transcript exceeded budget: ${oversized.transcript.length}`);
    assert.ok(oversized.transcript.includes('[Skipped 1 older text messages due to the prompt size limit.]'));
    assert.ok(oversized.transcript.includes('latest '));
    assert.ok(oversized.transcript.includes('[truncated to fit prompt size limit]'));

    console.log("Testing Russian skipped-message marker...");
    process.env.BOT_LANGUAGE = 'ru';
    const ruBounded = buildBoundedTranscript(manyMessages, 'UTC', 10_000);
    assert.ok(
      ruBounded.transcript.includes(`[Пропущено ${ruBounded.skippedTextMessageCount} более старых текстовых сообщений из-за ограничения размера запроса.]`),
      "Expected Russian skipped-message marker"
    );

    console.log("Testing prompt templates contain mandatory safety rules...");
    // Test English prompt safety rules
    process.env.BOT_LANGUAGE = 'en';
    const enPrompt = getLocale().userPromptTemplate('24 hours', 5, 'test transcript');
    assert.ok(enPrompt.includes(COMMON_RULES.en.html), "English prompt template must contain COMMON_RULES.en.html");
    assert.ok(enPrompt.includes(COMMON_RULES.en.noHallucinations), "English prompt template must contain COMMON_RULES.en.noHallucinations");
    assert.ok(enPrompt.includes(COMMON_RULES.en.untrustedTranscript), "English prompt template must contain COMMON_RULES.en.untrustedTranscript");
    assert.ok(enPrompt.includes('<untrusted_transcript>\ntest transcript\n</untrusted_transcript>'), "English template must wrap transcript in untrusted_transcript tag");
    assert.ok(enPrompt.includes("Do not repeat the text of the messages word for word. Do not include long verbatim quotes from the transcript."), "English template must contain quote limitation warnings");

    // Test Russian prompt safety rules
    process.env.BOT_LANGUAGE = 'ru';
    const ruPrompt = getLocale().userPromptTemplate('24 часа', 5, 'тестовая переписка');
    assert.ok(ruPrompt.includes(COMMON_RULES.ru.html), "Russian prompt template must contain COMMON_RULES.ru.html");
    assert.ok(ruPrompt.includes(COMMON_RULES.ru.noHallucinations), "Russian prompt template must contain COMMON_RULES.ru.noHallucinations");
    assert.ok(ruPrompt.includes(ruPrompt.includes(COMMON_RULES.ru.untrustedTranscript) ? COMMON_RULES.ru.untrustedTranscript : ""), "Russian prompt template must contain COMMON_RULES.ru.untrustedTranscript");
    assert.ok(ruPrompt.includes('<untrusted_transcript>\nтестовая переписка\n</untrusted_transcript>'), "Russian template must wrap transcript in untrusted_transcript tag");
    assert.ok(ruPrompt.includes("Не повторяй текст сообщений дословно. Не включай длинные цитаты из истории сообщений."), "Russian template must contain quote limitation warnings");
    console.log("Testing PII Minimization Mode...");
    process.env.REDACT_USER_IDENTITIES = 'true';

    const piiMessages = [
      {
        chat_id: 1,
        message_id: 101,
        user_id: 42,
        username: 'ivan_coder',
        first_name: 'Иван',
        last_name: 'Иванов',
        text: 'Привет от Иван Иванов, напиши ivan_coder или @ivan_coder. И еще напиши @another_user.',
        timestamp: 1700000000,
        thread_id: null
      },
      {
        chat_id: 1,
        message_id: 102,
        user_id: 43,
        username: 'alice_smith',
        first_name: 'Alice',
        last_name: 'Smith',
        text: 'Hello, this is Alice Smith speaking to @ivan_coder and ivan_coder.',
        timestamp: 1700000001,
        thread_id: null
      }
    ];

    const result = buildBoundedTranscript(piiMessages, 'UTC', 10_000);
    const lines = result.transcript.split('\n');

    assert.ok(lines[0].includes('User 1:'), `Expected line 1 to have 'User 1:', got: ${lines[0]}`);
    assert.ok(!lines[0].includes('Иван'), `Expected line 1 header/text not to have 'Иван'`);
    assert.ok(!lines[0].includes('Иванов'), `Expected line 1 header/text not to have 'Иванов'`);
    assert.ok(!lines[0].includes('ivan_coder'), `Expected line 1 header/text not to have 'ivan_coder'`);
    assert.ok(lines[0].includes('Привет от User 1, напиши User 1 или User 1. И еще напиши @user_redacted.'), `Line 1 text replacement incorrect. Got: ${lines[0]}`);

    assert.ok(lines[1].includes('User 2:'), `Expected line 2 to have 'User 2:', got: ${lines[1]}`);
    assert.ok(!lines[1].includes('Alice'), `Expected line 2 header/text not to have 'Alice'`);
    assert.ok(!lines[1].includes('Smith'), `Expected line 2 header/text not to have 'Smith'`);
    assert.ok(!lines[1].includes('alice_smith'), `Expected line 2 header/text not to have 'alice_smith'`);
    assert.ok(lines[1].includes('Hello, this is User 2 speaking to User 1 and User 1.'), `Line 2 text replacement incorrect. Got: ${lines[1]}`);

    console.log("Testing PII Redaction Robustness...");
    const robustnessMessages = [
      {
        chat_id: 1,
        message_id: 201,
        user_id: 50,
        username: 'ivan_coder',
        first_name: 'Li',
        last_name: 'Lu',
        text: 'Hello Li Lu. Welcome to the Library. Contact @ivan_coder for help. Also check @ivan_coder_backup.',
        timestamp: 1700000000,
        thread_id: null
      },
      {
        chat_id: 1,
        message_id: 202,
        user_id: 51,
        username: null,
        first_name: 'Иван',
        last_name: 'Иванов',
        text: 'Привет от Иван Иванов!',
        timestamp: 1700000001,
        thread_id: null
      },
      {
        chat_id: 1,
        message_id: 203,
        user_id: 52,
        username: null,
        first_name: 'Bo',
        last_name: null,
        text: 'My name is Bo, I study in Boston.',
        timestamp: 1700000002,
        thread_id: null
      }
    ];

    const robResult = buildBoundedTranscript(robustnessMessages, 'UTC', 10_000);
    const robLines = robResult.transcript.split('\n');

    // 1. Verify that if a user has username ivan_coder, the text @ivan_coder_backup is NOT redacted to User 1_backup.
    assert.ok(!robLines[0].includes('User 1_backup'), `Expected line to not contain 'User 1_backup', got: ${robLines[0]}`);
    assert.ok(!robLines[0].includes('@User 1_backup'), `Expected line to not contain '@User 1_backup', got: ${robLines[0]}`);
    // It should be redacted to @user_redacted by the general username pattern
    assert.ok(robLines[0].includes('@user_redacted'), `Expected @ivan_coder_backup to fall back to @user_redacted, got: ${robLines[0]}`);

    // 2. Verify that if a user has first name Li, the word Library in the text is NOT redacted (the Li inside Library is not replaced).
    assert.ok(robLines[0].includes('Library'), `Expected 'Library' to remain untouched, got: ${robLines[0]}`);
    // "Li Lu" should be redacted to "User 1" because combined name length is 5 (> 2)
    assert.ok(robLines[0].includes('Hello User 1.'), `Expected 'Li Lu' to be redacted to 'User 1', got: ${robLines[0]}`);

    // 3. Verify that if a user has first name Bo (length <= 2) and no last name, "Bo" is NOT redacted because it is <= 2.
    assert.ok(robLines[2].includes('My name is Bo, I study in Boston.'), `Expected 'Bo' and 'Boston' to remain untouched, got: ${robLines[2]}`);

    // 4. Verify that a Cyrillic full name (e.g., Иван Иванов) is still correctly redacted.
    assert.ok(!robLines[1].includes('Иван'), `Expected line to not contain 'Иван', got: ${robLines[1]}`);
    assert.ok(!robLines[1].includes('Иванов'), `Expected line to not contain 'Иванов', got: ${robLines[1]}`);
    assert.ok(robLines[1].includes('Привет от User 2!'), `Expected Cyrillic full name to be redacted to 'User 2', got: ${robLines[1]}`);

    process.env.REDACT_USER_IDENTITIES = 'false';

    console.log("✅ All summarizer tests passed successfully!");
  } finally {
    process.env.BOT_LANGUAGE = originalLang;
  }
}

runTests();

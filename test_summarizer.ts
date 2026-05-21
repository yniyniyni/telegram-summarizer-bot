import assert from 'assert';
import { buildBoundedTranscript, MAX_TRANSCRIPT_CHARS } from './summarizer.js';
import { SavedMessage } from './db.js';

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

    console.log("✅ All summarizer tests passed successfully!");
  } finally {
    process.env.BOT_LANGUAGE = originalLang;
  }
}

runTests();

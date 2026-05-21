import fs from 'fs';
import assert from 'assert';
import { Context } from 'telegraf';
import * as db from './db.js';
import { logMessage } from './main.js';

function makeTextContext(chatId: number, messageId: number, text: string): Context {
  return {
    message: {
      chat: { id: chatId, type: 'group', title: 'Test chat' },
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      text,
      from: {
        id: 42,
        is_bot: false,
        first_name: 'Test',
        username: 'testuser'
      }
    },
    botInfo: {
      id: 100,
      is_bot: true,
      first_name: 'Summary Bot',
      username: 'summary_bot'
    }
  } as unknown as Context;
}

async function runTests(): Promise<void> {
  console.log("Starting main handler tests...");
  const testDbPath = "data/test_main_messages.db";
  const originalAllowedChats = process.env.ALLOWED_CHATS;

  db.setDbPath(testDbPath);
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  try {
    await db.initDb();

    console.log("Testing unauthorized chats are not persisted...");
    process.env.ALLOWED_CHATS = "123";
    await logMessage(makeTextContext(999, 1, "this must not be saved"));
    let messages = await db.getMessages(999, 1_699_999_990);
    assert.strictEqual(messages.length, 0, "Unauthorized chat message should not be stored");

    console.log("Testing authorized chats are persisted...");
    await logMessage(makeTextContext(123, 2, "authorized message"));
    messages = await db.getMessages(123, 1_699_999_990);
    assert.strictEqual(messages.length, 1, "Authorized chat message should be stored");
    assert.strictEqual(messages[0].text, "authorized message");

    console.log("✅ Main handler tests passed successfully!");
  } finally {
    if (originalAllowedChats === undefined) {
      delete process.env.ALLOWED_CHATS;
    } else {
      process.env.ALLOWED_CHATS = originalAllowedChats;
    }
    await db.closeDb();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  }
}

runTests().catch(err => {
  console.error("❌ Main handler test runner failed with error:", err);
  process.exit(1);
});

import fs from 'fs';
import assert from 'assert';
import { Context } from 'telegraf';
import * as db from './db.js';
import { logMessage, isBotMentioned, checkFailClosedMode } from './main.js';

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
  const originalAllowAll = process.env.ALLOW_ALL_CHATS;

  db.setDbPath(testDbPath);
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  try {
    await db.initDb();

    console.log("Testing unauthorized chats are not persisted...");
    delete process.env.ALLOW_ALL_CHATS;
    process.env.ALLOWED_CHATS = "123";
    await logMessage(makeTextContext(999, 1, "this must not be saved"));
    let messages = await db.getMessages(999, 1_699_999_990);
    assert.strictEqual(messages.length, 0, "Unauthorized chat message should not be stored");

    console.log("Testing authorized chats are persisted...");
    await logMessage(makeTextContext(123, 2, "authorized message"));
    messages = await db.getMessages(123, 1_699_999_990);
    assert.strictEqual(messages.length, 1, "Authorized chat message should be stored");
    assert.strictEqual(messages[0].text, "authorized message");

    console.log("Testing ALLOW_ALL_CHATS=true permits persistence...");
    const originalAllowAll = process.env.ALLOW_ALL_CHATS;
    try {
      process.env.ALLOW_ALL_CHATS = "true";
      delete process.env.ALLOWED_CHATS;
      await logMessage(makeTextContext(888, 3, "allowed because of allow_all_chats"));
      messages = await db.getMessages(888, 1_699_999_990);
      assert.strictEqual(messages.length, 1, "Should be stored when ALLOW_ALL_CHATS=true");
      assert.strictEqual(messages[0].text, "allowed because of allow_all_chats");
    } finally {
      if (originalAllowAll === undefined) {
        delete process.env.ALLOW_ALL_CHATS;
      } else {
        process.env.ALLOW_ALL_CHATS = originalAllowAll;
      }
    }

    console.log("Testing isBotMentioned exact match and boundary-aware regex...");
    const botUser = "summary_bot";

    // 1. With entities present
    const msgWithEntity = {
      text: "hello @summary_bot how are you",
      entities: [
        { type: "mention", offset: 6, length: 12 }
      ]
    };
    assert.strictEqual(isBotMentioned(msgWithEntity, botUser), true);

    const msgWithWrongEntity = {
      text: "hello @summary_bot_backup how are you",
      entities: [
        { type: "mention", offset: 6, length: 19 }
      ]
    };
    assert.strictEqual(isBotMentioned(msgWithWrongEntity, botUser), false);

    const msgWithMultipleEntities = {
      text: "hi @summary_bot_backup and @summary_bot",
      entities: [
        { type: "mention", offset: 3, length: 19 },
        { type: "mention", offset: 27, length: 12 }
      ]
    };
    assert.strictEqual(isBotMentioned(msgWithMultipleEntities, botUser), true);

    // 2. Without entities (should fall back to boundary-aware regex)
    const msgNoEntitiesExact = { text: "hello @summary_bot how are you" };
    assert.strictEqual(isBotMentioned(msgNoEntitiesExact, botUser), true);

    const msgNoEntitiesWrong = { text: "hello @summary_bot_backup how are you" };
    assert.strictEqual(isBotMentioned(msgNoEntitiesWrong, botUser), false);

    const msgNoEntitiesPunctuation = { text: "hello @summary_bot!" };
    assert.strictEqual(isBotMentioned(msgNoEntitiesPunctuation, botUser), true);

    const msgNoEntitiesDigits = { text: "hello @summary_bot123" };
    assert.strictEqual(isBotMentioned(msgNoEntitiesDigits, botUser), false);

    const msgNoEntitiesExactCase = { text: "hello @SuMmArY_bOt" };
    assert.strictEqual(isBotMentioned(msgNoEntitiesExactCase, botUser), true);

    console.log("Testing checkFailClosedMode warnings...");
    const loggedLines: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => {
      loggedLines.push(args.join(' '));
    };

    try {
      // 1. Unset both ALLOWED_CHATS and ALLOW_ALL_CHATS
      delete process.env.ALLOWED_CHATS;
      delete process.env.ALLOW_ALL_CHATS;
      checkFailClosedMode();
      assert.ok(
        loggedLines.some(line => line.includes("[WARN]") && line.includes("WARNING: Bot is running in fail-closed mode. No chats are authorized. Please configure ALLOWED_CHATS or ALLOW_ALL_CHATS=true.")),
        "Should log warning when in fail-closed mode"
      );

      // Reset logs array
      loggedLines.length = 0;

      // 2. Set ALLOWED_CHATS, should NOT log warning
      process.env.ALLOWED_CHATS = "12345";
      checkFailClosedMode();
      assert.strictEqual(
        loggedLines.some(line => line.includes("WARNING: Bot is running in fail-closed mode")),
        false,
        "Should not log warning when ALLOWED_CHATS is configured"
      );

      // Reset logs array
      loggedLines.length = 0;

      // 3. Set ALLOW_ALL_CHATS=true, should NOT log warning
      delete process.env.ALLOWED_CHATS;
      process.env.ALLOW_ALL_CHATS = "true";
      checkFailClosedMode();
      assert.strictEqual(
        loggedLines.some(line => line.includes("WARNING: Bot is running in fail-closed mode")),
        false,
        "Should not log warning when ALLOW_ALL_CHATS is true"
      );
    } finally {
      console.log = originalConsoleLog;
    }

    console.log("✅ Main handler tests passed successfully!");
  } finally {
    if (originalAllowedChats === undefined) {
      delete process.env.ALLOWED_CHATS;
    } else {
      process.env.ALLOWED_CHATS = originalAllowedChats;
    }
    if (originalAllowAll === undefined) {
      delete process.env.ALLOW_ALL_CHATS;
    } else {
      process.env.ALLOW_ALL_CHATS = originalAllowAll;
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

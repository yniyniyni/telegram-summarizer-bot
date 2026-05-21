import fs from 'fs';
import assert from 'assert';
import * as db from './db.js';

async function runTests(): Promise<void> {
  console.log("Starting database tests...");
  const testDbPath = "data/test_bot_messages.db";

  // Configure db to use the test file path
  db.setDbPath(testDbPath);

  // Clean up any residual test database files
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  try {
    // 1. Test database initialization
    console.log("Testing DB initialization...");
    await db.initDb();
    assert.ok(fs.existsSync(testDbPath), "Test DB file should exist after initialization");

    if (process.platform !== 'win32') {
      console.log("Testing database file permissions...");
      const actualMode = fs.statSync(testDbPath).mode & 0o777;
      assert.strictEqual(
        actualMode,
        0o600,
        `Expected database file permissions to be 0o600, but got ${actualMode.toString(8)}`
      );
    }

    // 1b. Test concurrent DB initialization
    console.log("Testing concurrent DB initialization...");
    await db.closeDb();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    await Promise.all([
      db.initDb(),
      db.initDb(),
      db.initDb()
    ]);
    assert.ok(fs.existsSync(testDbPath), "Test DB file should exist after concurrent initialization");


    // 2. Test saving a message
    console.log("Testing saveMessage...");
    const now = Math.floor(Date.now() / 1000);
    await db.saveMessage({
      chat_id: 123,
      message_id: 456,
      user_id: 789,
      username: "testuser",
      first_name: "Test",
      last_name: "User",
      text: "Hello world!",
      timestamp: now,
      thread_id: null
    });

    // 3. Test retrieving messages
    console.log("Testing getMessages...");
    let messages = await db.getMessages(123, now - 10);
    assert.strictEqual(messages.length, 1, "Should retrieve exactly 1 message");
    assert.strictEqual(messages[0].text, "Hello world!", "Message text mismatch");
    assert.strictEqual(messages[0].first_name, "Test", "Sender first name mismatch");
    assert.strictEqual(messages[0].username, "testuser", "Username mismatch");

    // 3b. Test getMessages with untilTimestamp (bounded range)
    console.log("Testing getMessages with untilTimestamp...");
    await db.saveMessage({
      chat_id: 9999,
      message_id: 1,
      user_id: 789,
      username: "testuser",
      first_name: "Test",
      last_name: "User",
      text: "Past message",
      timestamp: now,
      thread_id: null
    });
    await db.saveMessage({
      chat_id: 9999,
      message_id: 2,
      user_id: 789,
      username: "testuser",
      first_name: "Test",
      last_name: "User",
      text: "Future message",
      timestamp: now + 5,
      thread_id: null
    });
    let boundedMessages = await db.getMessages(9999, now - 10, null, 5000, now + 2);
    assert.strictEqual(boundedMessages.length, 1, "Should retrieve only 1 message before untilTimestamp");
    assert.strictEqual(boundedMessages[0].text, "Past message", "Should retrieve correct message");

    // 4. Test message update (Telegram message edit)
    console.log("Testing message update (upsert)...");
    await db.saveMessage({
      chat_id: 123,
      message_id: 456,
      user_id: 789,
      username: "testuser",
      first_name: "Test",
      last_name: "User",
      text: "Hello world! (edited)",
      timestamp: now,
      thread_id: null
    });
    messages = await db.getMessages(123, now - 10);
    assert.strictEqual(messages.length, 1, "Should still retrieve exactly 1 message (updates in place)");
    assert.strictEqual(messages[0].text, "Hello world! (edited)", "Message text was not updated correctly");

    // 4b. Test thread ID isolation
    console.log("Testing thread ID isolation...");
    await db.saveMessage({
      chat_id: 123,
      message_id: 999,
      user_id: 789,
      username: "testuser",
      first_name: "Test",
      last_name: "User",
      text: "Hello in thread 42!",
      timestamp: now,
      thread_id: 42
    });
    
    // Retrieve without thread ID / null (should return only thread_id: null message, which is "Hello world! (edited)")
    let generalMessages = await db.getMessages(123, now - 10, null);
    assert.strictEqual(generalMessages.length, 1, "Should retrieve only 1 message for general/null thread");
    assert.strictEqual(generalMessages[0].text, "Hello world! (edited)", "Should be the edited general message");

    // Retrieve with thread ID 42 (should return only the thread 42 message)
    let threadMessages = await db.getMessages(123, now - 10, 42);
    assert.strictEqual(threadMessages.length, 1, "Should retrieve only 1 message for thread 42");
    assert.strictEqual(threadMessages[0].text, "Hello in thread 42!", "Should be the thread message");

    // 5. Test purging old messages
    console.log("Testing cleanupOldMessages...");
    const oldTime = now - (40 * 24 * 3600); // 40 days ago
    await db.saveMessage({
      chat_id: 123,
      message_id: 111,
      user_id: 789,
      username: "testuser",
      first_name: "Test",
      last_name: "User",
      text: "Very old message",
      timestamp: oldTime,
      thread_id: null
    });

    // Verify both messages are in the db
    messages = await db.getMessages(123, oldTime - 10);
    assert.strictEqual(messages.length, 2, "Database should have 2 messages before purge");

    // Purge messages older than 30 days
    const deleted = await db.cleanupOldMessages(30);
    assert.strictEqual(deleted, 1, `Expected 1 deleted message, got ${deleted}`);

    // Check that the old message is gone and the new one remains
    messages = await db.getMessages(123, oldTime - 10);
    assert.strictEqual(messages.length, 1, "Only 1 message should remain after purge");
    assert.strictEqual(messages[0].text, "Hello world! (edited)", "Wrong message was purged");

    // 6. Test latest limit messages returning latest messages in chronological order (ascending)
    console.log("Testing latest messages limit (6000 messages)...");
    const limitChatId = 777;
    const limitTimestampBase = now - 20000;
    
    await db.beginTransaction();
    try {
      for (let i = 1; i <= 6000; i++) {
        await db.saveMessage({
          chat_id: limitChatId,
          message_id: i,
          user_id: 111,
          username: `user_${i}`,
          first_name: "Test",
          last_name: "User",
          text: `Message ${i}`,
          timestamp: limitTimestampBase + i,
          thread_id: null
        });
      }
      await db.commitTransaction();
    } catch (err) {
      await db.rollbackTransaction();
      throw err;
    }

    const latestMessages = await db.getMessages(limitChatId, limitTimestampBase - 10, null);
    assert.strictEqual(latestMessages.length, 5000, "Should return exactly 5000 messages (default limit)");
    
    // Check that message_id=6000 is included (it should be the last message)
    assert.ok(latestMessages.some(m => m.message_id === 6000), "Should contain message_id=6000");
    // Check that message_id=1 is NOT included
    assert.ok(!latestMessages.some(m => m.message_id === 1), "Should not contain message_id=1");

    // Let's assert chronological order
    assert.strictEqual(latestMessages[0].message_id, 1001, "First returned message should be message_id=1001");
    assert.strictEqual(latestMessages[4999].message_id, 6000, "Last returned message should be message_id=6000");

    // Double check chronological order for adjacent messages
    for (let i = 0; i < latestMessages.length - 1; i++) {
      assert.ok(latestMessages[i].timestamp < latestMessages[i + 1].timestamp, `Timestamp at index ${i} should be less than next`);
      assert.strictEqual(latestMessages[i].message_id + 1, latestMessages[i + 1].message_id, `Message ID sequence broken at index ${i}`);
    }

    console.log("✅ Database verification tests passed successfully!");
  } finally {
    // Teardown: Close connection and unlink the test database file
    await db.closeDb();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
      console.log("Test database cleaned up.");
    }
  }
}

runTests().catch(err => {
  console.error("❌ Test runner failed with error:", err);
  process.exit(1);
});

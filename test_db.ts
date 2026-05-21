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

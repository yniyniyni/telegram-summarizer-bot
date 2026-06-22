import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

export interface SavedMessage {
  chat_id: number;
  message_id: number;
  user_id: number;
  username: string | null;
  first_name: string;
  last_name: string | null;
  text: string;
  timestamp: number;
  thread_id: number | null;
  media_type: string | null;
  media_file_id: string | null;
  media_path: string | null;
  media_mime_type: string | null;
}

let dbPath = 'data/bot_messages.db';
let dbInstance: Database<sqlite3.Database, sqlite3.Statement> | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Dynamically set the database path.
 * @param newPath 
 */
export function setDbPath(newPath: string): void {
  dbPath = newPath;
}

/**
 * Get the current database path.
 * @returns 
 */
export function getDbPath(): string {
  return dbPath;
}

/**
 * Open the SQLite database and run DDL setup.
 */
export async function initDb(): Promise<void> {
  if (dbInstance) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }

  const dirName = path.dirname(dbPath);
  if (dirName && !fs.existsSync(dirName)) {
    fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
  }

  initPromise = (async () => {
    const instance = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch (error) {
        console.warn(`Warning: Failed to set SQLite database file permissions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await instance.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_id INTEGER,
        message_id INTEGER,
        user_id INTEGER,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        text TEXT,
        timestamp INTEGER,
        thread_id INTEGER,
        PRIMARY KEY (chat_id, message_id)
      )
    `);

    await instance.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_chat_time
      ON messages (chat_id, timestamp)
    `);

    // Media columns migration (added 2026-06-22)
    const existingCols = await instance.all<{ name: string }[]>(
      "PRAGMA table_info(messages)"
    );
    const colNames = new Set(existingCols.map(c => c.name));

    const mediaMigration = [
      { name: 'media_type',       sql: "ALTER TABLE messages ADD COLUMN media_type TEXT" },
      { name: 'media_file_id',    sql: "ALTER TABLE messages ADD COLUMN media_file_id TEXT" },
      { name: 'media_path',       sql: "ALTER TABLE messages ADD COLUMN media_path TEXT" },
      { name: 'media_mime_type',  sql: "ALTER TABLE messages ADD COLUMN media_mime_type TEXT" },
    ];

    for (const col of mediaMigration) {
      if (!colNames.has(col.name)) {
        try {
          await instance.exec(col.sql);
        } catch (_err) {
          // Column may already exist from a concurrent/previous partial migration
        }
      }
    }

    await instance.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_media
      ON messages (chat_id, media_type, timestamp)
    `);

    dbInstance = instance;
  })();

  try {
    await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}


/**
 * Save or update a message in SQLite.
 */
export async function saveMessage({
  chat_id,
  message_id,
  user_id,
  username = null,
  first_name,
  last_name = null,
  text,
  timestamp,
  thread_id = null,
  media_type = null,
  media_file_id = null,
  media_path = null,
  media_mime_type = null,
}: SavedMessage): Promise<void> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }

  await dbInstance.run(
    `INSERT OR REPLACE INTO messages (
      chat_id, message_id, user_id, username, first_name, last_name, text, timestamp, thread_id,
      media_type, media_file_id, media_path, media_mime_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [chat_id, message_id, user_id, username, first_name, last_name, text, timestamp, thread_id,
     media_type ?? null, media_file_id ?? null, media_path ?? null, media_mime_type ?? null]
  );
}

/**
 * Fetch message logs from SQLite for a specific chat since a given timestamp.
 */
export async function getMessages(
  chatId: number, 
  sinceTimestamp: number, 
  threadId: number | null = null,
  limit = 5000,
  untilTimestamp?: number
): Promise<SavedMessage[]> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }

  let subquery = `
    SELECT chat_id, message_id, user_id, username, first_name, last_name, text, timestamp, thread_id,
           media_type, media_file_id, media_path, media_mime_type
    FROM messages
    WHERE chat_id = ? AND timestamp >= ?
  `;
  const params: (number | null)[] = [chatId, sinceTimestamp];

  if (untilTimestamp !== undefined) {
    subquery += " AND timestamp < ?";
    params.push(untilTimestamp);
  }

  if (threadId !== null && threadId !== undefined) {
    subquery += " AND thread_id = ?";
    params.push(threadId);
  } else {
    subquery += " AND thread_id IS NULL";
  }

  subquery += `
    ORDER BY timestamp DESC, message_id DESC
    LIMIT ?
  `;
  params.push(limit);

  const query = `
    SELECT chat_id, message_id, user_id, username, first_name, last_name, text, timestamp, thread_id,
           media_type, media_file_id, media_path, media_mime_type
    FROM (${subquery})
    ORDER BY timestamp ASC, message_id ASC
  `;

  const rows = await dbInstance.all<SavedMessage[]>(query, params);
  return rows || [];
}


/**
 * Begin a database transaction.
 */
export async function beginTransaction(): Promise<void> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  await dbInstance.run("BEGIN TRANSACTION");
}

/**
 * Commit a database transaction.
 */
export async function commitTransaction(): Promise<void> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  await dbInstance.run("COMMIT");
}

/**
 * Rollback a database transaction.
 */
export async function rollbackTransaction(): Promise<void> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  await dbInstance.run("ROLLBACK");
}

/**
 * Delete messages older than the specified duration in days.
 * @param days 
 * @returns Number of deleted messages.
 */
export async function cleanupOldMessages(days: number): Promise<number> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }

  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 3600);
  const result = await dbInstance.run(
    "DELETE FROM messages WHERE timestamp < ?",
    [cutoff]
  );
  return result.changes || 0;
}

/**
 * Returns DISTINCT non-null media_path values for messages older than the specified
 * number of days. Used before cleanup to identify files on disk that can be deleted.
 */
export async function getOldMediaPaths(days: number): Promise<string[]> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 3600);
  const rows = await dbInstance.all<{ media_path: string }[]>(
    "SELECT DISTINCT media_path FROM messages WHERE timestamp < ? AND media_path IS NOT NULL",
    [cutoff]
  );
  return rows.map(r => r.media_path).filter((p): p is string => p !== null && p !== '');
}

/**
 * Returns the oldest records that have a non-null media_path, up to the given limit.
 * Used to trim the oldest media files when storage is running low.
 */
export async function getOldestMediaRecords(limit: number): Promise<
  Array<{ media_path: string | null; chat_id: number; message_id: number }>
> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  const rows = await dbInstance.all<
    { media_path: string; chat_id: number; message_id: number }[]
  >(
    "SELECT media_path, chat_id, message_id FROM messages WHERE media_path IS NOT NULL ORDER BY timestamp ASC LIMIT ?",
    [limit]
  );
  return rows;
}

/**
 * Sets media_path = NULL for all messages that have the given media_path value.
 * Called after the file on disk has been deleted, to keep the DB consistent.
 */
export async function clearMediaPath(mediaPath: string): Promise<void> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  await dbInstance.run(
    "UPDATE messages SET media_path = NULL WHERE media_path = ?",
    [mediaPath]
  );
}

/**
 * Close the database connection. Useful for test teardowns.
 */
export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
  initPromise = null;
}


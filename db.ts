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
    fs.mkdirSync(dirName, { recursive: true });
  }

  initPromise = (async () => {
    const instance = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

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
  thread_id = null
}: SavedMessage): Promise<void> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }

  await dbInstance.run(
    `INSERT OR REPLACE INTO messages (
      chat_id, message_id, user_id, username, first_name, last_name, text, timestamp, thread_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [chat_id, message_id, user_id, username, first_name, last_name, text, timestamp, thread_id]
  );
}

/**
 * Fetch message logs from SQLite for a specific chat since a given timestamp.
 */
export async function getMessages(
  chatId: number, 
  sinceTimestamp: number, 
  threadId: number | null = null,
  limit = 5000
): Promise<SavedMessage[]> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }

  let query = `
    SELECT chat_id, message_id, user_id, username, first_name, last_name, text, timestamp, thread_id
    FROM messages
    WHERE chat_id = ? AND timestamp >= ?
  `;
  const params: (number | null)[] = [chatId, sinceTimestamp];

  if (threadId !== null && threadId !== undefined) {
    query += " AND thread_id = ?";
    params.push(threadId);
  } else {
    query += " AND thread_id IS NULL";
  }

  query += `
    ORDER BY timestamp ASC
    LIMIT ?
  `;
  params.push(limit);

  const rows = await dbInstance.all<SavedMessage[]>(query, params);
  return rows || [];
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
 * Close the database connection. Useful for test teardowns.
 */
export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
  initPromise = null;
}


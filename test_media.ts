import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as media from './media.js';
import * as db from './db.js';
import * as summarizer from './summarizer.js';
import { getLocale } from './locales.js';

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    testsPassed++;
  } catch (err) {
    testsFailed++;
    console.error(`FAIL: ${name}:`, err instanceof Error ? err.message : String(err));
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    testsPassed++;
  } catch (err) {
    testsFailed++;
    console.error(`FAIL: ${name}:`, err instanceof Error ? err.message : String(err));
  }
}

// ── DB setup/teardown helpers ──

async function setupTestDb(): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'media-test-db-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.db');
  db.setDbPath(dbPath);
  await db.initDb();
  return tmpDir;
}

async function teardownTestDb(tmpDir: string): Promise<void> {
  await db.closeDb();
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) { /* ok */ }
}

// --- Config getters ---

test('multimodalEnabled defaults to false', () => {
  delete process.env.MULTIMODAL_ENABLED;
  assert.equal(media.multimodalEnabled(), false);
});

test('multimodalEnabled returns true when set', () => {
  process.env.MULTIMODAL_ENABLED = 'true';
  assert.equal(media.multimodalEnabled(), true);
  delete process.env.MULTIMODAL_ENABLED;
});

test('imagesEnabled defaults to false', () => {
  delete process.env.MULTIMODAL_IMAGES_ENABLED;
  assert.equal(media.imagesEnabled(), false);
});

test('voiceEnabled defaults to false', () => {
  delete process.env.MULTIMODAL_VOICE_ENABLED;
  assert.equal(media.voiceEnabled(), false);
});

test('videoNoteEnabled defaults to false', () => {
  delete process.env.MULTIMODAL_VIDEO_NOTE_ENABLED;
  assert.equal(media.videoNoteEnabled(), false);
});

test('includeByDefault defaults to false', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  assert.equal(media.includeByDefault(), false);
});

test('getStorageMaxMb returns default 500', () => {
  delete process.env.MEDIA_STORAGE_MAX_MB;
  assert.equal(media.getStorageMaxMb(), 500);
});

test('getStorageMaxMb returns parsed value', () => {
  process.env.MEDIA_STORAGE_MAX_MB = '200';
  assert.equal(media.getStorageMaxMb(), 200);
  delete process.env.MEDIA_STORAGE_MAX_MB;
});

// --- checkMediaSize ---

test('checkMediaSize: image under 1MB passes', () => {
  assert.equal(media.checkMediaSize(500_000, 'image'), true);
});

test('checkMediaSize: image over 1MB rejected', () => {
  assert.equal(media.checkMediaSize(2_000_000, 'image'), false);
});

test('checkMediaSize: image at exactly 1MB passes', () => {
  assert.equal(media.checkMediaSize(1_048_576, 'image'), true);
});

test('checkMediaSize: voice under 3MB passes', () => {
  assert.equal(media.checkMediaSize(1_000_000, 'voice'), true);
});

test('checkMediaSize: voice over 3MB rejected', () => {
  assert.equal(media.checkMediaSize(4_000_000, 'voice'), false);
});

test('checkMediaSize: video_note under 5MB passes', () => {
  assert.equal(media.checkMediaSize(3_000_000, 'video_note'), true);
});

test('checkMediaSize: video_note over 5MB rejected', () => {
  assert.equal(media.checkMediaSize(6_000_000, 'video_note'), false);
});

test('checkMediaSize: unknown type returns false', () => {
  assert.equal(media.checkMediaSize(100, 'sticker'), false);
});

// --- shouldIncludeMedia ---

test('shouldIncludeMedia: all false when no keywords', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  const result = media.shouldIncludeMedia('суммаризуй за час');
  assert.equal(result.images, false);
  assert.equal(result.voice, false);
  assert.equal(result.videoNote, false);
});

test('shouldIncludeMedia: all true when includeByDefault', () => {
  process.env.MULTIMODAL_INCLUDE_BY_DEFAULT = 'true';
  const result = media.shouldIncludeMedia('суммаризуй за час');
  assert.equal(result.images, true);
  assert.equal(result.voice, true);
  assert.equal(result.videoNote, true);
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
});

test('shouldIncludeMedia: картинки triggers images', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  process.env.MULTIMODAL_IMAGES_ENABLED = 'true';
  const result = media.shouldIncludeMedia('суммаризуй за час с картинками');
  assert.equal(result.images, true);
  assert.equal(result.voice, false);
  assert.equal(result.videoNote, false);
  delete process.env.MULTIMODAL_IMAGES_ENABLED;
});

test('shouldIncludeMedia: фото triggers images', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  process.env.MULTIMODAL_IMAGES_ENABLED = 'true';
  const result = media.shouldIncludeMedia('суммаризуй с фото');
  assert.equal(result.images, true);
  delete process.env.MULTIMODAL_IMAGES_ENABLED;
});

test('shouldIncludeMedia: media triggers all', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  process.env.MULTIMODAL_IMAGES_ENABLED = 'true';
  process.env.MULTIMODAL_VOICE_ENABLED = 'true';
  process.env.MULTIMODAL_VIDEO_NOTE_ENABLED = 'true';
  const result = media.shouldIncludeMedia('суммаризуй с медиа');
  assert.equal(result.images, true);
  assert.equal(result.voice, true);
  assert.equal(result.videoNote, true);
  delete process.env.MULTIMODAL_IMAGES_ENABLED;
  delete process.env.MULTIMODAL_VOICE_ENABLED;
  delete process.env.MULTIMODAL_VIDEO_NOTE_ENABLED;
});

test('shouldIncludeMedia: english "photo" triggers images', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  process.env.MULTIMODAL_IMAGES_ENABLED = 'true';
  const result = media.shouldIncludeMedia('summarize with photo');
  assert.equal(result.images, true);
  delete process.env.MULTIMODAL_IMAGES_ENABLED;
});

test('shouldIncludeMedia: "voice" triggers voice only', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  process.env.MULTIMODAL_VOICE_ENABLED = 'true';
  const result = media.shouldIncludeMedia('summarize with voice messages');
  assert.equal(result.voice, true);
  assert.equal(result.images, false);
  delete process.env.MULTIMODAL_VOICE_ENABLED;
});

test('shouldIncludeMedia: "кружок" triggers videoNote', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  process.env.MULTIMODAL_VIDEO_NOTE_ENABLED = 'true';
  const result = media.shouldIncludeMedia('покажи кружки');
  assert.equal(result.videoNote, true);
  delete process.env.MULTIMODAL_VIDEO_NOTE_ENABLED;
});

test('shouldIncludeMedia: case insensitive', () => {
  delete process.env.MULTIMODAL_INCLUDE_BY_DEFAULT;
  process.env.MULTIMODAL_IMAGES_ENABLED = 'true';
  const result = media.shouldIncludeMedia('PHOTO please');
  assert.equal(result.images, true);
  delete process.env.MULTIMODAL_IMAGES_ENABLED;
});

// --- deleteMediaFiles ---

const MEDIA_BASE_DIR = 'data/media';

function setupMediaTestDir(): string {
  const chatDir = path.join(MEDIA_BASE_DIR, 'test-chat-' + Date.now());
  fs.mkdirSync(chatDir, { recursive: true });
  return chatDir;
}

function cleanupMediaTestDir(chatDir: string): void {
  // Remove files
  if (fs.existsSync(chatDir)) {
    for (const f of fs.readdirSync(chatDir)) {
      fs.unlinkSync(path.join(chatDir, f));
    }
    fs.rmdirSync(chatDir);
  }
  // Remove MEDIA_BASE_DIR if empty
  const mediaDir = path.resolve(MEDIA_BASE_DIR);
  if (fs.existsSync(mediaDir)) {
    try {
      const entries = fs.readdirSync(mediaDir);
      if (entries.length === 0) {
        fs.rmdirSync(mediaDir);
      }
    } catch (_) { /* ok */ }
  }
}

test('deleteMediaFiles: deletes files under MEDIA_BASE_DIR and returns count', () => {
  const chatDir = setupMediaTestDir();
  const file1 = path.join(chatDir, '1000_1.jpg');
  const file2 = path.join(chatDir, '1001_2.jpg');
  fs.writeFileSync(file1, 'test content 1');
  fs.writeFileSync(file2, 'test content 2');

  const relFile1 = path.relative('.', file1);
  const relFile2 = path.relative('.', file2);
  const deleted = media.deleteMediaFiles([relFile1, relFile2]);

  assert.equal(deleted, 2);
  assert.equal(fs.existsSync(file1), false);
  assert.equal(fs.existsSync(file2), false);
  cleanupMediaTestDir(chatDir);
});

test('deleteMediaFiles: refuses paths outside MEDIA_BASE_DIR', () => {
  const outsidePath = path.join('/tmp', 'outside-' + Date.now() + '.jpg');
  const deleted = media.deleteMediaFiles([outsidePath]);
  assert.equal(deleted, 0);
  // File should not have been created or deleted — safe no-op
});

test('deleteMediaFiles: removes empty chat directories', () => {
  const chatDir = setupMediaTestDir();
  const file1 = path.join(chatDir, '1000_1.jpg');
  fs.writeFileSync(file1, 'test');
  const relFile1 = path.relative('.', file1);

  media.deleteMediaFiles([relFile1]);

  assert.equal(fs.existsSync(file1), false);
  assert.equal(fs.existsSync(chatDir), false);
  // chatDir should be gone since it's empty
  cleanupMediaTestDir(chatDir);
});

test('deleteMediaFiles: returns 0 for empty array', () => {
  const deleted = media.deleteMediaFiles([]);
  assert.equal(deleted, 0);
});

test('deleteMediaFiles: skips falsy paths', () => {
  const deleted = media.deleteMediaFiles(['']);
  assert.equal(deleted, 0);
});

test('deleteMediaFiles: handles non-existent files gracefully', () => {
  const chatDir = setupMediaTestDir();
  const nonexistent = path.join(chatDir, 'nonexistent.jpg');
  const relPath = path.relative('.', nonexistent);
  const deleted = media.deleteMediaFiles([relPath]);
  assert.equal(deleted, 0);
  cleanupMediaTestDir(chatDir);
});

// --- enforceStorageLimit ---

test('enforceStorageLimit: returns empty array when maxMb <= 0', () => {
  const result = media.enforceStorageLimit([], 0);
  assert.deepEqual(result, []);
});

test('enforceStorageLimit: returns empty array when nothing on disk', () => {
  // No files in MEDIA_BASE_DIR
  const result = media.enforceStorageLimit([], 1);
  assert.deepEqual(result, []);
});

test('enforceStorageLimit: deletes oldest files when over limit', () => {
  const chatDir = setupMediaTestDir();
  const file1 = path.join(chatDir, '1000_1.jpg');
  const file2 = path.join(chatDir, '1001_2.jpg');
  const file3 = path.join(chatDir, '1002_3.jpg');

  // Each file ~100 bytes. Limit to 150 bytes (~0.00014 MB) to force deletion.
  fs.writeFileSync(file1, Buffer.alloc(100, 1));
  fs.writeFileSync(file2, Buffer.alloc(100, 2));
  fs.writeFileSync(file3, Buffer.alloc(100, 3));

  const relFile1 = path.relative('.', file1);
  const relFile2 = path.relative('.', file2);
  const relFile3 = path.relative('.', file3);

  const records = [
    { media_path: relFile1 },
    { media_path: relFile2 },
    { media_path: relFile3 },
  ];

  // maxMb = 0.0001 (~105 bytes) so only one small file fits
  const deleted = media.enforceStorageLimit(records, 0.0001);

  // Should have deleted at least file1 and file2 (oldest first) until under ~105 bytes
  assert.ok(deleted.length >= 2, `Expected >= 2 deletions, got ${deleted.length}`);
  // The youngest file should survive (it alone is 100 bytes <= 105)
  const surviving = records.filter(r => !deleted.includes(r.media_path!));
  assert.ok(surviving.length >= 1, 'Expected at least one file to survive');

  // Cleanup remaining files
  cleanupMediaTestDir(chatDir);
});

test('enforceStorageLimit: does not delete if under limit', () => {
  const chatDir = setupMediaTestDir();
  const file1 = path.join(chatDir, '1000_1.jpg');
  fs.writeFileSync(file1, Buffer.alloc(50, 1));

  const relFile1 = path.relative('.', file1);
  const result = media.enforceStorageLimit([{ media_path: relFile1 }], 1);
  assert.deepEqual(result, []);
  assert.equal(fs.existsSync(file1), true);

  cleanupMediaTestDir(chatDir);
});

test('enforceStorageLimit: skips null media_path records', () => {
  const chatDir = setupMediaTestDir();
  const file1 = path.join(chatDir, '1000_1.jpg');
  fs.writeFileSync(file1, Buffer.alloc(200, 1));

  const relFile1 = path.relative('.', file1);
  const records = [
    { media_path: null },
    { media_path: relFile1 },
  ];

  // limit is 0.0001 MB (~105 bytes), file is 200 bytes, but first record is null
  const deleted = media.enforceStorageLimit(records, 0.0001);
  // Should skip null record and delete the second one
  assert.ok(deleted.length >= 1);

  cleanupMediaTestDir(chatDir);
});

// ===================================================================
// New: buildMultimodalContents tests (sync)
// ===================================================================

test('buildMultimodalContents: text-only messages produce no media parts', () => {
  const locale = getLocale();
  const msgs: db.SavedMessage[] = [{
    chat_id: -100123, message_id: 1, user_id: 100, username: null,
    first_name: 'Test', last_name: null, text: 'hello world', timestamp: 1000000,
    thread_id: null, media_type: null, media_file_id: null, media_path: null, media_mime_type: null,
  }];

  const result = summarizer.buildMultimodalContents(
    msgs, 'test period', 'UTC',
    { images: true, voice: true, videoNote: true },
    locale, false
  );

  assert.equal(result.mediaCount, 0);
  assert.equal(result.skippedMediaCount, 0);
  assert.equal(result.contents.length, 1);
  assert.ok(Array.isArray(result.contents[0].parts));
});

test('buildMultimodalContents: media message with include flag gets inlineData', () => {
  const tmpDir = path.join(os.tmpdir(), 'media-build-test-' + Date.now());
  const mediaDir = path.join(tmpDir, 'data', 'media', '-100123');
  fs.mkdirSync(mediaDir, { recursive: true });
  const imgPath = path.join(mediaDir, '1000_2.jpg');
  fs.writeFileSync(imgPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

  try {
    const locale = getLocale();
    const msgs: db.SavedMessage[] = [{
      chat_id: -100123, message_id: 2, user_id: 200, username: null,
      first_name: 'User2', last_name: null, text: 'look at this',
      timestamp: 1000100, thread_id: null,
      media_type: 'image', media_file_id: 'f1', media_path: imgPath, media_mime_type: 'image/jpeg',
    }];

    const result = summarizer.buildMultimodalContents(
      msgs, 'test period', 'UTC',
      { images: true, voice: false, videoNote: false },
      locale, false
    );

    assert.equal(result.mediaCount, 1);
    assert.equal(result.skippedMediaCount, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('buildMultimodalContents: media message with excluded flag gets text placeholder only', () => {
  const tmpDir = path.join(os.tmpdir(), 'media-build-test2-' + Date.now());
  const mediaDir = path.join(tmpDir, 'data', 'media', '-100123');
  fs.mkdirSync(mediaDir, { recursive: true });
  const imgPath = path.join(mediaDir, '2000_3.jpg');
  fs.writeFileSync(imgPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

  try {
    const locale = getLocale();
    const msgs: db.SavedMessage[] = [{
      chat_id: -100123, message_id: 3, user_id: 300, username: null,
      first_name: 'User3', last_name: null, text: 'photo here',
      timestamp: 2000000, thread_id: null,
      media_type: 'image', media_file_id: 'f2', media_path: imgPath, media_mime_type: 'image/jpeg',
    }];

    const result = summarizer.buildMultimodalContents(
      msgs, 'test period', 'UTC',
      { images: false, voice: false, videoNote: false },
      locale, false
    );

    assert.equal(result.mediaCount, 0);
    const partsStr = JSON.stringify(result.contents[0].parts);
    assert.ok(partsStr.includes(locale.photoAttached));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('buildMultimodalContents: missing media file increments skippedMediaCount', () => {
  const locale = getLocale();
  const nonexistentPath = path.join(os.tmpdir(), 'nonexistent-media-' + Date.now() + '.jpg');
  const msgs: db.SavedMessage[] = [{
    chat_id: -100123, message_id: 4, user_id: 400, username: null,
    first_name: 'User4', last_name: null, text: 'lost photo',
    timestamp: 3000000, thread_id: null,
    media_type: 'image', media_file_id: 'f3', media_path: nonexistentPath, media_mime_type: 'image/jpeg',
  }];

  const result = summarizer.buildMultimodalContents(
    msgs, 'test period', 'UTC',
    { images: true, voice: false, videoNote: false },
    locale, false
  );

  assert.equal(result.mediaCount, 0);
  assert.equal(result.skippedMediaCount, 1);
});

test('buildMultimodalContents: user info included in media message text lines', () => {
  // Default behavior (REDACT_USER_IDENTITIES unset): real names ARE present
  const locale = getLocale();
  const msgs: db.SavedMessage[] = [{
    chat_id: -100123, message_id: 5, user_id: 500, username: '@realuser',
    first_name: 'RealName', last_name: 'Surname', text: 'my text',
    timestamp: 4000000, thread_id: null,
    media_type: 'image', media_file_id: 'f4', media_path: null, media_mime_type: 'image/jpeg',
  }];

  const result = summarizer.buildMultimodalContents(
    msgs, 'test period', 'UTC',
    { images: false, voice: false, videoNote: false },
    locale, false
  );

  const partsStr = JSON.stringify(result.contents[0].parts);
  // Default (non-redacted): real names ARE present
  assert.ok(partsStr.includes('RealName'));
  assert.ok(partsStr.includes('realuser'));
});

test('buildMultimodalContents: PII redaction replaces names with pseudonyms', () => {
  process.env.REDACT_USER_IDENTITIES = 'true';
  const tmpDir = path.join(os.tmpdir(), 'media-pii-mm-' + Date.now());
  const mediaDir = path.join(tmpDir, 'data', 'media', '-100123');
  fs.mkdirSync(mediaDir, { recursive: true });
  const imgPath = path.join(mediaDir, '4000_99.jpg');
  fs.writeFileSync(imgPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

  const locale = getLocale();
  const relPath = path.relative('.', imgPath);
  const msgs: db.SavedMessage[] = [{
    chat_id: -100123, message_id: 99, user_id: 700, username: 'real_ivan',
    first_name: 'Иван', last_name: 'Иванов', text: 'Привет от Иван Иванов, напиши @real_ivan или @another_user.',
    timestamp: 7000000, thread_id: null,
    media_type: 'image', media_file_id: 'f_pii', media_path: relPath, media_mime_type: 'image/jpeg',
  }];

  const result = summarizer.buildMultimodalContents(
    msgs, 'test period', 'UTC',
    { images: true, voice: false, videoNote: false },
    locale, false
  );

  const partsStr = JSON.stringify(result.contents[0].parts);
  // Real names MUST NOT appear
  assert.ok(!partsStr.includes('Иван'));
  assert.ok(!partsStr.includes('Иванов'));
  assert.ok(!partsStr.includes('real_ivan'));
  // Pseudonyms must be present
  assert.ok(partsStr.includes('User '), `Expected 'User N' pseudonym`);
  // Unknown @mentions redacted
  assert.ok(partsStr.includes('@user_redacted'), `Expected '@user_redacted'`);
  // InlineData unaffected by text redaction
  assert.equal(result.mediaCount, 1);

  delete process.env.REDACT_USER_IDENTITIES;
  fs.unlinkSync(imgPath);
  fs.rmdirSync(mediaDir);
  fs.rmdirSync(path.dirname(mediaDir));
  fs.rmdirSync(path.dirname(path.dirname(mediaDir)));
  fs.rmdirSync(tmpDir);
});

test('buildMultimodalContents: media-only message (empty text) gets generated line with placeholder', () => {
  const locale = getLocale();
  const msgs: db.SavedMessage[] = [{
    chat_id: -100123, message_id: 6, user_id: 600, username: null,
    first_name: 'VoiceUser', last_name: null, text: '',
    timestamp: 5000000, thread_id: null,
    media_type: 'voice', media_file_id: 'f5', media_path: 'data/media/test.ogg', media_mime_type: 'audio/ogg',
  }];

  const result = summarizer.buildMultimodalContents(
    msgs, 'test period', 'UTC',
    { images: false, voice: false, videoNote: false },
    locale, false
  );

  const partsStr = JSON.stringify(result.contents[0].parts);
  assert.ok(partsStr.includes('VoiceUser'));
  assert.ok(partsStr.includes(locale.voiceAttached));
});

test('buildMultimodalContents: includeIds=true adds #id prefix to media messages', () => {
  const locale = getLocale();
  const msgs: db.SavedMessage[] = [{
    chat_id: -100123, message_id: 42, user_id: 600, username: null,
    first_name: 'U', last_name: null, text: 'msg with media',
    timestamp: 5000000, thread_id: null,
    media_type: 'image', media_file_id: 'f5', media_path: null, media_mime_type: 'image/jpeg',
  }];

  const result = summarizer.buildMultimodalContents(
    msgs, 'test period', 'UTC',
    { images: false, voice: false, videoNote: false },
    locale, true
  );

  const partsStr = JSON.stringify(result.contents[0].parts);
  assert.ok(partsStr.includes('#42'));
});

test('buildMultimodalContents: video_note with include flag gets inlineData', () => {
  const tmpDir = path.join(os.tmpdir(), 'media-videonote-test-' + Date.now());
  const mediaDir = path.join(tmpDir, 'data', 'media', '-100123');
  fs.mkdirSync(mediaDir, { recursive: true });
  const vidPath = path.join(mediaDir, '5000_7.mp4');
  fs.writeFileSync(vidPath, Buffer.from([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]));

  try {
    const locale = getLocale();
    const msgs: db.SavedMessage[] = [{
      chat_id: -100123, message_id: 7, user_id: 700, username: null,
      first_name: 'VidUser', last_name: null, text: 'watch this',
      timestamp: 6000000, thread_id: null,
      media_type: 'video_note', media_file_id: 'vf1', media_path: vidPath, media_mime_type: 'video/mp4',
    }];

    const result = summarizer.buildMultimodalContents(
      msgs, 'test period', 'UTC',
      { images: false, voice: false, videoNote: true },
      locale, false
    );

    assert.equal(result.mediaCount, 1);
    assert.equal(result.skippedMediaCount, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('buildMultimodalContents: multiple media messages with mixed include flags', () => {
  const tmpDir = path.join(os.tmpdir(), 'media-mixed-test-' + Date.now());
  const mediaDir = path.join(tmpDir, 'data', 'media', '-100123');
  fs.mkdirSync(mediaDir, { recursive: true });
  const imgPath = path.join(mediaDir, '6000_8.jpg');
  const voicePath = path.join(mediaDir, '6001_9.ogg');
  fs.writeFileSync(imgPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
  fs.writeFileSync(voicePath, Buffer.from([0x4F, 0x67, 0x67, 0x53]));

  try {
    const locale = getLocale();
    const msgs: db.SavedMessage[] = [
      {
        chat_id: -100123, message_id: 8, user_id: 800, username: null,
        first_name: 'ImgUser', last_name: null, text: 'image here',
        timestamp: 7000000, thread_id: null,
        media_type: 'image', media_file_id: 'if1', media_path: imgPath, media_mime_type: 'image/jpeg',
      },
      {
        chat_id: -100123, message_id: 9, user_id: 900, username: null,
        first_name: 'VoiceUser2', last_name: null, text: 'voice here',
        timestamp: 7000001, thread_id: null,
        media_type: 'voice', media_file_id: 'vf2', media_path: voicePath, media_mime_type: 'audio/ogg',
      },
    ];

    const result = summarizer.buildMultimodalContents(
      msgs, 'test period', 'UTC',
      { images: true, voice: false, videoNote: false },
      locale, false
    );

    assert.equal(result.mediaCount, 1);
    assert.equal(result.skippedMediaCount, 0);

    const partsStr = JSON.stringify(result.contents[0].parts);
    assert.ok(partsStr.includes(locale.photoAttached));
    assert.ok(partsStr.includes(locale.voiceAttached));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// --- MIME type resolution ---

test('resolveMimeType maps known extensions precisely', () => {
  assert.equal(media.resolveMimeType('.jpg', 'image'), 'image/jpeg');
  assert.equal(media.resolveMimeType('.png', 'image'), 'image/png');
  assert.equal(media.resolveMimeType('.ogg', 'voice'), 'audio/ogg');
});

test('resolveMimeType maps Telegram voice .oga/.opus to audio/ogg', () => {
  // Telegram serves voice messages with a .oga extension, which previously
  // fell through to application/octet-stream and triggered a Gemini 400.
  assert.equal(media.resolveMimeType('.oga', 'voice'), 'audio/ogg');
  assert.equal(media.resolveMimeType('.opus', 'voice'), 'audio/ogg');
});

test('resolveMimeType is case-insensitive', () => {
  assert.equal(media.resolveMimeType('.JPG', 'image'), 'image/jpeg');
  assert.equal(media.resolveMimeType('.OGA', 'voice'), 'audio/ogg');
});

test('resolveMimeType falls back to media-type default for unknown extensions', () => {
  assert.equal(media.resolveMimeType('.weird', 'image'), 'image/jpeg');
  assert.equal(media.resolveMimeType('.weird', 'voice'), 'audio/ogg');
  assert.equal(media.resolveMimeType('.weird', 'video_note'), 'video/mp4');
  assert.equal(media.resolveMimeType('.weird', 'unknown'), 'application/octet-stream');
});

test('buildMultimodalContents skips media with unsupported MIME type', () => {
  const tmpDir = path.join(os.tmpdir(), 'media-badmime-test-' + Date.now());
  const mediaDir = path.join(tmpDir, 'data', 'media', '-100123');
  fs.mkdirSync(mediaDir, { recursive: true });
  const filePath = path.join(mediaDir, '7000_10.bin');
  fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

  try {
    const locale = getLocale();
    const msgs: db.SavedMessage[] = [
      {
        chat_id: -100123, message_id: 10, user_id: 100, username: null,
        first_name: 'BadMime', last_name: null, text: 'voice here',
        timestamp: 7000000, thread_id: null,
        media_type: 'voice', media_file_id: 'bf1', media_path: filePath,
        media_mime_type: 'application/octet-stream',
      },
    ];

    const result = summarizer.buildMultimodalContents(
      msgs, 'test period', 'UTC',
      { images: true, voice: true, videoNote: true },
      locale, false
    );

    // Unsupported MIME is skipped, not sent — and never crashes the request.
    assert.equal(result.mediaCount, 0);
    assert.equal(result.skippedMediaCount, 1);
    const partsStr = JSON.stringify(result.contents[0].parts);
    assert.ok(!partsStr.includes('inlineData'), 'should not attach inlineData for unsupported MIME');
    // The text line with the voice placeholder must still be present (exactly once).
    assert.ok(partsStr.includes(locale.voiceAttached));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ===================================================================
// Async DB-dependent tests
// ===================================================================

async function runTests() {
  console.log('Starting media tests...\n');
  // test() calls above run during import (sync tests already executed)

  // ── Media logging tests ──

  await testAsync('saveMessage with media columns', async () => {
    const tmpDir = await setupTestDb();
    try {
      await db.saveMessage({
        chat_id: -100123,
        message_id: 1,
        user_id: 100,
        username: 'testuser',
        first_name: 'Test',
        last_name: 'User',
        text: 'check this photo',
        timestamp: Math.floor(Date.now() / 1000),
        thread_id: null,
        media_type: 'image',
        media_file_id: 'file_123',
        media_path: 'data/media/test.jpg',
        media_mime_type: 'image/jpeg',
      });

      const msgs = await db.getMessages(-100123, 0, null);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].media_type, 'image');
      assert.equal(msgs[0].media_file_id, 'file_123');
      assert.equal(msgs[0].media_path, 'data/media/test.jpg');
      assert.equal(msgs[0].media_mime_type, 'image/jpeg');
      assert.equal(msgs[0].text, 'check this photo');
    } finally {
      await teardownTestDb(tmpDir);
    }
  });

  await testAsync('saveMessage with media but no text', async () => {
    const tmpDir = await setupTestDb();
    try {
      await db.saveMessage({
        chat_id: -100123,
        message_id: 2,
        user_id: 100,
        username: null,
        first_name: 'Test',
        last_name: null,
        text: '',
        timestamp: Math.floor(Date.now() / 1000),
        thread_id: null,
        media_type: 'voice',
        media_file_id: 'voice_456',
        media_path: 'data/media/voice.ogg',
        media_mime_type: 'audio/ogg',
      });

      const msgs = await db.getMessages(-100123, 0, null);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].media_type, 'voice');
      assert.equal(msgs[0].text, '');
    } finally {
      await teardownTestDb(tmpDir);
    }
  });

  await testAsync('media message appears alongside text messages in getMessages', async () => {
    const tmpDir = await setupTestDb();
    const now = Math.floor(Date.now() / 1000);
    try {
      await db.saveMessage({
        chat_id: -100123, message_id: 1, user_id: 100, username: null,
        first_name: 'A', last_name: null, text: 'text 1', timestamp: now - 100,
        thread_id: null, media_type: null, media_file_id: null, media_path: null, media_mime_type: null,
      });
      await db.saveMessage({
        chat_id: -100123, message_id: 2, user_id: 200, username: null,
        first_name: 'B', last_name: null, text: '', timestamp: now - 50,
        thread_id: null, media_type: 'image', media_file_id: 'f1', media_path: 'p1', media_mime_type: 'image/jpeg',
      });
      await db.saveMessage({
        chat_id: -100123, message_id: 3, user_id: 300, username: null,
        first_name: 'C', last_name: null, text: 'text 3', timestamp: now,
        thread_id: null, media_type: null, media_file_id: null, media_path: null, media_mime_type: null,
      });

      const msgs = await db.getMessages(-100123, now - 200, null);
      assert.equal(msgs.length, 3);
      assert.equal(msgs[1].media_type, 'image');
      assert.equal(msgs[1].text, '');
    } finally {
      await teardownTestDb(tmpDir);
    }
  });

  // ── Edited media message: media columns preserved ──

  await testAsync('saveMessage (upsert) preserves media columns when updating text', async () => {
    const tmpDir = await setupTestDb();
    const now = Math.floor(Date.now() / 1000);
    try {
      await db.saveMessage({
        chat_id: -100123, message_id: 1, user_id: 100, username: null,
        first_name: 'T', last_name: null, text: 'original text',
        timestamp: now, thread_id: null,
        media_type: 'image', media_file_id: 'f_orig', media_path: 'p_orig', media_mime_type: 'image/jpeg',
      });

      await db.saveMessage({
        chat_id: -100123, message_id: 1, user_id: 100, username: null,
        first_name: 'T', last_name: null, text: 'edited text',
        timestamp: now, thread_id: null,
        media_type: 'image', media_file_id: 'f_orig', media_path: 'p_orig', media_mime_type: 'image/jpeg',
      });

      const msgs = await db.getMessages(-100123, now - 10, null);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].text, 'edited text');
      assert.equal(msgs[0].media_type, 'image');
      assert.equal(msgs[0].media_path, 'p_orig');
    } finally {
      await teardownTestDb(tmpDir);
    }
  });

  // ── getOldMediaPaths for cleanup ──

  await testAsync('getOldMediaPaths returns paths for old media messages', async () => {
    const tmpDir = await setupTestDb();
    const oldTs = Math.floor(Date.now() / 1000) - (31 * 24 * 3600); // 31 days ago
    try {
      await db.saveMessage({
        chat_id: -100123, message_id: 1, user_id: 100, username: null,
        first_name: 'T', last_name: null, text: 'old media',
        timestamp: oldTs, thread_id: null,
        media_type: 'image', media_file_id: 'f_old', media_path: 'data/media/old.jpg', media_mime_type: 'image/jpeg',
      });
      await db.saveMessage({
        chat_id: -100123, message_id: 2, user_id: 100, username: null,
        first_name: 'T', last_name: null, text: 'recent no media',
        timestamp: Math.floor(Date.now() / 1000) - 100, thread_id: null,
        media_type: null, media_file_id: null, media_path: null, media_mime_type: null,
      });

      const paths = await db.getOldMediaPaths(30);
      assert.ok(paths.includes('data/media/old.jpg'));
      assert.equal(paths.length, 1);
    } finally {
      await teardownTestDb(tmpDir);
    }
  });

  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import * as media from './media.js';

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

function runTests() {
  console.log('Starting media tests...\n');
  // test() calls above run during import
  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) process.exit(1);
}

runTests();

import assert from 'node:assert/strict';
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

function runTests() {
  console.log('Starting media tests...\n');
  // test() calls above run during import
  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) process.exit(1);
}

runTests();

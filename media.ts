import fs from 'fs';
import path from 'path';
import { log } from './utils.js';

// Per-type file size limits (bytes)
export const MAX_IMAGE_BYTES = 1_048_576;       // 1 MB
export const MAX_VOICE_BYTES = 3_145_728;       // 3 MB
export const MAX_VIDEO_NOTE_BYTES = 5_242_880;  // 5 MB

// ── Config getters ──

export function multimodalEnabled(): boolean {
  return (process.env.MULTIMODAL_ENABLED || '').trim().toLowerCase() === 'true';
}

export function imagesEnabled(): boolean {
  return (process.env.MULTIMODAL_IMAGES_ENABLED || '').trim().toLowerCase() === 'true';
}

export function voiceEnabled(): boolean {
  return (process.env.MULTIMODAL_VOICE_ENABLED || '').trim().toLowerCase() === 'true';
}

export function videoNoteEnabled(): boolean {
  return (process.env.MULTIMODAL_VIDEO_NOTE_ENABLED || '').trim().toLowerCase() === 'true';
}

export function includeByDefault(): boolean {
  return (process.env.MULTIMODAL_INCLUDE_BY_DEFAULT || '').trim().toLowerCase() === 'true';
}

export function getStorageMaxMb(): number {
  const val = process.env.MEDIA_STORAGE_MAX_MB;
  if (val === undefined || val === '') return 500;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? 500 : parsed;
}

// ── Size checking ──

export function checkMediaSize(fileSize: number, mediaType: string): boolean {
  switch (mediaType) {
    case 'image':      return fileSize <= MAX_IMAGE_BYTES;
    case 'voice':      return fileSize <= MAX_VOICE_BYTES;
    case 'video_note': return fileSize <= MAX_VIDEO_NOTE_BYTES;
    default:           return false;
  }
}

// ── Keyword matching ──

const MEDIA_TRIGGERS: Record<string, string[]> = {
  images:    ['картинк', 'фото', 'изображен', 'image', 'photo', 'picture', 'медиа', 'media'],
  voice:     ['войс', 'голосов', 'аудио', 'voice', 'audio', 'медиа', 'media'],
  videoNote: ['кружк', 'видеосообщ', 'video message', 'video note', 'медиа', 'media'],
};

export interface MediaIncludeFlags {
  images: boolean;
  voice: boolean;
  videoNote: boolean;
}

export function shouldIncludeMedia(requestText: string): MediaIncludeFlags {
  if (includeByDefault()) {
    return { images: true, voice: true, videoNote: true };
  }
  const lower = requestText.toLowerCase();
  const matchAny = (triggers: string[]) => triggers.some(kw => lower.includes(kw));

  return {
    images:    imagesEnabled() && matchAny(MEDIA_TRIGGERS.images),
    voice:     voiceEnabled() && matchAny(MEDIA_TRIGGERS.voice),
    videoNote: videoNoteEnabled() && matchAny(MEDIA_TRIGGERS.videoNote),
  };
}

// ── Media file I/O ──

const MEDIA_BASE_DIR = 'data/media';

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg': return '.jpg';
    case 'image/png':  return '.png';
    case 'image/webp': return '.webp';
    case 'audio/ogg':  return '.ogg';
    case 'audio/mp3':  return '.mp3';
    case 'video/mp4':  return '.mp4';
    default:           return '.bin';
  }
}

function extToMime(ext: string): string {
  switch (ext) {
    case '.jpg':  return 'image/jpeg';
    case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    case '.webp': return 'image/webp';
    case '.ogg':  return 'audio/ogg';
    case '.mp3':  return 'audio/mp3';
    case '.mp4':  return 'video/mp4';
    default:      return 'application/octet-stream';
  }
}

/**
 * Download a media file from Telegram servers and save to disk.
 * Returns { path, mimeType } on success, or null on any failure.
 */
export async function downloadMedia(
  botToken: string,
  fileId: string,
  chatId: number,
  messageId: number,
  mediaType: string
): Promise<{ path: string; mimeType: string } | null> {
  try {
    // 1. Get file metadata from Telegram
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const getFileRes = await fetch(getFileUrl);
    if (!getFileRes.ok) {
      log("WARN", `Failed to get Telegram file info for ${fileId}: HTTP ${getFileRes.status}`);
      return null;
    }
    const fileData = await getFileRes.json() as {
      ok: boolean;
      result?: { file_path?: string; file_size?: number };
    };
    if (!fileData.ok || !fileData.result?.file_path) {
      log("WARN", `Telegram getFile returned not ok for ${fileId}`);
      return null;
    }

    const telegramFilePath = fileData.result.file_path;
    const fileSize = fileData.result.file_size || 0;

    // 2. Size check (pre-download, based on Telegram-reported size)
    if (fileSize > 0 && !checkMediaSize(fileSize, mediaType)) {
      log("WARN", `Media file too large: ${fileSize} bytes for type ${mediaType} (file_id=${fileId})`);
      return null;
    }

    // 3. Determine output path and MIME type
    const ext = path.extname(telegramFilePath) || mimeToExt(
      mediaType === 'image' ? 'image/jpeg' :
      mediaType === 'voice' ? 'audio/ogg' : 'video/mp4'
    );
    const mimeType = extToMime(ext);
    const ts = Math.floor(Date.now() / 1000);
    const fileName = `${ts}_${messageId}${ext}`;
    const dir = path.join(MEDIA_BASE_DIR, String(chatId));
    const destPath = path.join(dir, fileName);

    // 4. Download file from Telegram
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${telegramFilePath}`;
    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) {
      log("WARN", `Failed to download media ${fileId}: HTTP ${downloadRes.status}`);
      return null;
    }

    // 4b. Check Content-Length header BEFORE reading the body into memory.
    // Telegram may omit file_size in the getFile response, so without this
    // check we would allocate the full download (up to 20 MB Bot API limit)
    // before rejecting it.
    const contentLength = downloadRes.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && !checkMediaSize(size, mediaType)) {
        log("WARN", `Media file too large (Content-Length=${size} bytes) for type ${mediaType}, skipping download`);
        return null;
      }
    }

    const buffer = Buffer.from(await downloadRes.arrayBuffer());

    // 5. Double-check actual size (Telegram may not report file_size)
    if (buffer.length > 0 && !checkMediaSize(buffer.length, mediaType)) {
      log("WARN", `Downloaded media file too large: ${buffer.length} bytes for type ${mediaType}`);
      return null;
    }

    // 6. Save to disk
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(destPath, buffer);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(destPath, 0o600); } catch (_) { /* best effort */ }
    }

    const relPath = path.join(MEDIA_BASE_DIR, String(chatId), fileName);
    log("DEBUG", `Saved media: ${relPath} (${buffer.length} bytes, type=${mediaType})`);
    return { path: relPath, mimeType };
  } catch (err) {
    log("WARN", `Error downloading media ${fileId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Delete specific media files from disk. Returns the number of files deleted.
 * Only deletes files under MEDIA_BASE_DIR for safety.
 */
export function deleteMediaFiles(paths: string[]): number {
  let deleted = 0;
  for (const mediaPath of paths) {
    if (!mediaPath) continue;
    const absolutePath = path.resolve(mediaPath);
    // Safety: only delete files under MEDIA_BASE_DIR
    if (!absolutePath.startsWith(path.resolve(MEDIA_BASE_DIR))) {
      log("WARN", `Refusing to delete file outside media dir: ${mediaPath}`);
      continue;
    }
    try {
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
        deleted++;
      }
    } catch (err) {
      log("WARN", `Failed to delete media file ${mediaPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Remove empty chat directories
  try {
    const chatDirs = new Set(paths.map(p => path.dirname(p)).filter(Boolean));
    for (const dir of chatDirs) {
      const absDir = path.resolve(dir);
      if (absDir.startsWith(path.resolve(MEDIA_BASE_DIR)) && fs.existsSync(absDir)) {
        const remaining = fs.readdirSync(absDir);
        if (remaining.length === 0) {
          fs.rmdirSync(absDir);
        }
      }
    }
  } catch (_) { /* best effort */ }
  return deleted;
}

/**
 * Delete oldest media files until total storage is under maxMb.
 * `oldestFirst` is an array of media records sorted by timestamp ascending.
 * Returns array of deleted paths.
 */
export function enforceStorageLimit(
  oldestFirst: Array<{ media_path: string | null }>,
  maxMb: number
): string[] {
  if (maxMb <= 0) return [];

  // Compute total size of all files on disk under MEDIA_BASE_DIR
  const getTotalBytes = (): number => {
    let total = 0;
    const baseDir = path.resolve(MEDIA_BASE_DIR);
    if (!fs.existsSync(baseDir)) return 0;
    const walkDir = (dir: string): void => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isFile()) {
            try { total += fs.statSync(full).size; } catch (_) { /* skip */ }
          } else if (entry.isDirectory()) {
            walkDir(full);
          }
        }
      } catch (_) { /* skip */ }
    };
    walkDir(baseDir);
    return total;
  };

  const maxBytes = maxMb * 1_048_576;
  const deleted: string[] = [];

  // Walk the disk ONCE to get the current total, then subtract each
  // deleted file's size from the running total. Previously getTotalBytes()
  // was called inside the loop, making this O(n × files_on_disk).
  let currentTotal = getTotalBytes();

  for (const record of oldestFirst) {
    if (currentTotal <= maxBytes) break;
    if (!record.media_path) continue;
    const absPath = path.resolve(record.media_path);
    if (!absPath.startsWith(path.resolve(MEDIA_BASE_DIR))) continue;
    try {
      if (fs.existsSync(absPath)) {
        // Stat before unlink — stat after unlink always fails.
        try {
          const fileSize = fs.statSync(absPath).size;
          currentTotal -= fileSize;
        } catch (_) {
          // If stat fails mid-iteration, recalculate to avoid drift.
          currentTotal = getTotalBytes();
        }
        fs.unlinkSync(absPath);
        deleted.push(record.media_path);
      }
    } catch (err) {
      log("WARN", `Storage limit enforcement: failed to delete ${record.media_path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (deleted.length > 0) {
    log("INFO", `Storage limit enforcement: deleted ${deleted.length} files, freed space to under ${maxMb} MB`);
  }

  return deleted;
}

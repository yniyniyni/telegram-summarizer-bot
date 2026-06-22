import fs from 'fs';
import path from 'path';

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

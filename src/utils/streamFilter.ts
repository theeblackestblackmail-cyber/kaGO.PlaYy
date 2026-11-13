import type { StudioQueueItem } from '../types/audio';

const MIX_OR_PLAYLIST_RE =
  /\b(full\s*album|full\s*mix|dj\s*mix|dj\s*set|megamix|nonstop|non-stop|compilation|playlist|1\s*hour|2\s*hours|continuous\s*mix|mashup\s*mix|radio\s*show|podcast|episode\s*\d+)\b/i;

export function isIndividualSong(
  title: string,
  collectionName?: string,
  durationSeconds?: number
): boolean {
  if (!title || !title.trim()) return false;
  if (MIX_OR_PLAYLIST_RE.test(title)) return false;
  if (collectionName && /\b(dj\s*mix|continuous\s*mix|podcast)\b/i.test(collectionName)) {
    return false;
  }
  // Exclude long mixes (> 15 minutes)
  if (typeof durationSeconds === 'number' && durationSeconds > 900) {
    return false;
  }
  return true;
}

export function sortStudioQueue(items: StudioQueueItem[]): StudioQueueItem[] {
  return [...items].sort((a, b) => {
    if (b.upvotes !== a.upvotes) {
      return b.upvotes - a.upvotes;
    }
    return a.addedAt - b.addedAt;
  });
}

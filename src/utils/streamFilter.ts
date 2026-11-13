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
  // Exclude 30s preview clips (< 45s) and long mixes (> 15 minutes)
  if (typeof durationSeconds === 'number' && (durationSeconds < 45 || durationSeconds > 900)) {
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

export function parseYouTubeDuration(text?: string): number {
  if (!text) return 0;
  const cleaned = text.trim();
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(cleaned)) return 0;
  const parts = cleaned.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

export function parseYouTubeArtistAndTitle(
  rawTitle: string,
  channelName: string
): { artist: string; title: string } {
  const cleanChannel = channelName.replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube Audio';
  const stripped = rawTitle
    .replace(/\s*[\[(](official\s*(music\s*)?(video|audio|lyric\s*video)|lyrics?|hq|4k|hd|visualizer|audio\s*only)[\])]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dashMatch = stripped.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch && dashMatch[1].trim().length >= 2 && dashMatch[2].trim().length >= 2) {
    return {
      artist: dashMatch[1].trim(),
      title: dashMatch[2].trim(),
    };
  }

  return {
    artist: cleanChannel,
    title: stripped || rawTitle.trim(),
  };
}

export interface ParsedYouTubeVideo {
  videoId: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string;
}

interface YouTubeTextRun {
  text?: string;
}

interface YouTubeVideoRenderer {
  videoId?: string;
  title?: { runs?: YouTubeTextRun[]; simpleText?: string };
  ownerText?: { runs?: YouTubeTextRun[] };
  shortBylineText?: { runs?: YouTubeTextRun[] };
  lengthText?: { simpleText?: string };
}

export function extractYouTubeSearchResults(html: string): ParsedYouTubeVideo[] {
  const match =
    html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/) ||
    html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (!match) return [];

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return [];
  }

  const contents = (
    data as {
      contents?: {
        twoColumnSearchResultsRenderer?: {
          primaryContents?: {
            sectionListRenderer?: {
              contents?: Array<{
                itemSectionRenderer?: {
                  contents?: Array<{ videoRenderer?: YouTubeVideoRenderer }>;
                };
              }>;
            };
          };
        };
      };
    }
  )?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;

  if (!Array.isArray(contents)) return [];

  const seenIds = new Set<string>();
  const results: ParsedYouTubeVideo[] = [];

  for (const section of contents) {
    const items = section?.itemSectionRenderer?.contents;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const v = item?.videoRenderer;
      if (!v?.videoId || seenIds.has(v.videoId)) continue;

      const rawTitle =
        v.title?.runs?.map((r) => r.text || '').join('') || v.title?.simpleText || '';
      const channelName =
        v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
      const durationSeconds = parseYouTubeDuration(v.lengthText?.simpleText);

      if (!rawTitle || durationSeconds <= 0) continue;
      if (!isIndividualSong(rawTitle, channelName, durationSeconds)) continue;

      const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
      if (!isIndividualSong(title, artist, durationSeconds)) continue;

      seenIds.add(v.videoId);
      results.push({
        videoId: v.videoId,
        title,
        artist,
        durationSeconds,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      });
    }
  }

  return results;
}

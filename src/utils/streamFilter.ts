import type { StudioQueueItem, Track } from '../types/audio';

const MIX_OR_PLAYLIST_RE =
  /\b(full\s*album|full\s*mix|dj\s*mix|dj\s*set|megamix|nonstop|non-stop|compilation|playlist|1\s*hour|2\s*hours|continuous\s*mix|mashup\s*mix|radio\s*show|podcast|episode\s*\d+|tutorial|recreating|how\s+to\s+(make|produce)|reaction|track\s*breakdown)\b/i;

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
  longBylineText?: { runs?: YouTubeTextRun[] };
  lengthText?: { simpleText?: string };
}

function extractYtInitialDataJson(html: string): Record<string, unknown> | null {
  const match =
    html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/) ||
    html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractYouTubeSearchResults(html: string): ParsedYouTubeVideo[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

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

function collectCompactRenderers(node: unknown, out: YouTubeVideoRenderer[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) {
    for (const item of node) collectCompactRenderers(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.compactVideoRenderer && typeof obj.compactVideoRenderer === 'object') {
    out.push(obj.compactVideoRenderer as YouTubeVideoRenderer);
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      collectCompactRenderers(val, out, depth + 1);
    }
  }
}

export function extractYouTubeRelatedResults(
  html: string,
  excludeVideoId?: string
): ParsedYouTubeVideo[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

  const secondary = (
    data as {
      contents?: {
        twoColumnWatchNextResults?: {
          secondaryResults?: unknown;
        };
      };
    }
  )?.contents?.twoColumnWatchNextResults?.secondaryResults;

  if (!secondary) return [];

  const renderers: YouTubeVideoRenderer[] = [];
  collectCompactRenderers(secondary, renderers);

  const seenIds = new Set<string>(excludeVideoId ? [excludeVideoId] : []);
  const results: ParsedYouTubeVideo[] = [];

  for (const v of renderers) {
    if (!v.videoId || seenIds.has(v.videoId)) continue;

    const rawTitle =
      v.title?.simpleText || v.title?.runs?.map((r) => r.text || '').join('') || '';
    const channelName =
      v.shortBylineText?.runs?.[0]?.text ||
      v.longBylineText?.runs?.[0]?.text ||
      v.ownerText?.runs?.[0]?.text ||
      '';
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

  return results;
}

export function buildRadioSeedQuery(track: Pick<Track, 'title' | 'artist' | 'genre'>): string {
  const cleanArtist = (track.artist || '')
    .replace(/\b(youTube\s*audio|official|topic|vevo)\b/gi, '')
    .trim();
  const cleanGenre =
    track.genre && track.genre.toLowerCase() !== 'youtube' && track.genre.toLowerCase() !== 'stream'
      ? track.genre.trim()
      : '';

  if (cleanArtist && cleanGenre) {
    return `${cleanArtist} ${cleanGenre} songs`;
  }
  if (cleanArtist) {
    return `${cleanArtist} similar songs music`;
  }
  if (cleanGenre) {
    return `${cleanGenre} popular songs`;
  }
  return `${track.title} similar songs`;
}

export function mergeAutoplayQueue(
  existingQueue: Track[],
  currentTrack: Track,
  relatedTracks: Track[],
  options: { replaceExistingAuto?: boolean; maxAutoTracks?: number } = {}
): Track[] {
  const { replaceExistingAuto = true, maxAutoTracks = 10 } = options;

  const baseQueue = existingQueue.filter((item) => {
    if (item.id === currentTrack.id) return true;
    if (replaceExistingAuto && item.autoQueued) return false;
    return true;
  });

  if (!baseQueue.some((item) => item.id === currentTrack.id)) {
    baseQueue.unshift(currentTrack);
  }

  const seenIds = new Set(baseQueue.map((item) => item.id));
  const seenYoutubeIds = new Set(
    baseQueue.map((item) => item.youtubeId).filter((id): id is string => Boolean(id))
  );

  const additions: Track[] = [];
  for (const candidate of relatedTracks) {
    if (additions.length >= maxAutoTracks) break;
    if (seenIds.has(candidate.id)) continue;
    if (candidate.youtubeId && seenYoutubeIds.has(candidate.youtubeId)) continue;

    seenIds.add(candidate.id);
    if (candidate.youtubeId) seenYoutubeIds.add(candidate.youtubeId);
    additions.push({ ...candidate, autoQueued: true });
  }

  return [...baseQueue, ...additions];
}

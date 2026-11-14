import type { Track } from '../types/audio';
import { formatLrcTimestamp, parseLrc } from './lrcParser';
import { hasNativeHttpBridge, nativeFetchText } from './nativeMediaBridge';

export interface LrclibCandidate {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

export interface FetchedLyricsResult {
  rawLrc: string;
  synced: boolean;
  estimated?: boolean;
  sourceLabel: string;
}

const IGNORED_ARTIST_LABELS = new Set([
  'unknown artist',
  'youtube music',
  'youtube audio',
  'kago synth engine',
  'audius artist',
  'various artists',
]);

export function sanitizeTrackForLyrics(
  rawTitle: string,
  rawArtist: string
): {
  trackName: string;
  artistName: string;
  searchQuery: string;
} {
  let title = (rawTitle || '')
    .replace(/\[(?:official|lyrics?|audio|hd|4k|8k|mv|visualizer|music video|explicit|dirty|clean)[^\]]*\]/gi, '')
    .replace(/\((?:official|lyrics?|lyric video|official video|official audio|official music video|audio|visualizer|hd|4k|explicit|clean|live)[^)]*\)/gi, '')
    .replace(/\((?:feat\.?|ft\.?|featuring)\s+[^)]+\)/gi, '')
    .replace(/\[(?:feat\.?|ft\.?|featuring)\s+[^\]]+\]/gi, '')
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b.+$/i, '')
    .replace(/\b\d{2,6}\b(?=\s*$)/g, '')
    .replace(/\bmp3\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  let artist = (rawArtist || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\bOfficial\b/gi, '')
    .split(/,|&|\b(?:feat\.?|ft\.?|x)\b/i)[0]
    .replace(/\s+/g, ' ')
    .trim();

  if (IGNORED_ARTIST_LABELS.has(artist.toLowerCase())) {
    artist = '';
  }

  // Handle "Artist - Song Title" still embedded inside title
  if (!artist && title.includes(' - ')) {
    const parts = title.split(' - ');
    if (parts[0]?.trim() && parts[1]?.trim()) {
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }
  }

  const searchQuery = [artist, title].filter(Boolean).join(' ').trim();
  return {
    trackName: title || rawTitle.trim(),
    artistName: artist,
    searchQuery,
  };
}

export function convertPlainLyricsToLrc(
  plainLyrics: string,
  durationSeconds = 180
): string {
  const lines = (plainLyrics || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return '';

  const safeDuration = Math.max(45, Math.min(900, durationSeconds || 180));
  const introOffset = Math.min(8, Math.max(2, safeDuration * 0.04));
  const usableWindow = Math.max(25, safeDuration - introOffset - 6);
  const step = lines.length > 1 ? usableWindow / lines.length : 0;

  return lines
    .map((text, idx) => {
      const t = introOffset + idx * step;
      return `${formatLrcTimestamp(t)} ${text}`;
    })
    .join('\n');
}

export function pickBestLrclibCandidate(
  items: LrclibCandidate[],
  targetDurationSeconds = 0
): LrclibCandidate | null {
  if (!Array.isArray(items) || items.length === 0) return null;

  const valid = items.filter(
    (item) =>
      !item.instrumental &&
      ((item.syncedLyrics && parseLrc(item.syncedLyrics).length > 0) ||
        (item.plainLyrics && item.plainLyrics.trim().length > 12))
  );
  if (valid.length === 0) return null;

  const scored = valid.map((item) => {
    const hasSynced = Boolean(item.syncedLyrics && parseLrc(item.syncedLyrics).length >= 3);
    let score = hasSynced ? 1000 : 100;
    if (targetDurationSeconds > 0 && item.duration && item.duration > 0) {
      const diff = Math.abs(item.duration - targetDurationSeconds);
      score -= Math.min(200, diff * 3);
    }
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.item || null;
}

function toFetchedResult(
  candidate: LrclibCandidate,
  durationSeconds: number
): FetchedLyricsResult | null {
  if (candidate.syncedLyrics && parseLrc(candidate.syncedLyrics).length > 0) {
    return {
      rawLrc: candidate.syncedLyrics.trim(),
      synced: true,
      estimated: false,
      sourceLabel: 'LRCLIB Synced',
    };
  }
  if (candidate.plainLyrics && candidate.plainLyrics.trim()) {
    const estimatedLrc = convertPlainLyricsToLrc(candidate.plainLyrics, durationSeconds);
    if (estimatedLrc) {
      return {
        rawLrc: estimatedLrc,
        synced: false,
        estimated: true,
        sourceLabel: 'Estimated Timing',
      };
    }
  }
  return null;
}

async function fetchJsonViaDirectOrNative(url: string): Promise<unknown | null> {
  if (hasNativeHttpBridge()) {
    try {
      const nativeRes = await nativeFetchText(url, 7000);
      if (nativeRes?.ok && nativeRes.text) {
        return JSON.parse(nativeRes.text);
      }
    } catch {
      // Fall through to standard fetch
    }
  }

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Ignore CORS/network errors
  }

  return null;
}

export async function fetchSyncedLyricsForTrack(
  track: Pick<Track, 'title' | 'artist' | 'duration'>,
  overrideQuery?: string
): Promise<FetchedLyricsResult | null> {
  const { trackName, artistName, searchQuery } = sanitizeTrackForLyrics(track.title, track.artist);
  const query = (overrideQuery || searchQuery || track.title).trim();
  if (!query) return null;

  // 1. Try local Express backend /api/lyrics first (avoids browser CORS in web preview)
  try {
    const params = new URLSearchParams();
    params.set('title', overrideQuery ? overrideQuery : trackName);
    if (!overrideQuery && artistName) params.set('artist', artistName);
    if (track.duration > 0) params.set('duration', String(Math.round(track.duration)));
    params.set('q', query);

    const res = await fetch(`/api/lyrics?${params.toString()}`);
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json()) as {
        found?: boolean;
        rawLrc?: string;
        synced?: boolean;
        estimated?: boolean;
        sourceLabel?: string;
      };
      if (data.found && data.rawLrc) {
        return {
          rawLrc: data.rawLrc,
          synced: Boolean(data.synced),
          estimated: Boolean(data.estimated),
          sourceLabel: data.sourceLabel || (data.synced ? 'LRCLIB Synced' : 'Estimated Timing'),
        };
      }
    }
  } catch {
    // Static APK build has no /api server -> continue directly to LRCLIB
  }

  // 2. Try LRCLIB exact get (when we have both artist + clean title & no manual search override)
  if (!overrideQuery && artistName && trackName) {
    const getParams = new URLSearchParams({
      artist_name: artistName,
      track_name: trackName,
    });
    if (track.duration > 0) {
      getParams.set('duration', String(Math.round(track.duration)));
    }
    const exact = (await fetchJsonViaDirectOrNative(
      `https://lrclib.net/api/get?${getParams.toString()}`
    )) as LrclibCandidate | null;
    if (exact) {
      const converted = toFetchedResult(exact, track.duration);
      if (converted) return converted;
    }
  }

  // 3. Fallback to LRCLIB search endpoint
  const candidates = (await fetchJsonViaDirectOrNative(
    `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`
  )) as LrclibCandidate[] | null;

  if (Array.isArray(candidates) && candidates.length > 0) {
    const best = pickBestLrclibCandidate(candidates, track.duration);
    if (best) {
      const converted = toFetchedResult(best, track.duration);
      if (converted) return converted;
    }
  }

  return null;
}

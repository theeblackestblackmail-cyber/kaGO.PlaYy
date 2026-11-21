import { CURATED_STREAM_BANK } from '../data/presetsAndStems';
import type { Track } from '../types/audio';
import {
  hasNativeHttpBridge,
  hasNativeHttpPostBridge,
  nativeFetchText,
  nativePostJson,
} from './nativeMediaBridge';
import {
  buildInnertubeNextBody,
  buildRadioSeedQuery,
  extractYouTubeRelatedResults,
  isIndividualSong,
  toYouTubeTracks,
} from './streamFilter';
import { searchYouTubeNatively } from './streamSearch';

export async function fetchRelatedRadioTracks(
  seedTrack: Track,
  excludeTrackIds: string[] = []
): Promise<Track[]> {
  const excluded = new Set(excludeTrackIds);
  excluded.add(seedTrack.id);

  // 1. Try backend /api/stream/related (YouTube Watch Next + Artist/Title/Genre Radio)
  try {
    const params = new URLSearchParams();
    if (seedTrack.youtubeId) params.set('youtubeId', seedTrack.youtubeId);
    if (seedTrack.title) params.set('title', seedTrack.title);
    if (seedTrack.artist) params.set('artist', seedTrack.artist);
    if (seedTrack.genre) params.set('genre', seedTrack.genre);

    const res = await fetch(`/api/stream/related?${params.toString()}`);
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json()) as { results?: Track[] };
      const tracks = (data.results || [])
        .filter(
          (t) =>
            !excluded.has(t.id) &&
            (!seedTrack.youtubeId || t.youtubeId !== seedTrack.youtubeId) &&
            isIndividualSong(t.title, t.album, t.duration)
        )
        .map((t) => ({ ...t, autoQueued: true }));
      if (tracks.length > 0) {
        return tracks;
      }
    }
  } catch {
    // Fall through to native Android YouTube bridge / Audius fallback
  }

  // 2. Native Android APK YouTube Watch Next (/youtubei/v1/next + watch HTML) & Radio
  if (hasNativeHttpBridge()) {
    const collected: Track[] = [];
    const seenIds = new Set(excluded);

    if (seedTrack.youtubeId && hasNativeHttpPostBridge()) {
      const nextRes = await nativePostJson(
        'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
        buildInnertubeNextBody(seedTrack.youtubeId),
        8500
      );
      if (nextRes?.ok && nextRes.text) {
        const parsed = extractYouTubeRelatedResults(nextRes.text, seedTrack.youtubeId);
        for (const t of toYouTubeTracks(parsed, seedTrack.genre, {
          autoQueued: true,
          albumLabel: 'YouTube Radio Up Next',
        })) {
          if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            collected.push(t);
          }
        }
      }
    }

    if (seedTrack.youtubeId && collected.length < 4) {
      const watchRes = await nativeFetchText(
        `https://www.youtube.com/watch?v=${encodeURIComponent(seedTrack.youtubeId)}&gl=US&hl=en&persist_gl=1&persist_hl=1`,
        8500
      );
      if (watchRes?.ok && watchRes.text) {
        const parsed = extractYouTubeRelatedResults(watchRes.text, seedTrack.youtubeId);
        for (const t of toYouTubeTracks(parsed, seedTrack.genre, {
          autoQueued: true,
          albumLabel: 'YouTube Radio Up Next',
        })) {
          if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            collected.push(t);
          }
        }
      }
    }

    if (collected.length < 6) {
      const radioQuery = buildRadioSeedQuery(seedTrack);
      const nativeRelated = await searchYouTubeNatively(
        radioQuery,
        seedTrack.genre && seedTrack.genre !== 'YouTube' ? seedTrack.genre : '',
        'songs',
        seedTrack.youtubeId
      );
      for (const t of nativeRelated.tracks) {
        if (!seenIds.has(t.id)) {
          seenIds.add(t.id);
          collected.push({ ...t, autoQueued: true });
        }
      }
    }

    if (collected.length > 0) {
      return collected.slice(0, 12);
    }
  }

  // 3. Direct CORS-enabled Audius full-length related radio fallback
  try {
    const radioQuery = buildRadioSeedQuery(seedTrack);
    const aRes = await fetch(
      `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(radioQuery)}&limit=12`
    );
    if (aRes.ok) {
      const aJson = (await aRes.json()) as {
        data?: Array<{
          id?: string;
          title?: string;
          duration?: number;
          genre?: string;
          user?: { name?: string };
          artwork?: { '480x480'?: string; '150x150'?: string };
        }>;
      };
      const audiusTracks: Track[] = (aJson.data || [])
        .filter(
          (item) =>
            item.id &&
            item.title &&
            item.duration &&
            !excluded.has(`audius-${item.id}`) &&
            isIndividualSong(item.title, item.genre, item.duration)
        )
        .map((item) => ({
          id: `audius-${item.id}`,
          streamProvider: 'audius' as const,
          title: item.title!,
          artist: item.user?.name || 'Audius Artist',
          album: 'Audius Radio',
          duration: Math.round(item.duration!),
          source: 'stream' as const,
          artworkUrl: item.artwork?.['480x480'] || item.artwork?.['150x150'],
          streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(item.id!)}/stream`,
          genre: item.genre || seedTrack.genre || 'Radio',
          addedAt: Date.now(),
          autoQueued: true,
        }));
      if (audiusTracks.length > 0) {
        return audiusTracks;
      }
    }
  } catch {
    // Offline fallback below
  }

  // 4. Offline curated bank fallback matching specific genre only (never mix unrelated genres)
  const seedGenre = (seedTrack.genre || '').toLowerCase();
  if (seedGenre && !['youtube', 'stream', 'radio', 'local'].includes(seedGenre)) {
    const matched = CURATED_STREAM_BANK.filter(
      (t) => !excluded.has(t.id) && (t.genre || '').toLowerCase() === seedGenre
    );
    return matched.slice(0, 6).map((t) => ({ ...t, autoQueued: true }));
  }
  return [];
}

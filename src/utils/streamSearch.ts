import type { StreamArtistResult, StreamSearchCategory, Track } from '../types/audio';
import {
  hasNativeHttpBridge,
  hasNativeHttpPostBridge,
  nativeFetchText,
  nativePostJson,
} from './nativeMediaBridge';
import {
  analyzeTrackContentProfile,
  buildContentBasedQueries,
  deduplicateDiverseTracks,
  markSessionSeenSongs,
  rankContentBasedCandidates,
  readSessionSeenSongKeys,
  type TrackContentProfile,
} from './streamDiscovery';
import {
  buildCategorySearchPlan,
  buildInnertubeNextBody,
  buildInnertubeSearchBody,
  extractYouTubeArtists,
  extractYouTubeCollections,
  extractYouTubePodcasts,
  extractYouTubeRelatedResults,
  extractYouTubeSearchResults,
  filterMusicSuggestions,
  filterRelevantAudiusTracks,
  isIndividualSong,
  type ParsedYouTubeVideo,
  parseYouTubeSuggestResponse,
  rankYouTubeSearchResults,
  toYouTubeTracks,
} from './streamFilter';

export async function fetchMusicSuggestions(query: string): Promise<string[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  try {
    const res = await fetch(`/api/stream/suggest?q=${encodeURIComponent(trimmed)}`);
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json()) as { suggestions?: string[] };
      return filterMusicSuggestions(data.suggestions || [], trimmed);
    }
  } catch {
    // Fall through to native Android HTTP bridge
  }

  if (hasNativeHttpBridge()) {
    const nativeRes = await nativeFetchText(
      `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=us&q=${encodeURIComponent(
        trimmed
      )}`,
      4500
    );
    if (nativeRes?.ok && nativeRes.text) {
      return parseYouTubeSuggestResponse(nativeRes.text, trimmed);
    }
  }

  return [];
}

async function fetchNativeYouTubePayload(
  searchQuery: string,
  sp?: string
): Promise<string[]> {
  const payloads: string[] = [];

  if (hasNativeHttpPostBridge()) {
    const innertubeRes = await nativePostJson(
      'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
      buildInnertubeSearchBody(searchQuery, sp),
      9000
    );
    if (innertubeRes?.ok && innertubeRes.text && innertubeRes.text.trim().startsWith('{')) {
      payloads.push(innertubeRes.text);
    }
  }

  // Always allow HTML scrape when Innertube didn't respond (older bridge or POST blocked)
  if (payloads.length === 0 && hasNativeHttpBridge()) {
    const spParam = sp ? `&sp=${sp}` : '';
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
      searchQuery
    )}${spParam}&gl=US&hl=en&persist_gl=1&persist_hl=1`;
    const htmlRes = await nativeFetchText(ytUrl, 9500);
    if (htmlRes?.ok && htmlRes.text) {
      payloads.push(htmlRes.text);
    }
  }

  return payloads;
}

export async function searchYouTubeNatively(
  searchTerm: string,
  genreFilter = '',
  category: StreamSearchCategory = 'all',
  excludeId?: string
): Promise<{ tracks: Track[]; artists: StreamArtistResult[] }> {
  if (!hasNativeHttpBridge()) return { tracks: [], artists: [] };

  const plan = buildCategorySearchPlan(searchTerm, genreFilter, category);
  const payloads = await fetchNativeYouTubePayload(plan.searchQuery, plan.sp);

  // Also grab HTML fallback if Innertube returned zero parseable videos
  if (payloads.length > 0 && hasNativeHttpBridge()) {
    const checkCount = extractYouTubeSearchResults(payloads[0]).length;
    if (checkCount === 0 && category !== 'albums' && category !== 'playlists' && category !== 'featured_playlists') {
      const spParam = plan.sp ? `&sp=${plan.sp}` : '';
      const htmlRes = await nativeFetchText(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(
          plan.searchQuery
        )}${spParam}&gl=US&hl=en&persist_gl=1&persist_hl=1`,
        9500
      );
      if (htmlRes?.ok && htmlRes.text) {
        payloads.push(htmlRes.text);
      }
    }
  }

  const allArtists: StreamArtistResult[] = [];
  const seenArtists = new Set<string>();
  const addArtists = (list: StreamArtistResult[]) => {
    for (const a of list) {
      const k = a.name.toLowerCase();
      if (!seenArtists.has(k)) {
        seenArtists.add(k);
        allArtists.push(a);
      }
    }
  };

  for (const p of payloads) {
    addArtists(extractYouTubeArtists(p));
  }

  if (category === 'albums' || category === 'playlists' || category === 'featured_playlists') {
    for (const p of payloads) {
      const collections = extractYouTubeCollections(p, category, genreFilter);
      if (collections.length > 0) {
        return { tracks: collections, artists: allArtists };
      }
    }
    return { tracks: [], artists: allArtists };
  }

  if (category === 'podcasts') {
    for (const p of payloads) {
      const podcasts = extractYouTubePodcasts(p, genreFilter);
      if (podcasts.length > 0) {
        return { tracks: podcasts, artists: allArtists };
      }
    }
    return { tracks: [], artists: allArtists };
  }

  const mergedMap = new Map<string, ParsedYouTubeVideo>();
  const collectVideos = (raw: string) => {
    for (const v of extractYouTubeSearchResults(raw)) {
      if (excludeId && v.videoId === excludeId) continue;
      if (!mergedMap.has(v.videoId)) {
        mergedMap.set(v.videoId, v);
      }
    }
  };

  for (const p of payloads) {
    collectVideos(p);
  }

  // If category filter (`sp`) returned fewer than 3 tracks or 0 official tracks, retry clean organic search
  const hasOfficialYet = Array.from(mergedMap.values()).some(
    (v) => v.isOfficial || (v.viewCount || 0) >= 100_000
  );
  if ((mergedMap.size < 3 || !hasOfficialYet) && (plan.sp || plan.searchQuery !== searchTerm.trim())) {
    const organicQuery =
      [searchTerm.trim(), genreFilter ? `${genreFilter} music` : ''].filter(Boolean).join(' ') ||
      plan.searchQuery;
    const organicPayloads = await fetchNativeYouTubePayload(organicQuery, undefined);
    for (const p of organicPayloads) {
      addArtists(extractYouTubeArtists(p));
      collectVideos(p);
    }
  }

  const rankingTerm = searchTerm.trim() || plan.searchQuery;
  const ranked = rankYouTubeSearchResults(
    Array.from(mergedMap.values()),
    rankingTerm,
    category
  ).slice(0, 15);
  const tracks = toYouTubeTracks(ranked, genreFilter).map((t) => ({
    ...t,
    resultType: category === 'videos' ? ('video' as const) : ('song' as const),
  }));

  return { tracks, artists: allArtists };
}

export async function searchStreamsUnified(params: {
  query: string;
  genre?: string;
  category?: StreamSearchCategory;
}): Promise<{
  tracks: Track[];
  artists: StreamArtistResult[];
  source: 'live' | 'fallback';
  provider: 'youtube' | 'audius' | 'none';
}> {
  const cleanQ = params.query.trim();
  const genreFilter = (params.genre || '').trim();
  const category: StreamSearchCategory = params.category || 'all';
  const isCollectionOrPodcast =
    category === 'albums' ||
    category === 'playlists' ||
    category === 'featured_playlists' ||
    category === 'podcasts';

  let liveSongs: Track[] = [];
  let liveArtists: StreamArtistResult[] = [];
  let provider: 'youtube' | 'audius' | 'none' = 'none';
  let sourceFlag: 'live' | 'fallback' = 'live';

  // 1. Try server /api/stream/search (AI Studio / Web Node server)
  try {
    const qs = new URLSearchParams();
    if (cleanQ) qs.set('q', cleanQ);
    if (genreFilter) qs.set('genre', genreFilter);
    qs.set('category', category);

    const res = await fetch(`/api/stream/search?${qs.toString()}`);
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json()) as {
        results?: Track[];
        artists?: StreamArtistResult[];
        source?: string;
        provider?: string;
      };
      const rawResults = data.results || [];
      liveSongs = isCollectionOrPodcast
        ? rawResults
        : rawResults.filter((t) => isIndividualSong(t.title, t.album, t.duration));
      liveArtists = Array.isArray(data.artists) ? data.artists : [];
      sourceFlag = data.source === 'fallback' ? 'fallback' : 'live';
      if (data.provider === 'youtube' || data.provider === 'audius') {
        provider = data.provider;
      }
    }
  } catch {
    // Fall through to native APK YouTube search
  }

  // 2. Android APK native YouTube Innertube + HTML search bridge
  if (liveSongs.length === 0 && liveArtists.length === 0 && hasNativeHttpBridge()) {
    const nativeOut = await searchYouTubeNatively(cleanQ, genreFilter, category);
    liveSongs = nativeOut.tracks;
    liveArtists = nativeOut.artists;
    if (liveSongs.length > 0 || liveArtists.length > 0) {
      sourceFlag = 'live';
      provider = 'youtube';
    }
  }

  // 3. Last-resort CORS Audius fallback (only when YouTube is unreachable, filtered by query relevance)
  if (liveSongs.length === 0 && category !== 'artists') {
    try {
      const audiusQ = [cleanQ, genreFilter].filter(Boolean).join(' ') || 'synthwave';
      const aRes = await fetch(
        `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(audiusQ)}&limit=12`
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
        const rawAudius: Track[] = (aJson.data || [])
          .filter(
            (item) =>
              item.id &&
              item.title &&
              item.duration &&
              isIndividualSong(item.title, item.genre, item.duration)
          )
          .map((item) => ({
            id: `audius-${item.id}`,
            streamProvider: 'audius' as const,
            title: item.title!,
            artist: item.user?.name || 'Audius Artist',
            album: 'Audius Full Stream',
            duration: Math.round(item.duration!),
            source: 'stream' as const,
            artworkUrl: item.artwork?.['480x480'] || item.artwork?.['150x150'],
            streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(item.id!)}/stream`,
            genre: item.genre || genreFilter || 'Stream',
            addedAt: Date.now(),
          }));

        liveSongs = cleanQ ? filterRelevantAudiusTracks(rawAudius, cleanQ) : rawAudius;
        if (liveSongs.length > 0) {
          provider = 'audius';
          sourceFlag = 'live';
        }
      }
    } catch {
      // Offline / Audius unreachable
    }
  }

  // Derive artist cards from official song results if Artists tab yielded no dedicated channel cards
  if (category === 'artists' && liveArtists.length === 0 && liveSongs.length > 0) {
    const seenNames = new Set<string>();
    for (const t of liveSongs) {
      const key = t.artist.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      liveArtists.push({
        id: `derived-${key}`,
        name: t.artist,
        thumbnailUrl: t.artworkUrl,
        subscriberText: 'Artists',
        isOfficial: t.isOfficial,
      });
    }
  }

  return {
    tracks: liveSongs,
    artists: liveArtists,
    source: liveSongs.length > 0 || liveArtists.length > 0 ? sourceFlag : 'fallback',
    provider,
  };
}

async function fetchRelatedApiCandidates(seedTrack: Track): Promise<Track[]> {
  // 1. Server /api/stream/related (YouTube Watch Next + Radio)
  try {
    const qs = new URLSearchParams();
    if (seedTrack.youtubeId) qs.set('youtubeId', seedTrack.youtubeId);
    if (seedTrack.title) qs.set('title', seedTrack.title);
    if (seedTrack.artist) qs.set('artist', seedTrack.artist);
    if (seedTrack.genre) qs.set('genre', seedTrack.genre);

    const res = await fetch(`/api/stream/related?${qs.toString()}`);
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json()) as { results?: Track[] };
      const valid = (data.results || []).filter((t) =>
        isIndividualSong(t.title, t.album, t.duration)
      );
      if (valid.length > 0) return valid;
    }
  } catch {
    // Fall through to native bridge
  }

  // 2. Native Android APK Watch Next fallback
  if (seedTrack.youtubeId && hasNativeHttpBridge() && hasNativeHttpPostBridge()) {
    try {
      const nextRes = await nativePostJson(
        'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
        buildInnertubeNextBody(seedTrack.youtubeId),
        8000
      );
      if (nextRes?.ok && nextRes.text) {
        const parsed = extractYouTubeRelatedResults(nextRes.text, seedTrack.youtubeId);
        return toYouTubeTracks(parsed, seedTrack.genre, {
          albumLabel: 'Recommended Radio',
        });
      }
    } catch {
      // Ignore native bridge error
    }
  }

  return [];
}

export async function fetchDiverseDiscoveryFeed(params: {
  visitSeed: number;
  currentTrack?: Track | null;
  genre?: string;
  category?: StreamSearchCategory;
  previousSeeds?: readonly string[];
  previousFeedQuery?: string;
  targetCount?: number;
  sessionSeenStorageKey?: string;
}): Promise<{
  tracks: Track[];
  artists: StreamArtistResult[];
  source: 'live' | 'fallback';
  usedSeeds: string[];
  usedFeedQuery: string;
  profile: TrackContentProfile | null;
}> {
  const genre = (params.genre || '').trim();
  const category: StreamSearchCategory = params.category || 'all';
  const targetCount = params.targetCount ?? 12;
  const sessionKey = params.sessionSeenStorageKey || 'kago_session_seen_songs';

  const profile = analyzeTrackContentProfile(params.currentTrack, genre);
  const effectiveGenre = genre || profile?.resolvedGenre || '';
  const seenSongKeys = readSessionSeenSongKeys(sessionKey);

  const { seeds, broadQuery } = buildContentBasedQueries(
    profile,
    params.visitSeed,
    params.previousSeeds || [],
    params.previousFeedQuery,
    genre
  );

  const isCollectionOrPodcast =
    category === 'albums' ||
    category === 'playlists' ||
    category === 'featured_playlists' ||
    category === 'podcasts';

  if (isCollectionOrPodcast || category === 'artists') {
    const res = await searchStreamsUnified({
      query: broadQuery,
      genre: effectiveGenre,
      category,
    });
    const uniqueCollections = deduplicateDiverseTracks(
      res.tracks.filter((t) => {
        if (!profile) return true;
        return t.id !== profile.trackId;
      }),
      {
        maxPerSong: 1,
        maxPerArtist: 2,
        maxResults: targetCount,
      }
    );
    return {
      tracks: uniqueCollections,
      artists: res.artists,
      source: res.source,
      usedSeeds: [],
      usedFeedQuery: broadQuery,
      profile,
    };
  }

  const queryCategory: StreamSearchCategory = category === 'videos' ? 'videos' : 'songs';

  const relatedPromise: Promise<Track[]> =
    params.currentTrack && category !== 'videos'
      ? fetchRelatedApiCandidates(params.currentTrack)
      : Promise.resolve([]);

  const [relatedSettled, broadResult, ...seedResults] = await Promise.allSettled([
    relatedPromise,
    searchStreamsUnified({
      query: broadQuery,
      genre: effectiveGenre,
      category,
    }),
    ...seeds.map((seedQuery) =>
      searchStreamsUnified({
        query: seedQuery,
        genre: effectiveGenre,
        category: queryCategory,
      })
    ),
  ]);

  const collectedTracks: Track[] = [];
  const collectedArtists: StreamArtistResult[] = [];
  const seenArtists = new Set<string>();
  let anyLive = false;

  // 1. Add content-matched Watch Next / related API results from currentTrack metadata
  if (relatedSettled.status === 'fulfilled' && relatedSettled.value.length > 0) {
    anyLive = true;
    collectedTracks.push(...relatedSettled.value);
  }

  // 2. From each distinct content-based seed query, pick up to 2 top non-duplicate tracks
  for (const settled of seedResults) {
    if (settled.status !== 'fulfilled') continue;
    const val = settled.value;
    if (val.source === 'live' && val.tracks.length > 0) anyLive = true;
    if (val.tracks.length > 0) {
      collectedTracks.push(...val.tracks.slice(0, 2));
    }
    for (const a of val.artists) {
      const k = a.name.toLowerCase();
      if (!seenArtists.has(k)) {
        seenArtists.add(k);
        collectedArtists.push(a);
      }
    }
  }

  // 3. Append broad multi-artist chart/genre search matches
  if (broadResult.status === 'fulfilled') {
    const val = broadResult.value;
    if (val.source === 'live' && val.tracks.length > 0) anyLive = true;
    collectedTracks.push(...val.tracks);
    for (const a of val.artists) {
      const k = a.name.toLowerCase();
      if (!seenArtists.has(k)) {
        seenArtists.add(k);
        collectedArtists.push(a);
      }
    }
  }

  // Score by content similarity + novelty (unseen this session), then enforce 1 song / 1 artist
  const rankedTracks = rankContentBasedCandidates(collectedTracks, profile, {
    seenSongKeys,
    visitSeed: params.visitSeed,
    maxResults: targetCount,
  });

  if (rankedTracks.length > 0) {
    markSessionSeenSongs(rankedTracks, sessionKey);
  }

  return {
    tracks: rankedTracks,
    artists: collectedArtists,
    source: anyLive && rankedTracks.length > 0 ? 'live' : 'fallback',
    usedSeeds: seeds,
    usedFeedQuery: broadQuery,
    profile,
  };
}


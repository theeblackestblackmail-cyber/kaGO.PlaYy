import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  buildCategorySearchPlan,
  buildInnertubeBrowseBody,
  buildInnertubeNextBody,
  buildInnertubeSearchBody,
  buildRadioSeedQuery,
  extractYouTubeArtists,
  extractYouTubeCollections,
  extractYouTubePlaylistInfo,
  extractYouTubePodcasts,
  extractYouTubeRelatedResults,
  extractYouTubeSearchResults,
  filterRelevantAudiusTracks,
  isIndividualSong,
  parseYouTubeSuggestResponse,
  rankYouTubeSearchResults,
  sortStudioQueue,
  toYouTubeTracks,
  type ParsedYouTubeVideo,
} from './src/utils/streamFilter';
import {
  convertPlainLyricsToLrc,
  pickBestLrclibCandidate,
  sanitizeTrackForLyrics,
  type LrclibCandidate,
} from './src/utils/lyricsFetcher';
import type {
  StreamArtistResult,
  StreamSearchCategory,
  StudioChatMessage,
  StudioPlaybackState,
  StudioQueueItem,
  StudioRoomState,
  StudioUser,
  Track,
} from './src/types/audio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

interface ClientSession {
  id: string;
  name: string;
  joinedAt: number;
  ws: WebSocket;
}

const clients = new Map<string, ClientSession>();

const initialStemTrack: Track = {
  id: 'stem-cyber-resonance',
  title: 'Cyber Resonance',
  artist: 'kaGO Synth Engine',
  album: 'Offline Stems Vol. 01',
  duration: 180,
  source: 'synth',
  genre: 'Electronic',
  bpm: 110,
  rootFreq: 55,
  addedAt: Date.now(),
  synthProfile: {
    bpm: 110,
    rootFreq: 55,
    scale: [0, 3, 7, 10, 12, 15],
    patternStyle: 'cyber',
    description: '110 BPM industrial pulse bass with crisp rimshots and dark resonant synth pads.',
  },
};

let studioQueue: StudioQueueItem[] = [
  {
    id: 'studio-seed-1',
    track: initialStemTrack,
    addedBy: 'Studio Rack',
    addedAt: Date.now(),
    upvotes: 1,
    voterIds: ['studio-rack'],
  },
];

let studioNowPlaying: StudioPlaybackState | null = null;

let studioMessages: StudioChatMessage[] = [
  {
    id: 'msg-welcome',
    userId: 'system',
    userName: 'Studio Rack',
    text: 'Shared Live Studio connected. Add tracks to the shared queue, upvote favorites, or chat live.',
    timestamp: Date.now(),
    type: 'system',
  },
];

function getPublicUsers(): StudioUser[] {
  return Array.from(clients.values()).map(({ id, name, joinedAt }) => ({
    id,
    name,
    joinedAt,
  }));
}

function getRoomState(): StudioRoomState {
  const users = getPublicUsers();
  return {
    userCount: users.length,
    users,
    queue: sortStudioQueue(studioQueue),
    nowPlaying: studioNowPlaying,
    messages: studioMessages.slice(-80),
  };
}

function broadcast(payload: unknown) {
  const serialized = JSON.stringify(payload);
  for (const session of clients.values()) {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(serialized);
    }
  }
}

function appendSystemMessage(text: string) {
  const msg: StudioChatMessage = {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: 'system',
    userName: 'Studio Rack',
    text,
    timestamp: Date.now(),
    type: 'system',
  };
  studioMessages = [...studioMessages.slice(-79), msg];
  broadcast({ type: 'studio:chat_message', message: msg });
}

interface AudiusTrack {
  id?: string;
  title?: string;
  duration?: number;
  genre?: string;
  user?: { name?: string };
  artwork?: { '480x480'?: string; '150x150'?: string };
}

const YT_COOKIE_HEADER =
  'SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwODE0LjA3X3AwGgJlbiACGgYIgJnPsgY; PREF=hl=en&gl=US&f6=8';

async function fetchYouTubeSearchPayload(
  searchQuery: string,
  sp?: string
): Promise<string[]> {
  const payloads: string[] = [];

  try {
    const innertubeRes = await fetch(
      'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
      {
        method: 'POST',
        signal: AbortSignal.timeout(6500),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://www.youtube.com',
          Referer: 'https://www.youtube.com/',
          Cookie: YT_COOKIE_HEADER,
        },
        body: buildInnertubeSearchBody(searchQuery, sp),
      }
    );
    if (innertubeRes.ok) {
      const jsonText = await innertubeRes.text();
      if (jsonText.trim().startsWith('{')) {
        payloads.push(jsonText);
      }
    }
  } catch {
    // Fall back to HTML scrape
  }

  if (payloads.length === 0) {
    try {
      const spParam = sp ? `&sp=${sp}` : '';
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(
        searchQuery
      )}${spParam}&gl=US&hl=en&persist_gl=1&persist_hl=1`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(7000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: YT_COOKIE_HEADER,
        },
      });
      if (response.ok) {
        payloads.push(await response.text());
      }
    } catch {
      // Unreachable
    }
  }

  return payloads;
}

async function searchYouTubeCategory(
  rawQuery: string,
  genre = '',
  category: StreamSearchCategory = 'all',
  excludeYoutubeId?: string
): Promise<{ tracks: Track[]; artists: StreamArtistResult[] }> {
  try {
    const plan = buildCategorySearchPlan(rawQuery, genre, category);
    const payloads = await fetchYouTubeSearchPayload(plan.searchQuery, plan.sp);

    const allArtists: StreamArtistResult[] = [];
    const seenArtists = new Set<string>();
    const addArtists = (list: StreamArtistResult[]) => {
      for (const a of list) {
        const key = a.name.toLowerCase();
        if (!seenArtists.has(key)) {
          seenArtists.add(key);
          allArtists.push(a);
        }
      }
    };

    for (const p of payloads) {
      addArtists(extractYouTubeArtists(p));
    }

    if (category === 'albums' || category === 'playlists' || category === 'featured_playlists') {
      for (const p of payloads) {
        const collections = extractYouTubeCollections(p, category, genre);
        if (collections.length > 0) return { tracks: collections, artists: allArtists };
      }
      return { tracks: [], artists: allArtists };
    }

    if (category === 'podcasts') {
      for (const p of payloads) {
        const podcasts = extractYouTubePodcasts(p, genre);
        if (podcasts.length > 0) return { tracks: podcasts, artists: allArtists };
      }
      return { tracks: [], artists: allArtists };
    }

    const mergedMap = new Map<string, ParsedYouTubeVideo>();
    const collectVideos = (raw: string) => {
      for (const item of extractYouTubeSearchResults(raw)) {
        if (excludeYoutubeId && item.videoId === excludeYoutubeId) continue;
        if (!mergedMap.has(item.videoId)) {
          mergedMap.set(item.videoId, item);
        }
      }
    };
    for (const p of payloads) {
      collectVideos(p);
    }

    const hasOfficialYet = Array.from(mergedMap.values()).some(
      (v) => v.isOfficial || (v.viewCount || 0) >= 100_000
    );
    if ((mergedMap.size < 3 || !hasOfficialYet) && (plan.sp || plan.searchQuery !== rawQuery.trim())) {
      const organicQuery =
        [rawQuery.trim(), genre ? `${genre} music` : ''].filter(Boolean).join(' ') ||
        plan.searchQuery;
      const organicPayloads = await fetchYouTubeSearchPayload(organicQuery, undefined);
      for (const p of organicPayloads) {
        addArtists(extractYouTubeArtists(p));
        collectVideos(p);
      }
    }

    const rankingQuery = rawQuery.trim() || plan.searchQuery;
    const ranked = rankYouTubeSearchResults(
      Array.from(mergedMap.values()),
      rankingQuery,
      category
    ).slice(0, 15);
    const tracks = toYouTubeTracks(ranked, genre).map((t) => ({
      ...t,
      resultType: category === 'videos' ? ('video' as const) : ('song' as const),
    }));

    return { tracks, artists: allArtists };
  } catch {
    return { tracks: [], artists: [] };
  }
}

async function searchYouTubeTracks(
  term: string,
  genre?: string,
  excludeYoutubeId?: string
): Promise<Track[]> {
  const { tracks } = await searchYouTubeCategory(term, genre || '', 'all', excludeYoutubeId);
  return tracks;
}

async function fetchYouTubeWatchRelated(youtubeId: string, genre?: string): Promise<Track[]> {
  try {
    const nextRes = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      signal: AbortSignal.timeout(6500),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://www.youtube.com',
        Referer: `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`,
        Cookie: YT_COOKIE_HEADER,
      },
      body: buildInnertubeNextBody(youtubeId),
    });
    if (nextRes.ok) {
      const jsonText = await nextRes.text();
      const parsed = extractYouTubeRelatedResults(jsonText, youtubeId).slice(0, 12);
      if (parsed.length > 0) {
        return toYouTubeTracks(parsed, genre, {
          autoQueued: true,
          albumLabel: 'YouTube Radio Up Next',
        });
      }
    }
  } catch {
    // Fall back to watch HTML scrape
  }

  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}&gl=US&hl=en&persist_gl=1&persist_hl=1`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6500),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: YT_COOKIE_HEADER,
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const parsed = extractYouTubeRelatedResults(html, youtubeId).slice(0, 12);
    return toYouTubeTracks(parsed, genre, {
      autoQueued: true,
      albumLabel: 'YouTube Radio Up Next',
    });
  } catch {
    return [];
  }
}

async function searchAudiusTracks(term: string, genre?: string): Promise<Track[]> {
  try {
    const url = `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(
      term
    )}&limit=12`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(4500),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { data?: AudiusTrack[] };
    const results: Track[] = [];

    for (const item of data.data || []) {
      if (!item.id || !item.title || !item.duration) continue;
      if (!isIndividualSong(item.title, item.genre, item.duration)) continue;
      results.push({
        id: `audius-${item.id}`,
        streamProvider: 'audius',
        title: item.title,
        artist: item.user?.name || 'Audius Artist',
        album: 'Audius Full Stream',
        duration: Math.round(item.duration),
        source: 'stream',
        artworkUrl: item.artwork?.['480x480'] || item.artwork?.['150x150'],
        streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(item.id)}/stream`,
        genre: item.genre || genre || 'Stream',
        addedAt: Date.now(),
      });
    }
    return results.slice(0, 12);
  } catch {
    return [];
  }
}

function isAllowedProxyHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '0.0.0.0' ||
    lower.startsWith('10.') ||
    lower.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(lower)
  ) {
    return false;
  }
  const allowedSuffixes = [
    'audius.co',
    'audius.org',
    'audiusrules.com',
    'mzstatic.com',
    'apple.com',
  ];
  return allowedSuffixes.some(
    (host) => lower === host || lower.endsWith(`.${host}`)
  );
}

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, studioListeners: clients.size });
  });

  app.get('/api/stream/suggest', async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) {
      return res.json({ suggestions: [] });
    }
    try {
      const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=us&q=${encodeURIComponent(
        query
      )}`;
      const upstream = await fetch(suggestUrl, {
        signal: AbortSignal.timeout(3500),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        },
      });
      if (!upstream.ok) return res.json({ suggestions: [] });
      const raw = await upstream.text();
      return res.json({ suggestions: parseYouTubeSuggestResponse(raw, query) });
    } catch {
      return res.json({ suggestions: [] });
    }
  });

  app.get('/api/lyrics', async (req, res) => {
    const rawTitle = String(req.query.title || '').trim();
    const rawArtist = String(req.query.artist || '').trim();
    const duration = Number(req.query.duration || 0) || 180;
    const rawQuery = String(req.query.q || '').trim();
    const { trackName, artistName, searchQuery } = sanitizeTrackForLyrics(rawTitle, rawArtist);
    const query = (rawQuery || searchQuery || rawTitle).trim();

    if (!query) {
      return res.json({ found: false });
    }

    const headers = {
      'User-Agent': 'kaGO.PIaY/1.0 (https://github.com/kagoplay)',
      Accept: 'application/json',
    };

    try {
      if (!rawQuery && artistName && trackName) {
        const getParams = new URLSearchParams({
          artist_name: artistName,
          track_name: trackName,
        });
        if (duration > 0) getParams.set('duration', String(Math.round(duration)));

        const exactRes = await fetch(`https://lrclib.net/api/get?${getParams.toString()}`, {
          signal: AbortSignal.timeout(5000),
          headers,
        });
        if (exactRes.ok) {
          const item = (await exactRes.json()) as LrclibCandidate;
          if (item.syncedLyrics?.trim()) {
            return res.json({
              found: true,
              rawLrc: item.syncedLyrics.trim(),
              synced: true,
              estimated: false,
              sourceLabel: 'LRCLIB Synced',
            });
          }
          if (item.plainLyrics?.trim()) {
            const estimatedLrc = convertPlainLyricsToLrc(item.plainLyrics, duration);
            if (estimatedLrc) {
              return res.json({
                found: true,
                rawLrc: estimatedLrc,
                synced: false,
                estimated: true,
                sourceLabel: 'Estimated Timing',
              });
            }
          }
        }
      }

      const searchRes = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
        {
          signal: AbortSignal.timeout(5500),
          headers,
        }
      );
      if (searchRes.ok) {
        const candidates = (await searchRes.json()) as LrclibCandidate[];
        const best = pickBestLrclibCandidate(candidates, duration);
        if (best?.syncedLyrics?.trim()) {
          return res.json({
            found: true,
            rawLrc: best.syncedLyrics.trim(),
            synced: true,
            estimated: false,
            sourceLabel: 'LRCLIB Synced',
          });
        }
        if (best?.plainLyrics?.trim()) {
          const estimatedLrc = convertPlainLyricsToLrc(best.plainLyrics, duration);
          if (estimatedLrc) {
            return res.json({
              found: true,
              rawLrc: estimatedLrc,
              synced: false,
              estimated: true,
              sourceLabel: 'Estimated Timing',
            });
          }
        }
      }
    } catch {
      // Upstream timeout or unreachable
    }

    return res.json({ found: false });
  });

  app.get('/api/stream/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    const genre = String(req.query.genre || '').trim();
    const rawCat = String(req.query.category || 'all').trim() as StreamSearchCategory;
    const allowedCats: StreamSearchCategory[] = [
      'all',
      'songs',
      'videos',
      'albums',
      'artists',
      'playlists',
      'featured_playlists',
      'podcasts',
    ];
    const category: StreamSearchCategory = allowedCats.includes(rawCat) ? rawCat : 'all';

    const { tracks: ytResults, artists } = await searchYouTubeCategory(query, genre, category);
    if (ytResults.length > 0 || artists.length > 0) {
      return res.json({
        results: ytResults,
        artists,
        category,
        source: 'live',
        provider: 'youtube',
      });
    }

    const rawAudius = await searchAudiusTracks(
      [query, genre].filter(Boolean).join(' ') || 'synthwave',
      genre
    );
    const audiusResults = query ? filterRelevantAudiusTracks(rawAudius, query) : rawAudius;
    if (audiusResults.length > 0) {
      return res.json({
        results: audiusResults,
        artists: [],
        category,
        source: 'live',
        provider: 'audius',
      });
    }

    return res.json({ results: [], artists: [], category, source: 'fallback' });
  });

  app.get('/api/stream/playlist', async (req, res) => {
    const listId = String(req.query.list || '').trim();
    const title = String(req.query.title || 'YouTube Playlist').trim();
    if (!listId || !/^[a-zA-Z0-9_-]{8,}$/.test(listId)) {
      return res.json({ title, tracks: [] });
    }

    try {
      const browseRes = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
        method: 'POST',
        signal: AbortSignal.timeout(7000),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://www.youtube.com',
          Referer: 'https://www.youtube.com/',
          Cookie: YT_COOKIE_HEADER,
        },
        body: buildInnertubeBrowseBody(listId.startsWith('VL') ? listId : `VL${listId}`),
      });
      if (browseRes.ok) {
        const jsonText = await browseRes.text();
        const info = extractYouTubePlaylistInfo(jsonText, title);
        if (info.tracks.length > 0) {
          return res.json({ listId, title: info.title, tracks: info.tracks });
        }
      }
    } catch {
      // Fall back to playlist HTML page
    }

    try {
      const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&gl=US&hl=en&persist_gl=1&persist_hl=1`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(7000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: YT_COOKIE_HEADER,
        },
      });
      if (!response.ok) return res.json({ listId, title, tracks: [] });
      const html = await response.text();
      const info = extractYouTubePlaylistInfo(html, title);
      return res.json({ listId, title: info.title, tracks: info.tracks });
    } catch {
      return res.json({ listId, title, tracks: [] });
    }
  });

  app.get('/api/stream/related', async (req, res) => {
    const youtubeId = String(req.query.youtubeId || '').trim();
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const genre = String(req.query.genre || '').trim();

    const collected: Track[] = [];
    const seenIds = new Set<string>(youtubeId ? [`yt-${youtubeId}`] : []);

    if (youtubeId) {
      const watchNext = await fetchYouTubeWatchRelated(youtubeId, genre);
      for (const track of watchNext) {
        if (!seenIds.has(track.id)) {
          seenIds.add(track.id);
          collected.push(track);
        }
      }
    }

    if (collected.length < 6) {
      const seedQuery = buildRadioSeedQuery({ title: title || 'music', artist, genre });
      const searchRelated = await searchYouTubeTracks(seedQuery, genre, youtubeId);
      for (const track of searchRelated) {
        if (!seenIds.has(track.id)) {
          seenIds.add(track.id);
          collected.push({ ...track, autoQueued: true });
        }
      }
    }

    if (collected.length === 0) {
      const audiusQuery = buildRadioSeedQuery({ title: title || 'synthwave', artist, genre });
      const audiusRelated = await searchAudiusTracks(audiusQuery, genre);
      for (const track of audiusRelated) {
        if (!seenIds.has(track.id)) {
          seenIds.add(track.id);
          collected.push({ ...track, autoQueued: true });
        }
      }
    }

    return res.json({ results: collected.slice(0, 12), source: collected.length > 0 ? 'live' : 'fallback' });
  });

  app.get('/api/stream/recover', async (req, res) => {
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const genre = String(req.query.genre || '').trim();
    const excludeId = String(req.query.excludeId || '').trim();

    const recoveryQueries = [
      [artist, title, 'topic'].filter(Boolean).join(' '),
      [title, artist, 'lyrics'].filter(Boolean).join(' '),
    ].filter(Boolean);

    for (const q of recoveryQueries) {
      const ytCandidates = await searchYouTubeTracks(q, genre, excludeId);
      if (ytCandidates[0]?.youtubeId) {
        const alt = ytCandidates[0];
        return res.json({
          recovered: true,
          mode: 'alternate-youtube',
          youtubeId: alt.youtubeId,
          id: alt.id,
          duration: alt.duration,
          artworkUrl: alt.artworkUrl,
          recoveredFrom: `Alternate YouTube (${alt.youtubeId})`,
        });
      }
    }

    const audiusCandidates = await searchAudiusTracks([title, artist].filter(Boolean).join(' ') || genre || 'synthwave', genre);
    if (audiusCandidates[0]?.streamUrl) {
      const alt = audiusCandidates[0];
      return res.json({
        recovered: true,
        mode: 'alternate-stream',
        streamUrl: alt.streamUrl,
        duration: alt.duration,
        artworkUrl: alt.artworkUrl,
        recoveredFrom: 'Audius Full-Length Mirror',
      });
    }

    return res.json({
      recovered: true,
      mode: 'synth-stem',
      recoveredFrom: 'Local Synth Engine Fallback',
    });
  });

  app.get('/api/stream/proxy', async (req, res) => {
    const rawUrl = String(req.query.url || '');
    if (!rawUrl) {
      return res.status(400).send('Missing url');
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:' || !isAllowedProxyHost(parsed.hostname)) {
        return res.status(403).send('Host not permitted');
      }

      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(), 12000);
      const forwardHeaders: Record<string, string> = {};
      if (typeof req.headers.range === 'string' && req.headers.range) {
        forwardHeaders.Range = req.headers.range;
      }

      let upstream: Response;
      try {
        upstream = await fetch(parsed.toString(), {
          signal: connectCtrl.signal,
          redirect: 'follow',
          headers: forwardHeaders,
        });
      } finally {
        clearTimeout(connectTimer);
      }

      if ((!upstream.ok && upstream.status !== 206) || !upstream.body) {
        return res.status(upstream.status === 416 ? 416 : 502).send('Upstream error');
      }

      const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
      const contentLength = upstream.headers.get('content-length');
      const contentRange = upstream.headers.get('content-range');
      const acceptRanges = upstream.headers.get('accept-ranges') || 'bytes';

      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', acceptRanges);
      if (contentLength) res.setHeader('Content-Length', contentLength);
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const nodeStream = Readable.fromWeb(upstream.body as unknown as NodeReadableStream);
      const abortUpstream = () => {
        nodeStream.destroy();
      };
      req.on('close', abortUpstream);
      nodeStream.on('error', () => {
        if (!res.headersSent) {
          res.status(502).end('Stream interrupted');
        } else {
          res.end();
        }
      });
      return nodeStream.pipe(res);
    } catch {
      if (!res.headersSent) {
        return res.status(502).send('Proxy failed');
      }
      return res.end();
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const reqPath = (req.url || '').split('?')[0];
    if (reqPath === '/ws/studio') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws) => {
    const clientId = `listener-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const defaultName = `Producer ${Math.floor(100 + Math.random() * 900)}`;

    const session: ClientSession = {
      id: clientId,
      name: defaultName,
      joinedAt: Date.now(),
      ws,
    };
    clients.set(clientId, session);

    ws.send(
      JSON.stringify({
        type: 'studio:init',
        clientId,
        userName: session.name,
        state: getRoomState(),
      })
    );

    broadcast({
      type: 'studio:presence',
      userCount: clients.size,
      users: getPublicUsers(),
    });

    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          type: string;
          name?: string;
          track?: Track;
          itemId?: string;
          text?: string;
        };

        if (msg.type === 'studio:join' && msg.name) {
          const cleanName = msg.name.trim().slice(0, 28) || defaultName;
          session.name = cleanName;
          broadcast({
            type: 'studio:presence',
            userCount: clients.size,
            users: getPublicUsers(),
          });
        }

        if (msg.type === 'studio:add_track' && msg.track) {
          const exists = studioQueue.some((q) => q.track.id === msg.track!.id);
          if (!exists) {
            const newItem: StudioQueueItem = {
              id: `sq-${msg.track.id}-${Date.now().toString(36)}`,
              track: msg.track,
              addedBy: session.name,
              addedAt: Date.now(),
              upvotes: 1,
              voterIds: [session.id],
            };
            studioQueue = sortStudioQueue([...studioQueue, newItem]);
            broadcast({ type: 'studio:queue_updated', queue: studioQueue });
            appendSystemMessage(`${session.name} queued "${msg.track.title}"`);
          }
        }

        if (msg.type === 'studio:toggle_upvote' && msg.itemId) {
          studioQueue = sortStudioQueue(
            studioQueue.map((item) => {
              if (item.id !== msg.itemId) return item;
              const alreadyVoted = item.voterIds.includes(session.id);
              const voterIds = alreadyVoted
                ? item.voterIds.filter((id) => id !== session.id)
                : [...item.voterIds, session.id];
              return {
                ...item,
                voterIds,
                upvotes: voterIds.length,
              };
            })
          );
          broadcast({ type: 'studio:queue_updated', queue: studioQueue });
        }

        if (msg.type === 'studio:remove_track' && msg.itemId) {
          studioQueue = studioQueue.filter((item) => item.id !== msg.itemId);
          broadcast({ type: 'studio:queue_updated', queue: studioQueue });
        }

        if (msg.type === 'studio:play_track' && msg.track) {
          studioNowPlaying = {
            track: msg.track,
            startedAt: Date.now(),
            isPlaying: true,
            triggeredBy: session.name,
          };
          broadcast({ type: 'studio:playback_updated', nowPlaying: studioNowPlaying });
          appendSystemMessage(`${session.name} triggered playback: "${msg.track.title}"`);
        }

        if (msg.type === 'studio:chat' && msg.text) {
          const cleanText = msg.text.trim().slice(0, 320);
          if (!cleanText) return;
          const chatMsg: StudioChatMessage = {
            id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            userId: session.id,
            userName: session.name,
            text: cleanText,
            timestamp: Date.now(),
            type: 'chat',
          };
          studioMessages = [...studioMessages.slice(-79), chatMsg];
          broadcast({ type: 'studio:chat_message', message: chatMsg });
        }
      } catch {
        // Ignore malformed socket frames
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      broadcast({
        type: 'studio:presence',
        userCount: clients.size,
        users: getPublicUsers(),
      });
    });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: !disableHmr,
        ws: { server },
        watch: disableHmr ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`kaGO.PIaY server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

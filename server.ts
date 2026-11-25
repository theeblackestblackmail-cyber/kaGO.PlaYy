import express from 'express';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  isAllowedAudioMimeType,
  normalizeAudioMimeType,
  parseFunctionCallsToActions,
  sanitizeHttpUrl,
  type AiAssistantContextPayload,
  type AiAssistantHistoryItem,
  type AiAssistantSource,
} from './src/utils/aiAssistant';
import {
  buildCategorySearchPlan,
  buildInnertubeBrowseBody,
  buildInnertubeNextBody,
  buildInnertubePlaylistNextBody,
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
  DOWNLOAD_FORMAT_MAP,
  DOWNLOAD_FORMAT_OPTIONS,
  estimateFormatSizeBytes,
  pickVerifiedAudioMirrorCandidate,
  sanitizeDownloadFilename,
  type AudioMirrorCandidate,
  type DownloadFormatId,
} from './src/utils/streamDownloads';
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
        signal: AbortSignal.timeout(7500),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': '2.20250218.01.00',
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

  const shouldScrapeHtml =
    payloads.length === 0 ||
    extractYouTubeSearchResults(payloads[0], { strictSongFilter: false, includeShorts: true })
      .length === 0;

  if (shouldScrapeHtml) {
    try {
      const spParam = sp ? `&sp=${sp}` : '';
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(
        searchQuery
      )}${spParam}&gl=US&hl=en&persist_gl=1&persist_hl=1`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(7500),
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
      for (const item of extractYouTubeSearchResults(raw, {
        strictSongFilter: false,
        includeShorts: true,
      })) {
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
    if ((mergedMap.size < 8 || !hasOfficialYet) && (plan.sp || plan.searchQuery !== rawQuery.trim())) {
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
      category,
      { allowAllVideos: true }
    ).slice(0, 25);
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

const YT_VR_USER_AGENT =
  'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

function isAllowedProxyHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '0.0.0.0' ||
    lower === '::1' ||
    lower === '[::1]' ||
    lower.startsWith('10.') ||
    lower.startsWith('192.168.') ||
    lower.startsWith('169.254.') ||
    lower.startsWith('fe80:') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(lower)
  ) {
    return false;
  }
  const allowedSuffixes = [
    'googlevideo.com',
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

interface ServerDirectMedia {
  audioUrl?: string;
  audioExt: 'm4a' | 'webm' | 'mp3';
  audioContentLength: number;
  muxed360Url?: string;
  muxed360Length: number;
  videoStreams: Partial<Record<'144p' | '240p' | '360p' | '480p' | '720p', { url: string; contentLength: number }>>;
  durationSeconds: number;
}

interface YouTubeResolveResult {
  media: ServerDirectMedia | null;
  botBlocked: boolean;
}

const ytDirectCache = new Map<string, { expiresAt: number; result: YouTubeResolveResult }>();
let scClientIdCache: { id: string; expiresAt: number } | null = null;

async function getSoundCloudClientId(): Promise<string | null> {
  if (scClientIdCache && scClientIdCache.expiresAt > Date.now()) {
    return scClientIdCache.id;
  }
  try {
    const homeRes = await fetch('https://soundcloud.com', {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    if (!homeRes.ok) return null;
    const html = await homeRes.text();
    const assetUrls = Array.from(
      html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g)
    ).map((m) => m[0]);

    for (const scriptUrl of assetUrls.slice(-4).reverse()) {
      try {
        const jsRes = await fetch(scriptUrl, { signal: AbortSignal.timeout(4500) });
        if (!jsRes.ok) continue;
        const js = await jsRes.text();
        const match = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{20,40})"/);
        if (match?.[1]) {
          scClientIdCache = {
            id: match[1],
            expiresAt: Date.now() + 30 * 60 * 1000,
          };
          return match[1];
        }
      } catch {
        // Try next bundle
      }
    }
  } catch {
    // Ignore SoundCloud script lookup failure
  }
  return null;
}

async function resolveFallbackAudioMirror(
  title: string,
  artist: string,
  expectedDurationSec: number
): Promise<{ url: string; provider: 'audius' | 'soundcloud' } | null> {
  const cleanTitle = (title || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanArtist = (artist || '').replace(/\s*-\s*Topic$/i, '').trim();
  const query = [cleanArtist, cleanTitle].filter(Boolean).join(' ').trim() || title;
  if (!query) return null;

  // 1. Verified full-length match on Audius (progressive MP3/HLS, no 30s previews)
  try {
    const audiusUrl = `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&limit=10`;
    const audiusRes = await fetch(audiusUrl, {
      signal: AbortSignal.timeout(5500),
      headers: { Accept: 'application/json' },
    });
    if (audiusRes.ok) {
      const data = (await audiusRes.json()) as { data?: AudiusTrack[] };
      const candidates: AudioMirrorCandidate[] = (data.data || [])
        .filter((item) => Boolean(item.id && item.title && item.duration))
        .map((item) => ({
          title: item.title || '',
          artist: item.user?.name || '',
          durationSec: Math.round(item.duration || 0),
          streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(item.id!)}/stream`,
          provider: 'audius' as const,
        }));
      const picked = pickVerifiedAudioMirrorCandidate(
        candidates,
        cleanTitle || title,
        cleanArtist,
        expectedDurationSec
      );
      if (picked) {
        return { url: picked.streamUrl, provider: 'audius' };
      }
    }
  } catch {
    // Fall through to SoundCloud
  }

  // 2. Verified full-length match on SoundCloud (strictly excluding 30s SNIP previews & remixes)
  try {
    const clientId = await getSoundCloudClientId();
    if (clientId) {
      const scSearchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(
        query
      )}&client_id=${encodeURIComponent(clientId)}&limit=10`;
      const scRes = await fetch(scSearchUrl, {
        signal: AbortSignal.timeout(5500),
        headers: { Accept: 'application/json' },
      });
      if (scRes.ok) {
        const scJson = (await scRes.json()) as {
          collection?: Array<{
            title?: string;
            duration?: number;
            full_duration?: number;
            policy?: string;
            streamable?: boolean;
            user?: { username?: string };
            media?: {
              transcodings?: Array<{
                url?: string;
                preset?: string;
                format?: { protocol?: string; mime_type?: string };
              }>;
            };
          }>;
        };

        const scCandidates: Array<AudioMirrorCandidate & { transcodingUrl: string }> = [];
        for (const item of scJson.collection || []) {
          if (!item.title || item.streamable === false || item.policy === 'SNIP') continue;
          const durSec = Math.round((item.duration || 0) / 1000);
          if (durSec < 45) continue;
          const transcodings = item.media?.transcodings || [];
          const pickedTrans =
            transcodings.find((t) => t.format?.protocol === 'progressive' && t.url) ||
            transcodings.find(
              (t) => t.format?.protocol === 'hls' && (t.format?.mime_type || '').includes('mpeg') && t.url
            ) ||
            transcodings.find((t) => t.format?.protocol === 'hls' && t.url);
          if (!pickedTrans?.url) continue;

          scCandidates.push({
            title: item.title,
            artist: item.user?.username || '',
            durationSec: durSec,
            streamUrl: pickedTrans.url,
            transcodingUrl: pickedTrans.url,
            provider: 'soundcloud',
          });
        }

        const matched = pickVerifiedAudioMirrorCandidate(
          scCandidates,
          cleanTitle || title,
          cleanArtist,
          expectedDurationSec
        );
        if (matched) {
          const resolveRes = await fetch(
            `${matched.streamUrl}?client_id=${encodeURIComponent(clientId)}`,
            { signal: AbortSignal.timeout(4500), headers: { Accept: 'application/json' } }
          );
          if (resolveRes.ok) {
            const resolvedJson = (await resolveRes.json()) as { url?: string };
            if (resolvedJson.url && resolvedJson.url.startsWith('https://')) {
              return { url: resolvedJson.url, provider: 'soundcloud' };
            }
          }
        }
      }
    }
  } catch {
    // No SoundCloud mirror available
  }

  return null;
}

async function resolveYouTubeDirectMedia(youtubeId: string): Promise<YouTubeResolveResult> {
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(youtubeId)) {
    return { media: null, botBlocked: false };
  }

  const cached = ytDirectCache.get(youtubeId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const optionalCookie = (process.env.YT_COOKIE || '').trim();
  const clientProfiles = [
    {
      ua: YT_VR_USER_AGENT,
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.60.19',
        androidSdkVersion: 32,
        hl: 'en',
        gl: 'US',
      },
    },
    {
      ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36',
      client: {
        clientName: 'TVHTML5',
        clientVersion: '7.20250218.10.00',
        hl: 'en',
        gl: 'US',
      },
    },
    {
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      client: {
        clientName: 'MWEB',
        clientVersion: '2.20250218.01.00',
        hl: 'en',
        gl: 'US',
      },
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      client: {
        clientName: 'WEB_CREATOR',
        clientVersion: '1.20250218.01.00',
        hl: 'en',
        gl: 'US',
      },
    },
    {
      ua: 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip',
      client: {
        clientName: 'ANDROID',
        clientVersion: '19.29.37',
        androidSdkVersion: 34,
        hl: 'en',
        gl: 'US',
      },
    },
    {
      ua: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
      client: {
        clientName: 'IOS',
        clientVersion: '19.29.1',
        deviceModel: 'iPhone16,2',
        hl: 'en',
        gl: 'US',
      },
    },
  ];

  let botBlocked = false;

  for (const profile of clientProfiles) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': profile.ua,
        Origin: 'https://www.youtube.com',
        Referer: `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`,
      };
      if (optionalCookie) {
        headers.Cookie = optionalCookie;
      }

      const playerRes = await fetch(
        'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        {
          method: 'POST',
          signal: AbortSignal.timeout(7000),
          headers,
          body: JSON.stringify({
            videoId: youtubeId,
            context: { client: profile.client },
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        }
      );

      if (!playerRes.ok) continue;
      const data = (await playerRes.json()) as {
        playabilityStatus?: { status?: string; reason?: string };
        videoDetails?: { lengthSeconds?: string };
        streamingData?: {
          formats?: Array<{ itag?: number; url?: string; contentLength?: string; mimeType?: string }>;
          adaptiveFormats?: Array<{
            itag?: number;
            url?: string;
            contentLength?: string;
            mimeType?: string;
            qualityLabel?: string;
          }>;
        };
      };

      if (data.playabilityStatus?.status === 'LOGIN_REQUIRED') {
        botBlocked = true;
      }

      const streaming = data.streamingData;
      if (!streaming) continue;

      const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
      const formats = Array.isArray(streaming.formats) ? streaming.formats : [];

      const m4a140 = adaptive.find((f) => f.itag === 140 && f.url);
      const anyMp4Audio = adaptive.find((f) => (f.mimeType || '').includes('audio/mp4') && f.url);
      const anyAudio = adaptive.find((f) => (f.mimeType || '').startsWith('audio/') && f.url);
      const pickedAudio = m4a140 || anyMp4Audio || anyAudio;
      const muxed18 = formats.find((f) => f.itag === 18 && f.url);

      if (!pickedAudio?.url && !muxed18?.url) continue;

      const videoStreams: ServerDirectMedia['videoStreams'] = {};
      const desiredVideoItags: Array<{ res: '144p' | '240p' | '360p' | '480p' | '720p'; itag: number }> = [
        { res: '144p', itag: 160 },
        { res: '240p', itag: 133 },
        { res: '360p', itag: 134 },
        { res: '480p', itag: 135 },
        { res: '720p', itag: 136 },
      ];

      for (const target of desiredVideoItags) {
        const match =
          adaptive.find((f) => f.itag === target.itag && f.url) ||
          adaptive.find(
            (f) =>
              (f.mimeType || '').includes('video/mp4') &&
              (f.mimeType || '').includes('avc1') &&
              f.qualityLabel === target.res &&
              f.url
          );
        if (match?.url) {
          videoStreams[target.res] = {
            url: match.url,
            contentLength: Number(match.contentLength || 0) || 0,
          };
        }
      }

      const audioMime = pickedAudio?.mimeType || '';
      const result: YouTubeResolveResult = {
        media: {
          audioUrl: pickedAudio?.url || muxed18?.url,
          audioExt: audioMime.includes('webm') ? 'webm' : 'm4a',
          audioContentLength: Number(pickedAudio?.contentLength || 0) || 0,
          muxed360Url: muxed18?.url,
          muxed360Length: Number(muxed18?.contentLength || 0) || 0,
          videoStreams,
          durationSeconds: Number(data.videoDetails?.lengthSeconds || 0) || 0,
        },
        botBlocked: false,
      };
      if (ytDirectCache.size >= 60) ytDirectCache.clear();
      ytDirectCache.set(youtubeId, { expiresAt: Date.now() + 5 * 60 * 1000, result });
      return result;
    } catch {
      // Try next Innertube client profile
    }
  }

  const failResult: YouTubeResolveResult = { media: null, botBlocked };
  if (ytDirectCache.size >= 60) ytDirectCache.clear();
  ytDirectCache.set(youtubeId, { expiresAt: Date.now() + 90 * 1000, result: failResult });
  return failResult;
}

function runFfmpegToFile(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-800);
    });

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        reject(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderrTail.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const AI_ASSISTANT_SYSTEM_INSTRUCTION = `You are the built-in Siri-style AI music assistant inside kaGO.PIaY, a hi-fi offline & streaming audio player.

What you can help users with:
1. Search & Confirm Song / Mix Playback:
   - When the user asks to find or play a song, video, or YouTube DJ mix (e.g., "play a kenyan popular song by wakadinali called blow" or "find that amapiano mix on youtube"), call play_song with mode="ask_confirm" and a clean search query ("Wakadinali Blow", "Kenyan hip hop mix", etc.). The app will search live YouTube/Audius, show the found track card, and let the user confirm playback with "Yes" or tap Play.
   - Only use mode="play_now" if the user explicitly confirms ("yes play it", "play immediately without asking") or is answering a confirmation question.
2. Identify songs from typed or spoken lyrics, song descriptions, vibe hints, or hummed/sung/played audio clips sent via the microphone.
   - Listen closely to hummed melodies, rhythm, pitch contour, or sung fragments in audio recordings. Provide your best matching song candidate(s) with artist names via identify_song_candidates (up to 3 plausible matches) so the user can inspect and confirm playing them.
   - If hummed audio is completely silent, pure noise, or too ambiguous to identify confidently, be honest and suggest humming slightly louder/closer to the mic or adding a lyric clue.
3. Answer music knowledge questions thoroughly and accurately using Google Search grounding (e.g., where a beat or song was sampled from, producers, release year, chart trivia, meaning of lyrics, or details about the currently playing track shown in context).
4. Create playlists for any artist, genre, mood, activity, or era using create_playlist with real, well-known, distinct song search queries in "Artist - Title" format. Match the exact count the user asked for (e.g. 20 songs if they ask for 20/twenty, up to 30 max; otherwise default to 10–12 diverse songs).
5. Control the kaGO.PIaY app on command: play/pause/skip/previous/rewind/forward/shuffle/autoplay radio/fullscreen/sync lyrics/equalizer/live studio/song picker/folder picker (control_playback), EQ presets & Bass Boost & Crossfade (update_dsp), navigate tabs or open Search (navigate_tab), favorite/unfavorite current track (toggle_favorite_current), download the current track to the app or local device (download_current_track), or play offline library tracks (play_library_match).

Rules:
- Never fabricate sample credits, producers, or song identities—rely on Google Search when verifying facts, samples, or lyric matches.
- Keep replies concise, warm, conversational like Siri, and easy to skim on mobile.
- When you call play_song with mode="ask_confirm", tell the user what you searched for and ask them to confirm if they'd like you to play it.`;

const AI_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'play_song',
    description:
      'Search YouTube/Audius for a song or mix in kaGO.PIaY and ask to confirm playback, play now, play next, or queue.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Clean search query (e.g. "Wakadinali Blow" or "Kenyan drill mix").',
        },
        title: { type: Type.STRING, description: 'Track title if known.' },
        artist: { type: Type.STRING, description: 'Artist name if known.' },
        mode: {
          type: Type.STRING,
          enum: ['ask_confirm', 'play_now', 'play_next', 'add_to_queue'],
          description: 'Use ask_confirm by default for song/mix requests so the user confirms after seeing the found track.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'identify_song_candidates',
    description:
      'Return top candidate song matches identified from typed lyrics, descriptions, or hummed/sung microphone audio.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        candidates: {
          type: Type.ARRAY,
          description: 'Up to 3 ranked song candidates.',
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              artist: { type: Type.STRING },
              reason: {
                type: Type.STRING,
                description: 'Brief explanation (matching lyric phrase, melody, or sample).',
              },
              confidence: {
                type: Type.STRING,
                enum: ['high', 'medium', 'low'],
              },
            },
            required: ['title', 'artist'],
          },
        },
      },
      required: ['candidates'],
    },
  },
  {
    name: 'create_playlist',
    description:
      'Create and save a playable playlist inside kaGO.PIaY populated with real songs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'Short catchy playlist title.' },
        description: { type: Type.STRING, description: 'Brief 1-sentence playlist description.' },
        trackQueries: {
          type: Type.ARRAY,
          description:
            'List of real distinct song queries in "Artist - Song Title" format matching the requested count (default 10 to 12, or up to 30 when the user specifies e.g. 20 songs).',
          items: { type: Type.STRING },
        },
        autoPlay: {
          type: Type.BOOLEAN,
          description: 'Set true if user asked to play/start the playlist immediately.',
        },
      },
      required: ['name', 'trackQueries'],
    },
  },
  {
    name: 'control_playback',
    description: 'Control current audio playback state, queue navigation, fullscreen, lyrics, EQ modal, live studio, or file pickers.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          enum: [
            'play',
            'pause',
            'toggle',
            'next',
            'previous',
            'seek_relative',
            'toggle_shuffle',
            'toggle_autoplay_radio',
            'open_fullscreen',
            'open_lyrics',
            'open_dsp',
            'open_live_studio',
            'pick_song',
            'pick_folder',
          ],
        },
        valueSeconds: {
          type: Type.NUMBER,
          description: 'Signed seconds offset when command is seek_relative (e.g. 15 or -15).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'update_dsp',
    description: 'Update the kaGO.PIaY equalizer preset, hardware bass boost, or crossfade duration.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        eqPreset: {
          type: Type.STRING,
          enum: [
            'Flat',
            'Bass',
            'Heavy Bass',
            'Rock',
            'Pop',
            'Classical',
            'Jazz',
            'Electronic',
            'Hip-Hop',
            'Vocal Boost',
            'Acoustic',
            'Treble Boost',
          ],
        },
        bassBoostEnabled: { type: Type.BOOLEAN },
        bassBoostDb: { type: Type.NUMBER, description: '0 to 14 dB' },
        crossfadeSeconds: { type: Type.NUMBER, description: '0 to 12 seconds' },
      },
    },
  },
  {
    name: 'navigate_tab',
    description: 'Switch the active screen/tab in kaGO.PIaY or launch Search.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tab: {
          type: Type.STRING,
          enum: ['dashboard', 'stream', 'library', 'settings', 'search', 'scanner', 'lyrics'],
        },
        librarySubTab: {
          type: Type.STRING,
          enum: ['all', 'downloads', 'folders', 'playlists', 'albums', 'artists', 'favorites'],
        },
        searchQuery: {
          type: Type.STRING,
          description: 'Optional query to run when opening search tab.',
        },
      },
      required: ['tab'],
    },
  },
  {
    name: 'download_current_track',
    description: 'Save or download the currently playing track offline in the app or to device.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        destination: {
          type: Type.STRING,
          enum: ['app', 'device'],
        },
        formatId: {
          type: Type.STRING,
          enum: [
            'm4a-128',
            'mp3-70',
            'mp3-128',
            'mp3-160',
            'mp3-320',
            'mp4-144p',
            'mp4-240p',
            'mp4-360p',
            'mp4-480p',
            'mp4-720p',
          ],
        },
      },
      required: ['destination'],
    },
  },
  {
    name: 'toggle_favorite_current',
    description: 'Like/favorite or unfavorite the currently playing track.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        favorite: { type: Type.BOOLEAN },
      },
      required: ['favorite'],
    },
  },
  {
    name: 'play_library_match',
    description: 'Play or queue an offline/downloaded song from the user library by title or artist.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING },
        mode: { type: Type.STRING, enum: ['play_now', 'queue'] },
      },
      required: ['query'],
    },
  },
];

function formatAiContextSummary(context?: AiAssistantContextPayload | null): string {
  if (!context) return '';
  const parts: string[] = [];
  if (context.currentTrack) {
    const t = context.currentTrack;
    parts.push(
      `Now Playing: "${t.title}" by ${t.artist} (Album: ${t.album || 'Unknown'}, Source: ${t.source}, ${Math.round(
        t.currentTime
      )}s / ${Math.round(t.duration)}s, ${context.isPlaying ? 'playing' : 'paused'})`
    );
  } else {
    parts.push('Now Playing: Nothing currently loaded.');
  }
  parts.push(`Active Tab: ${context.activeTab}${context.isFullscreenOpen ? ' (Fullscreen Player open)' : ''}`);
  if (context.dsp) {
    parts.push(
      `DSP: EQ=${context.dsp.preset}, BassBoost=${
        context.dsp.bassBoostEnabled ? `ON (${context.dsp.bassBoostDb}dB)` : 'OFF'
      }, Crossfade=${context.dsp.crossfadeSeconds}s`
    );
  }
  if (Array.isArray(context.playlistNames) && context.playlistNames.length > 0) {
    parts.push(`Saved Playlists: ${context.playlistNames.slice(0, 12).join(', ')}`);
  }
  parts.push(`Offline Library Count: ${context.libraryTracksCount || 0} tracks`);
  return parts.join('\n');
}

function extractGroundedSources(response: {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
}): AiAssistantSource[] {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set<string>();
  const out: AiAssistantSource[] = [];
  for (const ch of chunks) {
    const uri = ch?.web?.uri ? sanitizeHttpUrl(ch.web.uri) : null;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const title = (ch.web?.title || '').trim() || new URL(uri).hostname;
    out.push({ title: title.slice(0, 120), uri });
    if (out.length >= 6) break;
  }
  return out;
}

async function startServer() {
  const app = express();

  app.post('/api/ai/assist', express.json({ limit: '6mb' }), async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error: 'AI assistant requires GEMINI_API_KEY to be configured on the server.',
      });
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      prompt?: unknown;
      audioBase64?: unknown;
      audioMimeType?: unknown;
      history?: unknown;
      context?: AiAssistantContextPayload;
    };

    const rawPrompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : '';
    const rawAudio = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
    const rawMime = typeof body.audioMimeType === 'string' ? body.audioMimeType : 'audio/webm';

    if (!rawPrompt && !rawAudio) {
      return res.status(400).json({ error: 'Please type a message or record audio to ask the AI assistant.' });
    }

    let cleanAudioBase64 = '';
    let audioMimeType = '';
    if (rawAudio) {
      if (!isAllowedAudioMimeType(rawMime)) {
        return res.status(400).json({ error: 'Unsupported audio recording format.' });
      }
      const stripped = rawAudio.replace(/^data:audio\/[a-zA-Z0-9.+_-]+;base64,/, '');
      if (!/^[A-Za-z0-9+/=]+$/.test(stripped)) {
        return res.status(400).json({ error: 'Invalid base64 audio payload.' });
      }
      const decodedBytes = Buffer.from(stripped, 'base64').byteLength;
      if (decodedBytes === 0 || decodedBytes > 4.5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Audio clip must be between 1 byte and 4.5 MB.' });
      }
      cleanAudioBase64 = stripped;
      audioMimeType = normalizeAudioMimeType(rawMime);
    }

    const historyItems: AiAssistantHistoryItem[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (h): h is AiAssistantHistoryItem =>
              Boolean(h) &&
              typeof h === 'object' &&
              ((h as AiAssistantHistoryItem).role === 'user' ||
                (h as AiAssistantHistoryItem).role === 'model') &&
              typeof (h as AiAssistantHistoryItem).text === 'string' &&
              (h as AiAssistantHistoryItem).text.trim().length > 0
          )
          .slice(-8)
          .map((h) => ({
            role: h.role,
            text: h.text.trim().slice(0, 1200),
          }))
      : [];

    const contextSummary = formatAiContextSummary(body.context);
    const effectivePrompt =
      rawPrompt ||
      'Listen to this microphone audio recording carefully. Identify the hummed, sung, or spoken song/lyrics or fulfill the spoken voice request.';

    const userParts: Content['parts'] = [];
    if (cleanAudioBase64) {
      userParts.push({
        inlineData: {
          mimeType: audioMimeType,
          data: cleanAudioBase64,
        },
      });
    }
    userParts.push({
      text: contextSummary ? `[App Context]\n${contextSummary}\n\n[User Request]\n${effectivePrompt}` : effectivePrompt,
    });

    const contents: Content[] = [
      ...historyItems.map((h) => ({
        role: h.role,
        parts: [{ text: h.text }],
      })),
      {
        role: 'user',
        parts: userParts,
      },
    ];

    const aiConfig = {
      systemInstruction: AI_ASSISTANT_SYSTEM_INSTRUCTION,
      tools: [{ googleSearch: {} }, { functionDeclarations: AI_FUNCTION_DECLARATIONS }],
      toolConfig: { includeServerSideToolInvocations: true },
    };

    try {
      const turn1 = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: aiConfig,
      });

      const collectedCalls: Array<{ name?: string; args?: Record<string, unknown> }> = [
        ...(turn1.functionCalls || []).map((fc) => ({
          name: fc.name,
          args: (fc.args || {}) as Record<string, unknown>,
        })),
      ];
      let replyText = (turn1.text || '').trim();
      const sourceMap = new Map<string, AiAssistantSource>();
      for (const s of extractGroundedSources(turn1)) {
        sourceMap.set(s.uri, s);
      }

      if ((turn1.functionCalls?.length || 0) > 0 && !replyText) {
        const previousContent = turn1.candidates?.[0]?.content;
        const turn2Contents: Content[] = [
          ...contents,
          ...(previousContent ? [previousContent] : []),
          {
            role: 'user',
            parts: (turn1.functionCalls || []).map((fc) => ({
              functionResponse: {
                name: fc.name || 'action',
                id: fc.id,
                response: { ok: true, executedInApp: true },
              },
            })),
          },
        ];

        try {
          const turn2 = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: turn2Contents,
            config: aiConfig,
          });
          if (turn2.text?.trim()) {
            replyText = turn2.text.trim();
          }
          for (const fc of turn2.functionCalls || []) {
            collectedCalls.push({
              name: fc.name,
              args: (fc.args || {}) as Record<string, unknown>,
            });
          }
          for (const s of extractGroundedSources(turn2)) {
            sourceMap.set(s.uri, s);
          }
        } catch {
          // Keep collected actions if follow-up turn fails
        }
      }

      const actions = parseFunctionCallsToActions(collectedCalls);
      if (!replyText && actions.length > 0) {
        replyText = 'Done — applied that in kaGO.PIaY.';
      } else if (!replyText) {
        replyText = 'I heard you, but could not find a clear answer. Try humming closer or adding a lyric clue.';
      }

      return res.json({
        reply: replyText,
        actions,
        sources: Array.from(sourceMap.values()),
      });
    } catch (err) {
      const status =
        typeof (err as { status?: unknown })?.status === 'number'
          ? (err as { status: number }).status
          : 502;
      const rawMsg = err instanceof Error ? err.message : 'AI service error.';
      if (status === 429) {
        return res.status(429).json({
          error: 'AI rate limit reached right now. Please wait a moment and try again.',
        });
      }
      if (status === 400 || status === 403 || status === 404) {
        return res.status(status).json({ error: rawMsg.slice(0, 260) });
      }
      return res.status(502).json({
        error: 'Unable to reach Gemini right now. Please try again in a moment.',
      });
    }
  });

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
    if (!listId || !/^[a-zA-Z0-9_-]{6,}$/.test(listId)) {
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
      // Fall back to /next and playlist HTML page
    }

    try {
      const nextRes = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
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
        body: buildInnertubePlaylistNextBody(listId),
      });
      if (nextRes.ok) {
        const jsonText = await nextRes.text();
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

  app.get('/api/stream/formats', async (req, res) => {
    const youtubeId = String(req.query.youtubeId || '').trim();
    const streamUrl = String(req.query.streamUrl || '').trim();
    const fallbackDuration = Math.max(10, Number(req.query.duration || 210) || 210);

    if (youtubeId && !/^[a-zA-Z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).json({ error: 'Invalid youtubeId' });
    }
    if (streamUrl) {
      try {
        const parsed = new URL(streamUrl);
        if (parsed.protocol !== 'https:' || !isAllowedProxyHost(parsed.hostname)) {
          return res.status(403).json({ error: 'Host not permitted' });
        }
      } catch {
        return res.status(400).json({ error: 'Invalid streamUrl' });
      }
    }

    let durationSeconds = fallbackDuration;
    const sizes: Partial<Record<DownloadFormatId, number>> = {};

    if (youtubeId) {
      const { media: resolved } = await resolveYouTubeDirectMedia(youtubeId);
      if (resolved) {
        if (resolved.durationSeconds > 0) durationSeconds = resolved.durationSeconds;
        const audioBytes = resolved.audioContentLength;
        for (const opt of DOWNLOAD_FORMAT_OPTIONS) {
          if (opt.id === 'm4a-128' && audioBytes > 0) {
            sizes[opt.id] = audioBytes;
          } else if (opt.category === 'video' && opt.resolutionLabel) {
            const key = opt.resolutionLabel as '144p' | '240p' | '360p' | '480p' | '720p';
            const vStream = resolved.videoStreams[key];
            if (vStream?.contentLength && audioBytes > 0) {
              sizes[opt.id] = vStream.contentLength + audioBytes;
            } else if (opt.id === 'mp4-360p' && resolved.muxed360Length > 0) {
              sizes[opt.id] = resolved.muxed360Length;
            } else {
              sizes[opt.id] = estimateFormatSizeBytes(durationSeconds, opt);
            }
          } else {
            sizes[opt.id] = estimateFormatSizeBytes(durationSeconds, opt);
          }
        }
        return res.json({ durationSeconds, sizes });
      }
    }

    for (const opt of DOWNLOAD_FORMAT_OPTIONS) {
      sizes[opt.id] = estimateFormatSizeBytes(durationSeconds, opt);
    }
    return res.json({ durationSeconds, sizes });
  });

  app.get('/api/stream/download', async (req, res) => {
    const youtubeId = String(req.query.youtubeId || '').trim();
    const streamUrl = String(req.query.streamUrl || '').trim();
    const rawFormat = String(req.query.format || 'mp3-160').trim() as DownloadFormatId;
    const option = DOWNLOAD_FORMAT_MAP[rawFormat];
    const requestedDuration = Math.max(0, Number(req.query.duration || 0) || 0);
    const cleanMeta = (val: unknown, fallback: string) =>
      String(val || fallback)
        .replace(/[\u0000-\u001f]+/g, ' ')
        .trim()
        .slice(0, 120) || fallback;

    const title = cleanMeta(req.query.title, 'Track');
    const artist = cleanMeta(req.query.artist, 'Unknown Artist');
    const album = cleanMeta(req.query.album, 'kaGO.PIaY');

    if (!option) {
      return res.status(400).json({ error: 'Unsupported download format.' });
    }
    if (!youtubeId && !streamUrl) {
      return res.status(400).json({ error: 'Missing track stream identifier.' });
    }
    if (youtubeId && !/^[a-zA-Z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).json({ error: 'Invalid YouTube track ID.' });
    }

    let validatedStreamUrl = '';
    if (streamUrl) {
      try {
        const parsed = new URL(streamUrl);
        if (parsed.protocol !== 'https:' || !isAllowedProxyHost(parsed.hostname)) {
          return res.status(403).json({ error: 'Stream host not permitted.' });
        }
        validatedStreamUrl = parsed.toString();
      } catch {
        return res.status(400).json({ error: 'Invalid stream URL.' });
      }
    }

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    const downloadFilename = sanitizeDownloadFilename(title, artist, option.ext);
    const asciiFallbackName = downloadFilename.replace(/[^\x20-\x7e]+/g, '_');
    const tmpOutFile = path.join(
      os.tmpdir(),
      `kago-dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${option.ext}`
    );

    const cleanupTempFile = async () => {
      await fs.unlink(tmpOutFile).catch(() => {});
    };

    try {
      let resolved: ServerDirectMedia | null = null;
      let ytBotBlocked = false;
      if (youtubeId) {
        const ytResult = await resolveYouTubeDirectMedia(youtubeId);
        resolved = ytResult.media;
        ytBotBlocked = ytResult.botBlocked;
      }

      let sourceAudioUrl = resolved?.audioUrl || validatedStreamUrl;
      let usingYouTubeMedia = Boolean(resolved?.audioUrl || resolved?.muxed360Url);

      // When YouTube blocks datacenter server IPs for music downloads, look up a verified full-length audio mirror
      if (!sourceAudioUrl && option.category === 'music') {
        const mirror = await resolveFallbackAudioMirror(title, artist, requestedDuration);
        if (mirror?.url) {
          sourceAudioUrl = mirror.url;
          usingYouTubeMedia = false;
        }
      }

      if (!sourceAudioUrl) {
        if (option.category === 'video' && ytBotBlocked) {
          return res.status(502).json({
            error:
              'YouTube blocked cloud server access for MP4 video. Choose a Music format (MP3/M4A) or use the Android app.',
            code: 'YT_BOT_BLOCKED',
          });
        }
        if (ytBotBlocked) {
          return res.status(502).json({
            error:
              'YouTube blocked cloud server download for this song and no full audio mirror matched. Use the Android app to download directly.',
            code: 'YT_BOT_BLOCKED',
          });
        }
        return res.status(502).json({ error: 'Media stream could not be resolved for download.' });
      }

      const baseInputFlags = usingYouTubeMedia
        ? ['-user_agent', YT_VR_USER_AGENT, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2']
        : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2'];

      let ffmpegArgs: string[] = [];

      if (option.category === 'music') {
        if (option.id === 'm4a-128') {
          const canCopyM4a = Boolean(youtubeId && resolved?.audioExt === 'm4a');
          ffmpegArgs = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            ...baseInputFlags,
            '-i',
            sourceAudioUrl,
            '-vn',
            ...(canCopyM4a ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
            '-metadata',
            `title=${title}`,
            '-metadata',
            `artist=${artist}`,
            '-metadata',
            `album=${album}`,
            '-movflags',
            '+faststart',
            tmpOutFile,
          ];
        } else {
          const bitrateArg = `${option.estimatedBitrateKbps}k`;
          ffmpegArgs = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            ...baseInputFlags,
            '-i',
            sourceAudioUrl,
            '-vn',
            '-c:a',
            'libmp3lame',
            '-b:a',
            bitrateArg,
            '-ar',
            '44100',
            '-metadata',
            `title=${title}`,
            '-metadata',
            `artist=${artist}`,
            '-metadata',
            `album=${album}`,
            '-id3v2_version',
            '3',
            tmpOutFile,
          ];
        }
      } else {
        // Video MP4 formats: 144p, 240p, 360p, 480p, 720p
        if (!youtubeId || !resolved) {
          return res.status(ytBotBlocked ? 502 : 400).json({
            error: ytBotBlocked
              ? 'YouTube blocked cloud server access for MP4 video. Choose a Music format (MP3/M4A) or use the Android app.'
              : 'Video format unavailable for audio-only stream.',
            code: ytBotBlocked ? 'YT_BOT_BLOCKED' : 'VIDEO_UNAVAILABLE',
          });
        }
        const resKey = (option.resolutionLabel || '360p') as
          | '144p'
          | '240p'
          | '360p'
          | '480p'
          | '720p';
        const adaptiveVideo = resolved.videoStreams[resKey];

        if (adaptiveVideo?.url && resolved.audioUrl) {
          ffmpegArgs = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            ...baseInputFlags,
            '-i',
            adaptiveVideo.url,
            ...baseInputFlags,
            '-i',
            resolved.audioUrl,
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-c:v',
            'copy',
            '-c:a',
            resolved.audioExt === 'm4a' ? 'copy' : 'aac',
            '-metadata',
            `title=${title}`,
            '-metadata',
            `artist=${artist}`,
            '-movflags',
            '+faststart',
            tmpOutFile,
          ];
        } else if (resolved.muxed360Url) {
          const heightMap: Record<string, number> = {
            '144p': 144,
            '240p': 240,
            '360p': 360,
            '480p': 480,
            '720p': 720,
          };
          const targetHeight = heightMap[resKey] || 360;
          if (targetHeight === 360) {
            ffmpegArgs = [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              ...baseInputFlags,
              '-i',
              resolved.muxed360Url,
              '-c',
              'copy',
              '-movflags',
              '+faststart',
              tmpOutFile,
            ];
          } else {
            ffmpegArgs = [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              ...baseInputFlags,
              '-i',
              resolved.muxed360Url,
              '-vf',
              `scale=-2:${targetHeight}`,
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-c:a',
              'copy',
              '-movflags',
              '+faststart',
              tmpOutFile,
            ];
          }
        } else {
          return res.status(502).json({ error: 'Requested video stream unavailable.' });
        }
      }

      await runFfmpegToFile(ffmpegArgs, abortController.signal);
      if (abortController.signal.aborted) {
        await cleanupTempFile();
        return;
      }

      const stat = await fs.stat(tmpOutFile);
      if (stat.size <= 0) {
        await cleanupTempFile();
        return res.status(502).json({ error: 'Generated media file was empty.' });
      }

      res.status(200);
      res.setHeader('Content-Type', option.mimeType);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallbackName}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`
      );
      res.setHeader('Cache-Control', 'no-store');

      const readStream = createReadStream(tmpOutFile);
      readStream.on('close', () => {
        void cleanupTempFile();
      });
      readStream.on('error', () => {
        void cleanupTempFile();
        if (!res.headersSent) {
          res.status(502).json({ error: 'Failed reading processed download.' });
        } else {
          res.end();
        }
      });
      req.on('close', () => {
        readStream.destroy();
        void cleanupTempFile();
      });
      readStream.pipe(res);
    } catch {
      await cleanupTempFile();
      if (!res.headersSent && !abortController.signal.aborted) {
        return res.status(502).json({ error: 'Download conversion failed.' });
      }
      if (!res.writableEnded) {
        res.end();
      }
    }
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

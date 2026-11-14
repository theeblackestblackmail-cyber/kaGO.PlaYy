import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  buildRadioSeedQuery,
  extractYouTubeRelatedResults,
  extractYouTubeSearchResults,
  isIndividualSong,
  parseYouTubeSuggestResponse,
  rankYouTubeSearchResults,
  sortStudioQueue,
  toYouTubeTracks,
} from './src/utils/streamFilter';
import type {
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

async function searchYouTubeTracks(
  term: string,
  genre?: string,
  excludeYoutubeId?: string
): Promise<Track[]> {
  try {
    const cleanTerm = term.trim() || 'top music hits';
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(
      cleanTerm
    )}&sp=EgIQAQ%3D%3D`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(6500),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'SOCS=CAI',
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const extracted = extractYouTubeSearchResults(html).filter(
      (item) => !excludeYoutubeId || item.videoId !== excludeYoutubeId
    );
    const ranked = rankYouTubeSearchResults(extracted, cleanTerm).slice(0, 12);
    return toYouTubeTracks(ranked, genre);
  } catch {
    return [];
  }
}

async function fetchYouTubeWatchRelated(youtubeId: string, genre?: string): Promise<Track[]> {
  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6500),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'SOCS=CAI',
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
      const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(
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
      return res.json({ suggestions: parseYouTubeSuggestResponse(raw) });
    } catch {
      return res.json({ suggestions: [] });
    }
  });

  app.get('/api/stream/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    const genre = String(req.query.genre || '').trim();
    const baseTerm =
      [query, genre ? `${genre} music` : ''].filter(Boolean).join(' ') || 'top music hits';

    const ytResults = await searchYouTubeTracks(baseTerm, genre);
    if (ytResults.length > 0) {
      return res.json({ results: ytResults, source: 'live', provider: 'youtube' });
    }

    const audiusResults = await searchAudiusTracks(
      [query, genre].filter(Boolean).join(' ') || 'synthwave',
      genre
    );
    if (audiusResults.length > 0) {
      return res.json({ results: audiusResults, source: 'live', provider: 'audius' });
    }

    return res.json({ results: [], source: 'fallback' });
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

      const upstream = await fetch(parsed.toString(), {
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      if (!upstream.ok || !upstream.body) {
        return res.status(502).send('Upstream error');
      }
      const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const arrayBuffer = await upstream.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    } catch {
      return res.status(502).send('Proxy failed');
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

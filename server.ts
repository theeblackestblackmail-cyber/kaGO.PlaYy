import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import { isIndividualSong, sortStudioQueue } from './src/utils/streamFilter';
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

interface ItunesSong {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackTimeMillis?: number;
  primaryGenreName?: string;
}

function mapItunesSongToTrack(item: ItunesSong): Track | null {
  if (!item.trackName || !item.artistName || !item.previewUrl || !item.trackId) return null;
  const durationSec = item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : 30;
  if (!isIndividualSong(item.trackName, item.collectionName, durationSec)) {
    return null;
  }
  const artwork = item.artworkUrl100
    ? item.artworkUrl100.replace('100x100bb', '600x600bb')
    : undefined;

  return {
    id: `stream-${item.trackId}`,
    title: item.trackName,
    artist: item.artistName,
    album: item.collectionName || 'Single',
    duration: durationSec,
    source: 'stream',
    artworkUrl: artwork,
    streamUrl: item.previewUrl,
    genre: item.primaryGenreName || 'Stream',
    addedAt: Date.now(),
  };
}

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, studioListeners: clients.size });
  });

  app.get('/api/stream/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    const genre = String(req.query.genre || '').trim();
    const term = [query, genre].filter(Boolean).join(' ') || 'electronic synthwave';

    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=24`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(4500),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return res.json({ results: [], source: 'fallback' });
      }
      const data = (await response.json()) as { results?: ItunesSong[] };
      const mapped = (data.results || [])
        .map(mapItunesSongToTrack)
        .filter((t): t is Track => t !== null)
        .slice(0, 12);

      return res.json({ results: mapped, source: 'live' });
    } catch {
      return res.json({ results: [], source: 'fallback' });
    }
  });

  app.get('/api/stream/recover', async (req, res) => {
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const genre = String(req.query.genre || '').trim();
    const searchTerm = [title, artist].filter(Boolean).join(' ') || genre || 'synthwave';

    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=music&entity=song&limit=8`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(4000),
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const data = (await response.json()) as { results?: ItunesSong[] };
        const candidate = (data.results || [])
          .map(mapItunesSongToTrack)
          .find((t): t is Track => t !== null && Boolean(t.streamUrl));
        if (candidate?.streamUrl) {
          return res.json({
            recovered: true,
            mode: 'alternate-stream',
            streamUrl: candidate.streamUrl,
            recoveredFrom: `Alternate Stream #${candidate.id.replace('stream-', '')}`,
          });
        }
      }
    } catch {
      // Fall through to local synth recovery
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
      const allowedHosts = ['mzstatic.com', 'apple.com'];
      const isAllowed = allowedHosts.some(
        (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
      );
      if (!isAllowed || parsed.protocol !== 'https:') {
        return res.status(403).send('Host not permitted');
      }

      const upstream = await fetch(parsed.toString(), {
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok || !upstream.body) {
        return res.status(502).send('Upstream error');
      }
      const contentType = upstream.headers.get('content-type') || 'audio/mp4';
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
  const wss = new WebSocketServer({ server, path: '/ws/studio' });

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
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true' ? { server } : false,
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

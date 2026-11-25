import { DEFAULT_DSP_SETTINGS } from '../data/presetsAndStems';
import type { DspSettings, Playlist, StoredLyrics, Track } from '../types/audio';
import { looksLikeMojibake, repairCorruptedTrack } from '../utils/audioMetadata';
import { clampCrossfadeSeconds } from '../utils/streamFilter';

const DB_NAME = 'kagoplay_offline_db';
const DB_VERSION = 1;
const MAX_IDB_AUDIO_BLOB_BYTES = 150 * 1024 * 1024;
const MAX_MEMORY_BLOB_CACHE_ENTRIES = 12;
const memoryBlobCache = new Map<string, Blob>();

function setBoundedMemoryBlob(trackId: string, blob: Blob): void {
  if (memoryBlobCache.has(trackId)) {
    memoryBlobCache.delete(trackId);
  }
  memoryBlobCache.set(trackId, blob);
  while (memoryBlobCache.size > MAX_MEMORY_BLOB_CACHE_ENTRIES) {
    const oldestKey = memoryBlobCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryBlobCache.delete(oldestKey);
  }
}

const STORES = {
  TRACKS: 'tracks',
  BLOBS: 'audio_blobs',
  PLAYLISTS: 'playlists',
  LYRICS: 'lyrics',
  META: 'meta',
} as const;

let cachedDbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (cachedDbPromise) return cachedDbPromise;
  cachedDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      cachedDbPromise = null;
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.TRACKS)) {
        db.createObjectStore(STORES.TRACKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.BLOBS)) {
        db.createObjectStore(STORES.BLOBS);
      }
      if (!db.objectStoreNames.contains(STORES.PLAYLISTS)) {
        db.createObjectStore(STORES.PLAYLISTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.LYRICS)) {
        db.createObjectStore(STORES.LYRICS, { keyPath: 'trackId' });
      }
      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        cachedDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      cachedDbPromise = null;
      reject(req.error);
    };
  });
  return cachedDbPromise;
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []) as T[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function putInStore<T>(storeName: string, value: T, key?: IDBValidKey): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = key !== undefined ? store.put(value, key) : store.put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Graceful fallback if IndexedDB quota/mode restricts writes
  }
}

async function getByKey<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function deleteByKey(storeName: string, key: IDBValidKey): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore
  }
}

export const LEGACY_SYNTH_STEM_IDS = new Set([
  'stem-cyber-resonance',
  'stem-neon-drive',
  'stem-midnight-drift',
  'stem-tokyo-2099',
]);

export function isLegacyOrSynthTrack(track: Track | null | undefined): boolean {
  if (!track) return false;
  if (LEGACY_SYNTH_STEM_IDS.has(track.id)) return true;
  if (track.source === 'synth' || track.streamProvider === 'synth') return true;
  if (track.id.startsWith('stem-') || track.id.startsWith('curated-')) return true;
  return false;
}

export const localDb = {
  async loadTracks(): Promise<Track[]> {
    const tracks = await getAllFromStore<Track>(STORES.TRACKS);
    const removedIds: string[] = [];
    const keptTracks: Track[] = [];
    for (const track of tracks) {
      if (isLegacyOrSynthTrack(track)) {
        removedIds.push(track.id);
      } else {
        keptTracks.push(track);
      }
    }
    if (removedIds.length > 0) {
      void this.deleteTracksBatch(removedIds);
    }

    const fixedUpdates: Track[] = [];

    const hydrated = await Promise.all(
      keptTracks.map(async (track) => {
        if (
          track.source === 'local' &&
          (looksLikeMojibake(track.title) ||
            looksLikeMojibake(track.artist) ||
            looksLikeMojibake(track.album))
        ) {
          const blob = await getByKey<Blob>(STORES.BLOBS, track.id);
          const repaired = await repairCorruptedTrack(track, blob);
          if (repaired) {
            fixedUpdates.push(repaired);
            return repaired;
          }
        }
        return track;
      })
    );

    if (fixedUpdates.length > 0) {
      await this.saveTracksBatch(fixedUpdates);
    }

    return hydrated;
  },

  primeAudioBlob(trackId: string, audioBlob: Blob): void {
    setBoundedMemoryBlob(trackId, audioBlob);
  },

  async saveTrack(track: Track, audioBlob?: Blob): Promise<void> {
    await putInStore(STORES.TRACKS, track);
    if (audioBlob) {
      setBoundedMemoryBlob(track.id, audioBlob);
      if (audioBlob.size <= MAX_IDB_AUDIO_BLOB_BYTES) {
        await putInStore(STORES.BLOBS, audioBlob, track.id);
      }
    }
  },

  async saveTracksBatch(tracks: Track[]): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORES.TRACKS, 'readwrite');
        const store = tx.objectStore(STORES.TRACKS);
        for (const t of tracks) {
          store.put(t);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  },

  async getAudioBlob(trackId: string): Promise<Blob | undefined> {
    const cached = memoryBlobCache.get(trackId);
    if (cached) {
      setBoundedMemoryBlob(trackId, cached);
      return cached;
    }
    const stored = await getByKey<Blob>(STORES.BLOBS, trackId);
    if (stored) {
      setBoundedMemoryBlob(trackId, stored);
    }
    return stored;
  },

  async deleteTrack(trackId: string): Promise<void> {
    memoryBlobCache.delete(trackId);
    await deleteByKey(STORES.TRACKS, trackId);
    await deleteByKey(STORES.BLOBS, trackId);
  },

  async deleteAudioBlob(trackId: string): Promise<void> {
    memoryBlobCache.delete(trackId);
    await deleteByKey(STORES.BLOBS, trackId);
  },

  async deleteTracksBatch(trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    for (const id of trackIds) {
      memoryBlobCache.delete(id);
    }
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORES.TRACKS, STORES.BLOBS], 'readwrite');
        const trackStore = tx.objectStore(STORES.TRACKS);
        const blobStore = tx.objectStore(STORES.BLOBS);
        for (const id of trackIds) {
          trackStore.delete(id);
          blobStore.delete(id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  },

  async loadPlaylists(): Promise<Playlist[]> {
    return getAllFromStore<Playlist>(STORES.PLAYLISTS);
  },

  async savePlaylist(playlist: Playlist): Promise<void> {
    await putInStore(STORES.PLAYLISTS, playlist);
  },

  async deletePlaylist(playlistId: string): Promise<void> {
    await deleteByKey(STORES.PLAYLISTS, playlistId);
  },

  async loadAllLyrics(): Promise<Record<string, StoredLyrics>> {
    const list = await getAllFromStore<StoredLyrics>(STORES.LYRICS);
    const map: Record<string, StoredLyrics> = {};
    for (const item of list) {
      map[item.trackId] = item;
    }
    return map;
  },

  async saveLyrics(entry: StoredLyrics): Promise<void> {
    await putInStore(STORES.LYRICS, entry);
  },

  loadDspSettings(): DspSettings {
    try {
      const raw = localStorage.getItem('kagoplay_dsp_settings');
      if (!raw) return DEFAULT_DSP_SETTINGS;
      const parsed = JSON.parse(raw) as Partial<DspSettings>;
      return {
        ...DEFAULT_DSP_SETTINGS,
        ...parsed,
        crossfadeSeconds:
          typeof parsed.crossfadeSeconds === 'number'
            ? clampCrossfadeSeconds(parsed.crossfadeSeconds)
            : DEFAULT_DSP_SETTINGS.crossfadeSeconds,
        bands:
          Array.isArray(parsed.bands) && parsed.bands.length === 5
            ? (parsed.bands as DspSettings['bands'])
            : DEFAULT_DSP_SETTINGS.bands,
      };
    } catch {
      return DEFAULT_DSP_SETTINGS;
    }
  },

  saveDspSettings(settings: DspSettings): void {
    try {
      localStorage.setItem('kagoplay_dsp_settings', JSON.stringify(settings));
    } catch {
      // Ignore
    }
  },

  loadFavorites(): string[] {
    try {
      const raw = localStorage.getItem('kagoplay_favorites');
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  },

  saveFavorites(ids: string[]): void {
    try {
      localStorage.setItem('kagoplay_favorites', JSON.stringify(ids));
    } catch {
      // Ignore
    }
  },

  loadRecentSearches(): string[] {
    try {
      const raw = localStorage.getItem('kagoplay_recent_searches');
      return raw ? (JSON.parse(raw) as string[]).slice(0, 5) : [];
    } catch {
      return [];
    }
  },

  saveRecentSearches(items: string[]): void {
    try {
      localStorage.setItem('kagoplay_recent_searches', JSON.stringify(items.slice(0, 5)));
    } catch {
      // Ignore
    }
  },

  loadHistory(): string[] {
    try {
      const raw = localStorage.getItem('kagoplay_playback_history');
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  },

  pushHistory(trackId: string): string[] {
    const current = this.loadHistory().filter((id) => id !== trackId);
    const updated = [trackId, ...current].slice(0, 50);
    try {
      localStorage.setItem('kagoplay_playback_history', JSON.stringify(updated));
    } catch {
      // Ignore
    }
    return updated;
  },

  loadPlayCounts(): Record<string, number> {
    try {
      const raw = localStorage.getItem('kagoplay_play_counts');
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const clean: Record<string, number> = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
          clean[key] = Math.floor(val);
        }
      }
      return clean;
    } catch {
      return {};
    }
  },

  incrementPlayCount(trackId: string): Record<string, number> {
    const counts = this.loadPlayCounts();
    counts[trackId] = (counts[trackId] || 0) + 1;
    try {
      localStorage.setItem('kagoplay_play_counts', JSON.stringify(counts));
    } catch {
      // Ignore
    }
    return counts;
  },

  loadSmartShuffle(): boolean {
    try {
      return localStorage.getItem('kagoplay_smart_shuffle') === 'true';
    } catch {
      return false;
    }
  },

  saveSmartShuffle(enabled: boolean): void {
    try {
      localStorage.setItem('kagoplay_smart_shuffle', String(enabled));
    } catch {
      // Ignore
    }
  },
};

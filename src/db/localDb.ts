import { DEFAULT_DSP_SETTINGS } from '../data/presetsAndStems';
import type { DspSettings, Playlist, StoredLyrics, Track } from '../types/audio';

const DB_NAME = 'kagoplay_offline_db';
const DB_VERSION = 1;

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

export const localDb = {
  async loadTracks(): Promise<Track[]> {
    return getAllFromStore<Track>(STORES.TRACKS);
  },

  async saveTrack(track: Track, audioBlob?: Blob): Promise<void> {
    await putInStore(STORES.TRACKS, track);
    if (audioBlob && audioBlob.size <= 35 * 1024 * 1024) {
      await putInStore(STORES.BLOBS, audioBlob, track.id);
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
    return getByKey<Blob>(STORES.BLOBS, trackId);
  },

  async deleteTrack(trackId: string): Promise<void> {
    await deleteByKey(STORES.TRACKS, trackId);
    await deleteByKey(STORES.BLOBS, trackId);
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
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  },

  saveRecentSearches(items: string[]): void {
    try {
      localStorage.setItem('kagoplay_recent_searches', JSON.stringify(items));
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
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from './audio/AudioEngine';
import { DashboardView } from './components/DashboardView';
import { DspStudioModal } from './components/DspStudioModal';
import { FolderScannerView } from './components/FolderScannerView';
import { FullscreenPlayer } from './components/FullscreenPlayer';
import { LibraryView } from './components/LibraryView';
import { MiniPlayer } from './components/MiniPlayer';
import { MobileNav } from './components/MobileNav';
import { SharedLiveStudioModal } from './components/SharedLiveStudioModal';
import { StreamView } from './components/StreamView';
import { SyncLyricsView } from './components/SyncLyricsView';
import { TopBar } from './components/TopBar';
import { CURATED_STREAM_BANK, PROCEDURAL_STEMS } from './data/presetsAndStems';
import { localDb } from './db/localDb';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import type {
  ActiveTab,
  AudioEngineSnapshot,
  DspSettings,
  Playlist,
  StoredLyrics,
  Track,
} from './types/audio';
import { readAudioFileTags } from './utils/audioMetadata';

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [engine, setEngine] = useState<AudioEngineSnapshot>(() => audioEngine.getSnapshot());
  const [dsp, setDsp] = useState<DspSettings>(() => audioEngine.getDspSettings());

  const [savedTracks, setSavedTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => localDb.loadFavorites());
  const [lyricsMap, setLyricsMap] = useState<Record<string, StoredLyrics>>({});
  const [queue, setQueue] = useState<Track[]>(PROCEDURAL_STEMS);

  const [isDspOpen, setIsDspOpen] = useState(false);
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const [isLiveStudioOpen, setIsLiveStudioOpen] = useState(false);

  const songPickerRef = useRef<HTMLInputElement | null>(null);

  // Hydrate offline DB on startup
  useEffect(() => {
    let active = true;
    (async () => {
      const [dbTracks, dbPlaylists, dbLyrics] = await Promise.all([
        localDb.loadTracks(),
        localDb.loadPlaylists(),
        localDb.loadAllLyrics(),
      ]);
      if (!active) return;
      setSavedTracks(dbTracks);
      setPlaylists(dbPlaylists);
      setLyricsMap(dbLyrics);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Combined track catalog (Procedural Stems + Local/Saved Library)
  const allLibraryTracks = useMemo(() => {
    const stemIds = new Set(PROCEDURAL_STEMS.map((s) => s.id));
    const userTracks = savedTracks.filter((t) => !stemIds.has(t.id));
    return [...PROCEDURAL_STEMS, ...userTracks];
  }, [savedTracks]);

  const studioCandidateTracks = useMemo(() => {
    const seen = new Set(allLibraryTracks.map((t) => t.id));
    return [...allLibraryTracks, ...CURATED_STREAM_BANK.filter((c) => !seen.has(c.id))];
  }, [allLibraryTracks]);

  const playTrack = useCallback((track: Track) => {
    setQueue((prev) => (prev.some((t) => t.id === track.id) ? prev : [...prev, track]));
    void audioEngine.playTrack(track);
  }, []);

  const handleNext = useCallback(() => {
    if (queue.length === 0) return;
    const currentIdx = queue.findIndex((t) => t.id === engine.currentTrack?.id);
    const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % queue.length : 0;
    void audioEngine.playTrack(queue[nextIdx]);
  }, [queue, engine.currentTrack?.id]);

  const handlePrev = useCallback(() => {
    if (queue.length === 0) return;
    if (engine.currentTime > 3) {
      audioEngine.seek(0);
      return;
    }
    const currentIdx = queue.findIndex((t) => t.id === engine.currentTrack?.id);
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : queue.length - 1;
    void audioEngine.playTrack(queue[prevIdx]);
  }, [queue, engine.currentTrack?.id, engine.currentTime]);

  // Subscribe to Dual-Channel Audio Engine snapshots
  useEffect(() => {
    const unsubSnap = audioEngine.subscribe(setEngine);
    return () => {
      unsubSnap();
    };
  }, []);

  useEffect(() => {
    const unsubEnd = audioEngine.onTrackEnd(() => {
      handleNext();
    });
    return () => {
      unsubEnd();
    };
  }, [handleNext]);

  const handleNextRef = useRef(handleNext);
  const handlePrevRef = useRef(handlePrev);
  handleNextRef.current = handleNext;
  handlePrevRef.current = handlePrev;
  const lastPositionSyncRef = useRef<number>(0);

  // Sync device lock-screen Media Session metadata & action handlers (only on track change)
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const track = engine.currentTrack;
    if (!track) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.artworkUrl
          ? [{ src: track.artworkUrl, sizes: '512x512', type: 'image/jpeg' }]
          : [],
      });
      navigator.mediaSession.setActionHandler('play', () => void audioEngine.togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => void audioEngine.togglePlay());
      navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevRef.current());
      navigator.mediaSession.setActionHandler('nexttrack', () => handleNextRef.current());
      navigator.mediaSession.setActionHandler('seekbackward', () => audioEngine.seekBy(-10));
      navigator.mediaSession.setActionHandler('seekforward', () => audioEngine.seekBy(10));
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') {
          audioEngine.seek(details.seekTime);
        }
      });
    } catch {
      // Ignore MediaSession errors on unsupported environments
    }
  }, [engine.currentTrack?.id]);

  // Sync Media Session playbackState & throttled positionState
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (!engine.currentTrack) return;

    try {
      navigator.mediaSession.playbackState = engine.isPlaying ? 'playing' : 'paused';
      const now = Date.now();
      if (
        engine.duration > 0 &&
        typeof navigator.mediaSession.setPositionState === 'function' &&
        now - lastPositionSyncRef.current >= 2000
      ) {
        lastPositionSyncRef.current = now;
        navigator.mediaSession.setPositionState({
          duration: engine.duration,
          playbackRate: 1,
          position: Math.min(engine.currentTime, engine.duration),
        });
      }
    } catch {
      // Ignore MediaSession errors
    }
  }, [engine.currentTrack?.id, engine.isPlaying, engine.currentTime, engine.duration]);

  const handleQuickPlay = () => {
    const first = queue[0] || PROCEDURAL_STEMS[0];
    if (first) playTrack(first);
  };

  const handleToggleFavorite = (trackId: string) => {
    setFavoriteIds((prev) => {
      const next = prev.includes(trackId)
        ? prev.filter((id) => id !== trackId)
        : [...prev, trackId];
      localDb.saveFavorites(next);
      return next;
    });
  };

  const handleUpdateDsp = (next: DspSettings) => {
    setDsp(next);
    audioEngine.updateDspSettings(next);
  };

  const handleResetFlat = () => {
    const next = audioEngine.resetDspFlat();
    setDsp(next);
  };

  const handleSaveTrackToLibrary = async (track: Track) => {
    setSavedTracks((prev) => (prev.some((t) => t.id === track.id) ? prev : [track, ...prev]));
    await localDb.saveTrack(track);
  };

  const handleImportTracks = async (entries: Array<{ track: Track; file: File }>) => {
    for (const { track, file } of entries) {
      await localDb.saveTrack(track, file);
    }
    setSavedTracks((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const newOnes = entries.map((e) => e.track).filter((t) => !existingIds.has(t.id));
      return [...newOnes, ...prev];
    });
  };

  const handlePickSongFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const imported: Array<{ track: Track; file: File }> = [];
    for (const file of files) {
      const meta = await readAudioFileTags(file, 'Picked Songs');
      const track: Track = {
        id: `local-${file.name}-${file.size}-${file.lastModified}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        trackNumber: meta.trackNumber,
        duration: 180,
        source: 'local',
        folderPath: 'Picked Songs',
        addedAt: Date.now(),
      };
      imported.push({ track, file });
    }

    await handleImportTracks(imported);
    if (imported[0]) {
      playTrack(imported[0].track);
    }
    e.target.value = '';
  };

  const handleCreatePlaylist = async (name: string, description: string) => {
    const pl: Playlist = {
      id: `pl-${Date.now().toString(36)}`,
      name,
      description,
      trackIds: [],
      createdAt: Date.now(),
    };
    setPlaylists((prev) => [pl, ...prev]);
    await localDb.savePlaylist(pl);
  };

  const handleDeletePlaylist = async (playlistId: string) => {
    setPlaylists((prev) => prev.filter((p) => p.id !== playlistId));
    await localDb.deletePlaylist(playlistId);
  };

  const handleAddTrackToPlaylist = async (playlistId: string, trackId: string) => {
    let updated: Playlist | null = null;
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id !== playlistId) return pl;
        if (pl.trackIds.includes(trackId)) {
          updated = pl;
          return pl;
        }
        updated = { ...pl, trackIds: [...pl.trackIds, trackId] };
        return updated;
      })
    );
    if (updated) {
      await localDb.savePlaylist(updated);
    }
  };

  const handleDeleteTrack = async (trackId: string) => {
    setSavedTracks((prev) => prev.filter((t) => t.id !== trackId));
    setQueue((prev) => prev.filter((t) => t.id !== trackId));
    await localDb.deleteTrack(trackId);
  };

  const handleSaveLyrics = async (entry: StoredLyrics) => {
    setLyricsMap((prev) => ({ ...prev, [entry.trackId]: entry }));
    await localDb.saveLyrics(entry);
  };

  const handleUpdateLyricsOffset = async (trackId: string, offsetSeconds: number) => {
    const existing = lyricsMap[trackId];
    const track = allLibraryTracks.find((t) => t.id === trackId);
    const entry: StoredLyrics = {
      trackId,
      rawLrc: existing?.rawLrc ?? track?.lrcLyrics ?? '',
      offsetSeconds,
      updatedAt: Date.now(),
    };
    await handleSaveLyrics(entry);
  };

  return (
    <div className="min-h-screen bg-black text-[#F4F3F0]">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenDsp={() => setIsDspOpen(true)}
        isOnline={isOnline}
        isPlaying={engine.isPlaying}
      />

      <input
        ref={songPickerRef}
        type="file"
        multiple
        accept="audio/*"
        onChange={handlePickSongFiles}
        className="hidden"
      />

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 pb-40 md:pb-28">
        {activeTab === 'dashboard' && (
          <DashboardView
            engine={engine}
            dsp={dsp}
            storedTrackCount={allLibraryTracks.length}
            onQuickPlay={handleQuickPlay}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onPlayTrack={playTrack}
            onOpenDsp={() => setIsDspOpen(true)}
            onPickSong={() => songPickerRef.current?.click()}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === 'stream' && (
          <StreamView
            engine={engine}
            onPlayTrack={playTrack}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onAddToQueue={(t) =>
              setQueue((prev) => (prev.some((q) => q.id === t.id) ? prev : [...prev, t]))
            }
            onSaveTrackToLibrary={(t) => void handleSaveTrackToLibrary(t)}
          />
        )}

        {activeTab === 'library' && (
          <LibraryView
            tracks={allLibraryTracks}
            playlists={playlists}
            favoriteIds={favoriteIds}
            engine={engine}
            onPlayTrack={playTrack}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onAddToQueue={(t) =>
              setQueue((prev) => (prev.some((q) => q.id === t.id) ? prev : [...prev, t]))
            }
            onToggleFavorite={handleToggleFavorite}
            onPickSong={() => songPickerRef.current?.click()}
            onPickFolder={() => setActiveTab('scanner')}
            onOpenLiveStudio={() => setIsLiveStudioOpen(true)}
            onCreatePlaylist={(name, desc) => void handleCreatePlaylist(name, desc)}
            onDeletePlaylist={(id) => void handleDeletePlaylist(id)}
            onAddTrackToPlaylist={(plId, trId) => void handleAddTrackToPlaylist(plId, trId)}
            onDeleteTrack={(id) => void handleDeleteTrack(id)}
          />
        )}

        {activeTab === 'scanner' && (
          <FolderScannerView onImportTracks={handleImportTracks} />
        )}

        {activeTab === 'lyrics' && (
          <SyncLyricsView
            tracks={allLibraryTracks}
            engine={engine}
            lyricsMap={lyricsMap}
            onSaveLyrics={handleSaveLyrics}
            onSeek={(sec) => audioEngine.seek(sec)}
            onPlayTrack={playTrack}
          />
        )}
      </main>

      <MiniPlayer
        track={engine.currentTrack}
        isPlaying={engine.isPlaying}
        currentTime={engine.currentTime}
        duration={engine.duration}
        isFavorite={engine.currentTrack ? favoriteIds.includes(engine.currentTrack.id) : false}
        onTogglePlay={() => void audioEngine.togglePlay()}
        onSeekBy={(sec) => audioEngine.seekBy(sec)}
        onNext={handleNext}
        onToggleFavorite={handleToggleFavorite}
        onExpand={() => setIsFullscreenOpen(true)}
      />

      <MobileNav activeTab={activeTab} onSelectTab={setActiveTab} />

      <DspStudioModal
        isOpen={isDspOpen}
        onClose={() => setIsDspOpen(false)}
        dsp={dsp}
        onUpdateDsp={handleUpdateDsp}
        onResetFlat={handleResetFlat}
      />

      <FullscreenPlayer
        isOpen={isFullscreenOpen}
        onClose={() => setIsFullscreenOpen(false)}
        track={engine.currentTrack}
        isPlaying={engine.isPlaying}
        currentTime={engine.currentTime}
        duration={engine.duration}
        queue={queue}
        dsp={dsp}
        isFavorite={engine.currentTrack ? favoriteIds.includes(engine.currentTrack.id) : false}
        storedLyrics={engine.currentTrack ? lyricsMap[engine.currentTrack.id] : undefined}
        onTogglePlay={() => void audioEngine.togglePlay()}
        onSeek={(sec) => audioEngine.seek(sec)}
        onSeekBy={(sec) => audioEngine.seekBy(sec)}
        onNext={handleNext}
        onPrev={handlePrev}
        onPlayTrack={playTrack}
        onRemoveFromQueue={(id) => setQueue((prev) => prev.filter((t) => t.id !== id))}
        onToggleFavorite={handleToggleFavorite}
        onOpenDsp={() => setIsDspOpen(true)}
        onUpdateLyricsOffset={(id, offset) => void handleUpdateLyricsOffset(id, offset)}
      />

      <SharedLiveStudioModal
        isOpen={isLiveStudioOpen}
        onClose={() => setIsLiveStudioOpen(false)}
        availableTracks={studioCandidateTracks}
        onPlayTrack={playTrack}
      />
    </div>
  );
}

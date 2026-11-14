import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from './audio/AudioEngine';
import { DashboardView } from './components/DashboardView';
import { DspStudioModal } from './components/DspStudioModal';
import { FloatingPipWindow } from './components/FloatingPipWindow';
import { FolderScannerView } from './components/FolderScannerView';
import { FullscreenPlayer } from './components/FullscreenPlayer';
import { LibraryView } from './components/LibraryView';
import { MiniPlayer } from './components/MiniPlayer';
import { MobileNav } from './components/MobileNav';
import { SearchView } from './components/SearchView';
import { SettingsView } from './components/SettingsView';
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
import {
  buildTracksFromFilePairs,
  importFromNativeFolderPicker,
} from './utils/folderImporter';
import {
  hasNativeFolderPicker,
  requestNativeNotificationPermission,
  subscribeNativeMediaActions,
  subscribeNativePipState,
  syncNativeNowPlaying,
} from './utils/nativeMediaBridge';
import { mergeAutoplayQueue } from './utils/streamFilter';
import { fetchRelatedRadioTracks } from './utils/streamRadio';

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
  const [isInAppPip, setIsInAppPip] = useState(false);
  const [isNativePip, setIsNativePip] = useState(false);
  const [autoplayRadioEnabled, setAutoplayRadioEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('kago_autoplay_radio');
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
    }
  });
  const [isFetchingRadio, setIsFetchingRadio] = useState(false);

  const songPickerRef = useRef<HTMLInputElement | null>(null);
  const folderPickerRef = useRef<HTMLInputElement | null>(null);
  const nativePipStageRef = useRef<HTMLDivElement | null>(null);
  const requestedNotifPermRef = useRef(false);
  const radioSeedEpochRef = useRef(0);
  const playedHistoryIdsRef = useRef<Set<string>>(new Set());

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

  const populateRelatedRadio = useCallback(
    async (seedTrack: Track, replaceExistingAuto: boolean) => {
      if (!autoplayRadioEnabled || seedTrack.source !== 'stream') return;
      const epoch = ++radioSeedEpochRef.current;
      setIsFetchingRadio(true);
      try {
        const excludeIds = Array.from(playedHistoryIdsRef.current);
        const related = await fetchRelatedRadioTracks(seedTrack, excludeIds);
        if (epoch !== radioSeedEpochRef.current || related.length === 0) return;
        setQueue((prev) =>
          mergeAutoplayQueue(prev, seedTrack, related, {
            replaceExistingAuto,
            maxAutoTracks: 10,
          })
        );
      } finally {
        if (epoch === radioSeedEpochRef.current) {
          setIsFetchingRadio(false);
        }
      }
    },
    [autoplayRadioEnabled]
  );

  const playTrack = useCallback(
    (track: Track) => {
      playedHistoryIdsRef.current.add(track.id);
      if (track.source === 'stream') {
        if (track.autoQueued) {
          // Promoted from auto radio -> keep existing upcoming songs and top up if running low
          setQueue((prev) => {
            const next = prev.map((t) => (t.id === track.id ? { ...t, autoQueued: false } : t));
            const idx = next.findIndex((t) => t.id === track.id);
            const remaining = idx >= 0 ? next.length - 1 - idx : 0;
            if (remaining <= 2) {
              void populateRelatedRadio(track, false);
            }
            return next;
          });
        } else {
          // User explicitly picked a new song to stream -> seed Spotify-style related queue
          setQueue((prev) => {
            const stemIds = new Set(PROCEDURAL_STEMS.map((s) => s.id));
            const preserved = prev.filter(
              (t) => t.id !== track.id && !t.autoQueued && !stemIds.has(t.id)
            );
            return [track, ...preserved];
          });
          void populateRelatedRadio(track, true);
        }
      } else {
        setQueue((prev) => (prev.some((t) => t.id === track.id) ? prev : [...prev, track]));
      }
      void audioEngine.playTrack(track);
    },
    [populateRelatedRadio]
  );

  const handleToggleAutoplayRadio = useCallback(() => {
    setAutoplayRadioEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('kago_autoplay_radio', String(next));
      } catch {
        // Ignore storage quota errors
      }
      if (next && engine.currentTrack?.source === 'stream') {
        void populateRelatedRadio(engine.currentTrack, false);
      }
      return next;
    });
  }, [engine.currentTrack, populateRelatedRadio]);

  const handleNext = useCallback(() => {
    if (queue.length === 0) return;
    const currentIdx = queue.findIndex((t) => t.id === engine.currentTrack?.id);
    const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % queue.length : 0;
    const nextTrack = queue[nextIdx];
    playedHistoryIdsRef.current.add(nextTrack.id);

    const remainingAfterNext = queue.length - 1 - nextIdx;
    if (autoplayRadioEnabled && nextTrack.source === 'stream' && remainingAfterNext <= 2) {
      void populateRelatedRadio(nextTrack, false);
    }

    void audioEngine.playTrack(nextTrack);
  }, [queue, engine.currentTrack?.id, autoplayRadioEnabled, populateRelatedRadio]);

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

  // Subscribe to Android native MediaSession (Samsung Now Bar / Lockscreen) & native PiP
  useEffect(() => {
    const unsubMedia = subscribeNativeMediaActions((detail) => {
      if (detail.action === 'play' || detail.action === 'pause' || detail.action === 'toggle') {
        void audioEngine.togglePlay();
      } else if (detail.action === 'next') {
        handleNextRef.current();
      } else if (detail.action === 'prev') {
        handlePrevRef.current();
      } else if (detail.action === 'seek') {
        audioEngine.seek(detail.positionMs / 1000);
      }
    });
    const unsubPip = subscribeNativePipState((active) => {
      setIsNativePip(active);
    });
    return () => {
      unsubMedia();
      unsubPip();
    };
  }, []);

  // Close topmost overlay (Equalizer -> Shared Live Studio -> Fullscreen Player) on Escape or Android Back
  const hasOpenOverlay = isDspOpen || isLiveStudioOpen || isFullscreenOpen;
  useEffect(() => {
    if (!hasOpenOverlay) return;
    try {
      if (window.history.state?.kagoOverlay !== true) {
        window.history.pushState({ kagoOverlay: true }, '');
      }
    } catch {
      // Ignore restricted history state in sandboxed frames
    }

    const closeTopmost = () => {
      if (isDspOpen) {
        setIsDspOpen(false);
      } else if (isLiveStudioOpen) {
        setIsLiveStudioOpen(false);
      } else if (isFullscreenOpen) {
        setIsFullscreenOpen(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeTopmost();
      }
    };

    const onPopState = () => {
      closeTopmost();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
    };
  }, [hasOpenOverlay, isDspOpen, isLiveStudioOpen, isFullscreenOpen]);

  // Dock YouTube iframe edge-to-edge when Android enters OS Picture-in-Picture
  useEffect(() => {
    if (!isNativePip || !engine.currentTrack?.youtubeId) return;
    const el = nativePipStageRef.current;
    if (!el) return;
    const detach = audioEngine.attachYouTubeViewport(el, 110);
    return () => {
      detach();
    };
  }, [isNativePip, engine.currentTrack?.youtubeId]);

  const lastNativeSyncRef = useRef<number>(0);

  // Sync device lock-screen Media Session + Android KaGoMediaService (Samsung Now Bar)
  useEffect(() => {
    const track = engine.currentTrack;
    if (!track) return;

    if (engine.isPlaying && !requestedNotifPermRef.current) {
      requestedNotifPermRef.current = true;
      requestNativeNotificationPermission();
    }

    syncNativeNowPlaying({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSeconds: engine.duration || track.duration,
      currentTimeSeconds: engine.currentTime,
      isPlaying: engine.isPlaying,
      artworkUrl: track.artworkUrl,
    });
    lastNativeSyncRef.current = Date.now();

    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

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
  }, [engine.currentTrack?.id, engine.isPlaying]);

  // Sync Media Session & Native Samsung Now Bar playback position throttled every 1.5s
  useEffect(() => {
    const track = engine.currentTrack;
    if (!track) return;
    const now = Date.now();

    if (now - lastNativeSyncRef.current >= 1500) {
      lastNativeSyncRef.current = now;
      syncNativeNowPlaying({
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationSeconds: engine.duration || track.duration,
        currentTimeSeconds: engine.currentTime,
        isPlaying: engine.isPlaying,
        artworkUrl: track.artworkUrl,
      });
    }

    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = engine.isPlaying ? 'playing' : 'paused';
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

  const [folderImportStatus, setFolderImportStatus] = useState<string>('');

  const handlePickFolderInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setFolderImportStatus(`Scanning 0 / ${files.length} files...`);
    try {
      const pairs = files.map((file) => {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
        const folderPath = rel ? rel.split('/').slice(0, -1).join('/') : 'Picked Folder';
        return { file, folderPath };
      });
      const imported = await buildTracksFromFilePairs(pairs, (p) => {
        setFolderImportStatus(`Importing ${p.scanned} / ${p.found}: ${p.currentFile}`);
      });
      if (imported.length > 0) {
        await handleImportTracks(imported);
        setActiveTab('library');
        if (!engine.currentTrack) {
          playTrack(imported[0].track);
        }
      }
    } finally {
      setFolderImportStatus('');
      e.target.value = '';
    }
  };

  const handlePickFolder = useCallback(async () => {
    if (hasNativeFolderPicker()) {
      setFolderImportStatus('Opening Android folder picker...');
      try {
        const result = await importFromNativeFolderPicker((p) => {
          setFolderImportStatus(`Importing ${p.scanned} / ${p.found}: ${p.currentFile}`);
        });
        if (!result.cancelled && !result.error && result.entries.length > 0) {
          await handleImportTracks(result.entries);
          setActiveTab('library');
          if (!engine.currentTrack) {
            playTrack(result.entries[0].track);
          }
        }
      } finally {
        setFolderImportStatus('');
      }
      return;
    }

    const inIframe = typeof window !== 'undefined' && window.self !== window.top;
    const picker = !inIframe
      ? (
          window as unknown as {
            showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker
      : undefined;

    if (typeof picker === 'function') {
      try {
        const rootHandle = await picker();
        setFolderImportStatus(`Scanning ${rootHandle.name}...`);
        const collected: Array<{ file: File; folderPath: string }> = [];
        const walk = async (dirHandle: FileSystemDirectoryHandle, prefix: string) => {
          const entries = (
            dirHandle as unknown as {
              values: () => AsyncIterable<FileSystemHandle>;
            }
          ).values();
          for await (const entry of entries) {
            if (entry.kind === 'file') {
              const file = await (entry as FileSystemFileHandle).getFile();
              collected.push({ file, folderPath: prefix || rootHandle.name });
            } else if (entry.kind === 'directory') {
              await walk(entry as FileSystemDirectoryHandle, `${prefix}/${entry.name}`);
            }
          }
        };
        await walk(rootHandle, rootHandle.name);
        const imported = await buildTracksFromFilePairs(collected, (p) => {
          setFolderImportStatus(`Importing ${p.scanned} / ${p.found}: ${p.currentFile}`);
        });
        if (imported.length > 0) {
          await handleImportTracks(imported);
          setActiveTab('library');
          if (!engine.currentTrack) {
            playTrack(imported[0].track);
          }
        }
        setFolderImportStatus('');
        return;
      } catch (err) {
        setFolderImportStatus('');
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }

    folderPickerRef.current?.click();
  }, [engine.currentTrack, playTrack]);

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
      <input
        ref={folderPickerRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is standard in Chromium/WebKit
        webkitdirectory="true"
        accept="audio/*"
        onChange={handlePickFolderInput}
        className="hidden"
      />

      <main className="mx-auto max-w-[1440px] px-3.5 py-4 sm:px-6 sm:py-6 lg:px-8 pb-[calc(9.5rem+env(safe-area-inset-bottom))] md:pb-28">
        {folderImportStatus && (
          <div className="mb-4 rounded-xl border border-[#E11D48]/50 bg-[#15090E] px-4 py-2.5 font-mono-tabular text-xs text-[#FDA4AF]">
            {folderImportStatus}
          </div>
        )}
        {activeTab === 'dashboard' && (
          <DashboardView
            engine={engine}
            dsp={dsp}
            storedTrackCount={allLibraryTracks.length}
            isInAppPip={isInAppPip}
            onToggleInAppPip={() => setIsInAppPip((prev) => !prev)}
            onQuickPlay={handleQuickPlay}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onPlayTrack={playTrack}
            onOpenDsp={() => setIsDspOpen(true)}
            onPickSong={() => songPickerRef.current?.click()}
            onPickFolder={() => void handlePickFolder()}
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
            onPickFolder={() => void handlePickFolder()}
            onOpenLiveStudio={() => setIsLiveStudioOpen(true)}
            onCreatePlaylist={(name, desc) => void handleCreatePlaylist(name, desc)}
            onDeletePlaylist={(id) => void handleDeletePlaylist(id)}
            onAddTrackToPlaylist={(plId, trId) => void handleAddTrackToPlaylist(plId, trId)}
            onDeleteTrack={(id) => void handleDeleteTrack(id)}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsView
            dsp={dsp}
            storedTrackCount={allLibraryTracks.length}
            isOnline={isOnline}
            autoplayRadioEnabled={autoplayRadioEnabled}
            onToggleAutoplayRadio={handleToggleAutoplayRadio}
            onOpenDsp={() => setIsDspOpen(true)}
            onUpdateDsp={handleUpdateDsp}
            onPickSong={() => songPickerRef.current?.click()}
            onPickFolder={() => void handlePickFolder()}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === 'search' && (
          <SearchView
            libraryTracks={allLibraryTracks}
            engine={engine}
            onPlayTrack={playTrack}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onAddToQueue={(t) =>
              setQueue((prev) => (prev.some((q) => q.id === t.id) ? prev : [...prev, t]))
            }
            onSaveTrackToLibrary={(t) => void handleSaveTrackToLibrary(t)}
            onPickSong={() => songPickerRef.current?.click()}
            onPickFolder={() => void handlePickFolder()}
          />
        )}

        {activeTab === 'scanner' && (
          <FolderScannerView
            onImportTracks={handleImportTracks}
            onPickSong={() => songPickerRef.current?.click()}
            onBack={() => setActiveTab('settings')}
          />
        )}

        {activeTab === 'lyrics' && (
          <SyncLyricsView
            tracks={allLibraryTracks}
            engine={engine}
            lyricsMap={lyricsMap}
            onSaveLyrics={handleSaveLyrics}
            onSeek={(sec) => audioEngine.seek(sec)}
            onPlayTrack={playTrack}
            onBack={() => setActiveTab('settings')}
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
        isInAppPip={isInAppPip}
        onToggleInAppPip={() => setIsInAppPip((prev) => !prev)}
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
        onOpenStream={() => setActiveTab('stream')}
        autoplayRadioEnabled={autoplayRadioEnabled}
        isFetchingRadio={isFetchingRadio}
        onToggleAutoplayRadio={handleToggleAutoplayRadio}
      />

      <DspStudioModal
        isOpen={isDspOpen}
        onClose={() => setIsDspOpen(false)}
        dsp={dsp}
        onUpdateDsp={handleUpdateDsp}
        onResetFlat={handleResetFlat}
      />

      <FloatingPipWindow
        isOpen={isInAppPip && !isNativePip}
        track={engine.currentTrack}
        isPlaying={engine.isPlaying}
        onTogglePlay={() => void audioEngine.togglePlay()}
        onExpand={() => {
          setIsInAppPip(false);
          setIsFullscreenOpen(true);
        }}
        onClose={() => setIsInAppPip(false)}
      />

      {isNativePip && (
        <div
          ref={nativePipStageRef}
          aria-label="Android Picture-in-Picture Player"
          className="fixed inset-0 z-[100] bg-black flex items-center justify-center"
        />
      )}

      <SharedLiveStudioModal
        isOpen={isLiveStudioOpen}
        onClose={() => setIsLiveStudioOpen(false)}
        availableTracks={studioCandidateTracks}
        onPlayTrack={playTrack}
      />
    </div>
  );
}

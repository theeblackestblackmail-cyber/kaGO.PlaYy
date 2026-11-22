import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Loader2, Radio, WifiOff, X } from 'lucide-react';
import { audioEngine } from './audio/AudioEngine';
import { DashboardView } from './components/DashboardView';
import { DownloadSheetModal, type DownloadTarget } from './components/DownloadSheetModal';
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
  LibrarySubTab,
  Playlist,
  StoredLyrics,
  Track,
} from './types/audio';
import { readAudioFileTags } from './utils/audioMetadata';
import {
  buildTracksFromFilePairs,
  importFromNativeFolderPicker,
  mergeImportedTracks,
  resolveFolderPathFromRelativePath,
} from './utils/folderImporter';
import { fetchYouTubePlaylistByUrlOrId } from './utils/youtubePlaylist';
import {
  hasNativeFolderPicker,
  requestNativeNotificationPermission,
  subscribeNativeMediaActions,
  subscribeNativePipState,
  syncNativeNowPlaying,
} from './utils/nativeMediaBridge';
import {
  buildCollectionQueue,
  enqueueImportedOfflineTracks,
  mergeAutoplayQueue,
  reorderQueueItems,
} from './utils/streamFilter';
import {
  evaluatePoorConnectionState,
  insertPlayNextTracks,
  POOR_CONNECTION_THRESHOLD_MS,
  reorderMultipleQueueItems,
  restoreQueueOrder,
  selectSmartLibraryTracks,
  shuffleQueuePreservingCurrent,
} from './utils/queueUtils';
import { fetchSyncedLyricsForTrack } from './utils/lyricsFetcher';
import { triggerHaptic } from './utils/haptics';
import { fetchRelatedRadioTracks } from './utils/streamRadio';
import {
  applyThemeToDocument,
  DEFAULT_ACCENT_HEX,
  loadThemePreferences,
  saveThemePreferences,
  type ThemeMode,
  type ThemePreferences,
} from './utils/themeManager';
import {
  loadVisualizerPalette,
  saveVisualizerPalette,
  type VisualizerPaletteId,
} from './utils/visualizerUtils';
import {
  downloadTrackToAppStorage,
  downloadTrackToLocalDevice,
  type DownloadFormatId,
} from './utils/streamDownloads';

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [engine, setEngine] = useState<AudioEngineSnapshot>(() => audioEngine.getSnapshot());
  const [dsp, setDsp] = useState<DspSettings>(() => audioEngine.getDspSettings());

  const [savedTracks, setSavedTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => localDb.loadFavorites());
  const [lyricsMap, setLyricsMap] = useState<Record<string, StoredLyrics>>({});
  const [queue, setQueue] = useState<Track[]>([]);

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
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [preShuffleOrderIds, setPreShuffleOrderIds] = useState<string[] | null>(null);
  const [smartShuffleEnabled, setSmartShuffleEnabled] = useState<boolean>(() =>
    localDb.loadSmartShuffle()
  );
  const [showOfflineSwitchPrompt, setShowOfflineSwitchPrompt] = useState(false);
  const [isFetchingRadio, setIsFetchingRadio] = useState(false);
  const [isFetchingLyrics, setIsFetchingLyrics] = useState(false);
  const [lyricsHydrated, setLyricsHydrated] = useState(false);
  const [themePrefs, setThemePrefs] = useState<ThemePreferences>(() => loadThemePreferences());
  const [visualizerPalette, setVisualizerPalette] = useState<VisualizerPaletteId>(() =>
    loadVisualizerPalette()
  );
  const [libraryFocusRequest, setLibraryFocusRequest] = useState<{
    subTab: LibrarySubTab;
    groupName?: string | null;
    nonce: number;
  } | null>(null);
  const [downloadModalState, setDownloadModalState] = useState<{
    target: DownloadTarget;
    initialStep: 'choice' | 'formats';
  } | null>(null);
  const [activeDownload, setActiveDownload] = useState<{
    label: string;
    current: number;
    total: number;
    percent: number;
    mode: 'app' | 'device';
  } | null>(null);
  const [downloadToast, setDownloadToast] = useState<{
    text: string;
    isError?: boolean;
  } | null>(null);
  const downloadToastTimerRef = useRef<number | null>(null);
  const folderStatusTimerRef = useRef<number | null>(null);
  const playlistsRef = useRef<Playlist[]>(playlists);
  playlistsRef.current = playlists;

  useEffect(() => {
    applyThemeToDocument(themePrefs);
    saveThemePreferences(themePrefs);
  }, [themePrefs]);

  const handleChangeVisualizerPalette = useCallback((nextId: VisualizerPaletteId) => {
    setVisualizerPalette(nextId);
    saveVisualizerPalette(nextId);
  }, []);

  const songPickerRef = useRef<HTMLInputElement | null>(null);
  const folderPickerRef = useRef<HTMLInputElement | null>(null);
  const nativePipStageRef = useRef<HTMLDivElement | null>(null);
  const requestedNotifPermRef = useRef(false);
  const radioSeedEpochRef = useRef(0);
  const playedHistoryIdsRef = useRef<Set<string>>(new Set());
  const fetchingLyricsIdsRef = useRef<Set<string>>(new Set());
  const attemptedLyricsIdsRef = useRef<Set<string>>(new Set());
  const lastStreamProgressRef = useRef<{ trackId: string | null; time: number; atMs: number }>({
    trackId: null,
    time: 0,
    atMs: 0,
  });
  const badConnSinceRef = useRef<number | null>(null);
  const dismissedBadSinceRef = useRef<number | null>(null);

  // Hydrate offline DB on startup (excluding removed built-in demo synth tracks)
  useEffect(() => {
    let active = true;
    (async () => {
      const [dbTracks, dbPlaylists, dbLyrics] = await Promise.all([
        localDb.loadTracks(),
        localDb.loadPlaylists(),
        localDb.loadAllLyrics(),
      ]);
      if (!active) return;

      const legacyStemIds = new Set([
        'stem-cyber-resonance',
        'stem-neon-drive',
        'stem-midnight-drift',
        'stem-tokyo-2099',
        ...PROCEDURAL_STEMS.map((s) => s.id),
      ]);
      const cleanedTracks = dbTracks.filter((t) => !legacyStemIds.has(t.id));

      setSavedTracks(cleanedTracks);
      setPlaylists(dbPlaylists);
      setLyricsMap(dbLyrics);
      setLyricsHydrated(true);

      // Seed saved user songs into the queue on startup so Quick Play & Next play them automatically
      if (cleanedTracks.length > 0 && !audioEngine.getSnapshot().currentTrack) {
        setQueue((prev) => enqueueImportedOfflineTracks(prev, cleanedTracks, legacyStemIds));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Combined user track catalog
  const allLibraryTracks = useMemo(() => savedTracks, [savedTracks]);

  const studioCandidateTracks = useMemo(() => {
    const seen = new Set(allLibraryTracks.map((t) => t.id));
    return [...allLibraryTracks, ...CURATED_STREAM_BANK.filter((c) => !seen.has(c.id))];
  }, [allLibraryTracks]);

  const syncLyricsTracks = useMemo(() => {
    const cur = engine.currentTrack;
    if (!cur || allLibraryTracks.some((t) => t.id === cur.id)) {
      return allLibraryTracks;
    }
    return [cur, ...allLibraryTracks];
  }, [allLibraryTracks, engine.currentTrack]);

  const appendSmartLibraryQueue = useCallback(
    (baseQueue: Track[], extraExcludeIds: string[] = [], limit = 6): Track[] => {
      const counts = localDb.loadPlayCounts();
      const exclude = new Set<string>([
        ...baseQueue.map((t) => t.id),
        ...extraExcludeIds,
      ]);
      const picks = selectSmartLibraryTracks(allLibraryTracks, counts, exclude, limit);
      if (picks.length === 0) return baseQueue;
      return [...baseQueue, ...picks];
    },
    [allLibraryTracks]
  );

  const populateRelatedRadio = useCallback(
    async (seedTrack: Track, replaceExistingAuto: boolean) => {
      if (!autoplayRadioEnabled || seedTrack.source !== 'stream') return;
      const epoch = ++radioSeedEpochRef.current;
      setIsFetchingRadio(true);
      try {
        const excludeIds = Array.from(playedHistoryIdsRef.current);
        const related = await fetchRelatedRadioTracks(seedTrack, excludeIds);
        if (epoch !== radioSeedEpochRef.current) return;
        const counts = localDb.loadPlayCounts();
        setQueue((prev) => {
          const withRelated =
            related.length > 0
              ? mergeAutoplayQueue(prev, seedTrack, related, {
                  replaceExistingAuto,
                  maxAutoTracks: smartShuffleEnabled ? 6 : 10,
                })
              : prev;
          if (!smartShuffleEnabled) return withRelated;
          const exclude = new Set<string>([
            ...withRelated.map((t) => t.id),
            ...excludeIds,
          ]);
          const smartPicks = selectSmartLibraryTracks(allLibraryTracks, counts, exclude, 4);
          return smartPicks.length > 0 ? [...withRelated, ...smartPicks] : withRelated;
        });
      } finally {
        if (epoch === radioSeedEpochRef.current) {
          setIsFetchingRadio(false);
        }
      }
    },
    [autoplayRadioEnabled, smartShuffleEnabled, allLibraryTracks]
  );

  const playTrack = useCallback(
    (track: Track) => {
      triggerHaptic('selection');
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
          setShuffleEnabled(false);
          setPreShuffleOrderIds(null);
          setQueue((prev) => {
            const stemIds = new Set(PROCEDURAL_STEMS.map((s) => s.id));
            const preserved = prev.filter(
              (t) => t.id !== track.id && !t.autoQueued && !stemIds.has(t.id)
            );
            const seeded = [track, ...preserved];
            if (smartShuffleEnabled && !autoplayRadioEnabled) {
              return appendSmartLibraryQueue(seeded, [track.id], 6);
            }
            return seeded;
          });
          void populateRelatedRadio(track, true);
        }
      } else {
        setQueue((prev) => {
          const stemIds = new Set(PROCEDURAL_STEMS.map((s) => s.id));
          let next: Track[];
          if (track.source === 'local' && prev.every((t) => stemIds.has(t.id))) {
            next = [track];
          } else {
            next = prev.some((t) => t.id === track.id) ? prev : [...prev, track];
          }
          if (smartShuffleEnabled) {
            const idx = next.findIndex((t) => t.id === track.id);
            const remaining = idx >= 0 ? next.length - 1 - idx : 0;
            if (remaining <= 2) {
              return appendSmartLibraryQueue(next, [track.id], 6);
            }
          }
          return next;
        });
      }
      void audioEngine.playTrack(track);
    },
    [populateRelatedRadio, smartShuffleEnabled, autoplayRadioEnabled, appendSmartLibraryQueue]
  );

  const playCollection = useCallback((tracks: Track[], startIndex = 0) => {
    const { queue: nextQueue, startTrack } = buildCollectionQueue(tracks, startIndex);
    if (!startTrack) return;
    triggerHaptic('selection');
    playedHistoryIdsRef.current.add(startTrack.id);
    setShuffleEnabled(false);
    setPreShuffleOrderIds(null);
    setQueue(nextQueue);
    void audioEngine.playTrack(startTrack);
  }, []);

  const handleReorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    triggerHaptic('medium', 12);
    setQueue((prev) => {
      const reordered = reorderQueueItems(prev, fromIndex, toIndex);
      const moved = reordered[toIndex];
      if (moved?.autoQueued) {
        return reordered.map((item, idx) =>
          idx === toIndex ? { ...item, autoQueued: false } : item
        );
      }
      return reordered;
    });
  }, []);

  const handleReorderMultipleQueue = useCallback(
    (selectedIndices: number[], targetIndex: number, draggedAnchorIndex?: number) => {
      triggerHaptic('medium', 12);
      setQueue((prev) => {
        const reordered = reorderMultipleQueueItems(
          prev,
          selectedIndices,
          targetIndex,
          draggedAnchorIndex
        );
        const movedIds = new Set(selectedIndices.map((idx) => prev[idx]?.id).filter(Boolean));
        return reordered.map((item) =>
          item.autoQueued && movedIds.has(item.id) ? { ...item, autoQueued: false } : item
        );
      });
    },
    []
  );

  const handleToggleShuffle = useCallback(() => {
    setShuffleEnabled((prevEnabled) => {
      if (!prevEnabled) {
        triggerHaptic('selection');
        setQueue((currentQueue) => {
          const { shuffledQueue, originalOrderIds } = shuffleQueuePreservingCurrent(
            currentQueue,
            engine.currentTrack?.id
          );
          setPreShuffleOrderIds(originalOrderIds);
          return shuffledQueue;
        });
        return true;
      }
      triggerHaptic('light');
      setQueue((currentQueue) => restoreQueueOrder(currentQueue, preShuffleOrderIds));
      setPreShuffleOrderIds(null);
      return false;
    });
  }, [engine.currentTrack?.id, preShuffleOrderIds]);

  const handleToggleSmartShuffle = useCallback(() => {
    setSmartShuffleEnabled((prev) => {
      const next = !prev;
      triggerHaptic(next ? 'selection' : 'light');
      localDb.saveSmartShuffle(next);
      if (next) {
        setQueue((currentQueue) => {
          const curId = engine.currentTrack?.id;
          const curIdx = curId ? currentQueue.findIndex((t) => t.id === curId) : -1;
          const remainingCount = curIdx >= 0 ? currentQueue.length - 1 - curIdx : currentQueue.length;
          if (remainingCount >= 5) return currentQueue;
          return appendSmartLibraryQueue(currentQueue, curId ? [curId] : [], 6);
        });
      }
      return next;
    });
  }, [engine.currentTrack?.id, appendSmartLibraryQueue]);

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
    if (remainingAfterNext <= 2) {
      if (autoplayRadioEnabled && nextTrack.source === 'stream') {
        void populateRelatedRadio(nextTrack, false);
      } else if (smartShuffleEnabled) {
        setQueue((prev) => appendSmartLibraryQueue(prev, [nextTrack.id], 6));
      }
    }

    void audioEngine.playTrack(nextTrack);
  }, [
    queue,
    engine.currentTrack?.id,
    autoplayRadioEnabled,
    smartShuffleEnabled,
    populateRelatedRadio,
    appendSmartLibraryQueue,
  ]);

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

  // Keep AudioEngine's proactive 3-track pre-buffer synchronized with active queue updates
  useEffect(() => {
    audioEngine.setUpcomingQueue(queue);
  }, [queue]);

  // Re-align YouTube viewport once page enter transition settles
  useEffect(() => {
    const timer = window.setTimeout(() => audioEngine.resyncYouTubeViewport(), 230);
    return () => window.clearTimeout(timer);
  }, [activeTab]);

  // Track real streaming playback progress so stalled/bad connections are detected cleanly
  useEffect(() => {
    const cur = engine.currentTrack;
    const now = Date.now();
    if (!cur || cur.source !== 'stream' || cur.isAppDownload) {
      lastStreamProgressRef.current = { trackId: null, time: 0, atMs: 0 };
      badConnSinceRef.current = null;
      dismissedBadSinceRef.current = null;
      setShowOfflineSwitchPrompt(false);
      return;
    }

    const prev = lastStreamProgressRef.current;
    if (prev.trackId !== cur.id) {
      lastStreamProgressRef.current = { trackId: cur.id, time: engine.currentTime, atMs: now };
      badConnSinceRef.current = null;
      dismissedBadSinceRef.current = null;
      setShowOfflineSwitchPrompt(false);
    } else if (Math.abs(engine.currentTime - prev.time) >= 0.35 && engine.isPlaying && isOnline) {
      lastStreamProgressRef.current = { trackId: cur.id, time: engine.currentTime, atMs: now };
    }
  }, [
    engine.currentTrack?.id,
    engine.currentTrack?.source,
    engine.currentTrack?.isAppDownload,
    engine.currentTime,
    engine.isPlaying,
    isOnline,
  ]);

  // Prompt user to switch to offline listening after 30s of poor/stalled connection while streaming
  useEffect(() => {
    if (engine.currentTrack?.source !== 'stream' || engine.currentTrack?.isAppDownload) return;

    const evaluate = () => {
      const result = evaluatePoorConnectionState({
        isStreamingTrack:
          engine.currentTrack?.source === 'stream' && !engine.currentTrack?.isAppDownload,
        isPlaying: engine.isPlaying,
        isOnline,
        isBuffering: engine.isBuffering || engine.streamErrorCount > 0,
        lastProgressAtMs: lastStreamProgressRef.current.atMs,
        badSinceMs: badConnSinceRef.current,
        nowMs: Date.now(),
        dismissedSinceMs: dismissedBadSinceRef.current,
        thresholdMs: POOR_CONNECTION_THRESHOLD_MS,
      });
      badConnSinceRef.current = result.nextBadSinceMs;
      setShowOfflineSwitchPrompt(result.shouldPromptOffline);
    };

    evaluate();
    const timer = window.setInterval(evaluate, 1000);
    return () => window.clearInterval(timer);
  }, [
    engine.currentTrack?.id,
    engine.currentTrack?.source,
    engine.currentTrack?.isAppDownload,
    engine.isPlaying,
    engine.isBuffering,
    engine.streamErrorCount,
    isOnline,
  ]);

  const offlineFallbackCount = useMemo(() => {
    const localCount = savedTracks.filter((t) => t.source === 'local' || Boolean(t.isAppDownload)).length;
    return localCount > 0 ? localCount : PROCEDURAL_STEMS.length;
  }, [savedTracks]);

  const handleSwitchToOfflineListening = useCallback(() => {
    triggerHaptic('success');
    dismissedBadSinceRef.current = badConnSinceRef.current ?? Date.now();
    setShowOfflineSwitchPrompt(false);

    const localSongs = savedTracks.filter((t) => t.source === 'local' || Boolean(t.isAppDownload));
    const sourcePool = localSongs.length > 0 ? localSongs : PROCEDURAL_STEMS;
    const orderedPool = smartShuffleEnabled
      ? selectSmartLibraryTracks(sourcePool, localDb.loadPlayCounts(), new Set(), sourcePool.length).map(
          (t) => ({ ...t, autoQueued: false })
        )
      : sourcePool;

    const { queue: offlineQueue, startTrack } = buildCollectionQueue(orderedPool, 0);
    if (!startTrack) return;

    playedHistoryIdsRef.current.add(startTrack.id);
    setShuffleEnabled(false);
    setPreShuffleOrderIds(null);
    setQueue(offlineQueue);
    void audioEngine.playTrack(startTrack);
  }, [savedTracks, smartShuffleEnabled]);

  const handleDismissOfflinePrompt = useCallback(() => {
    triggerHaptic('light');
    dismissedBadSinceRef.current = badConnSinceRef.current ?? Date.now();
    setShowOfflineSwitchPrompt(false);
  }, []);

  const handleNextRef = useRef(handleNext);
  const handlePrevRef = useRef(handlePrev);
  handleNextRef.current = handleNext;
  handlePrevRef.current = handlePrev;
  const lastPositionSyncRef = useRef<number>(0);

  useEffect(() => {
    const unsubEnd = audioEngine.onTrackEnd(() => {
      handleNextRef.current();
    });
    return () => {
      unsubEnd();
    };
  }, []);

  // Subscribe to Android native MediaSession (Samsung Now Bar / Lockscreen) & native PiP
  useEffect(() => {
    const unsubMedia = subscribeNativeMediaActions((detail) => {
      if (detail.action === 'play') {
        void audioEngine.play();
      } else if (detail.action === 'pause') {
        audioEngine.pause();
      } else if (detail.action === 'toggle') {
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
      navigator.mediaSession.setActionHandler('play', () => void audioEngine.play());
      navigator.mediaSession.setActionHandler('pause', () => audioEngine.pause());
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
    const first = queue[0] || allLibraryTracks[0];
    if (first) {
      playTrack(first);
    } else {
      triggerHaptic('light');
      setActiveTab('stream');
    }
  };

  const handleToggleFavorite = (trackId: string) => {
    triggerHaptic('light');
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
    if (entries.length === 0) return;

    // Prime memory blob cache & update React state immediately so songs/folders appear at once
    const importedTracks = entries.map((e) => {
      localDb.primeAudioBlob(e.track.id, e.file);
      return e.track;
    });
    setSavedTracks((prev) => mergeImportedTracks(prev, importedTracks));
    const stemIds = new Set(PROCEDURAL_STEMS.map((s) => s.id));
    setQueue((prev) => enqueueImportedOfflineTracks(prev, importedTracks, stemIds));

    await localDb.saveTracksBatch(importedTracks);
    for (const { track, file } of entries) {
      await localDb.saveTrack(track, file);
    }
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

  const showTimedFolderStatus = useCallback((message: string, durationMs = 3800) => {
    if (folderStatusTimerRef.current !== null) {
      window.clearTimeout(folderStatusTimerRef.current);
    }
    setFolderImportStatus(message);
    if (message) {
      folderStatusTimerRef.current = window.setTimeout(() => {
        setFolderImportStatus('');
        folderStatusTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  const finalizeFolderTracks = useCallback(
    async (importedTracks: Track[], failedFiles = 0) => {
      if (importedTracks.length === 0) {
        showTimedFolderStatus(
          'No audio files (.mp3, .flac, .wav, .m4a, .ogg) found in that folder.',
          4200
        );
        return;
      }
      const topFolder = importedTracks[0].folderPath || 'Picked Folder';
      setLibraryFocusRequest({
        subTab: 'folders',
        groupName: topFolder,
        nonce: Date.now(),
      });
      setActiveTab('library');
      triggerHaptic('success');
      const skippedNote =
        failedFiles > 0 ? ` (${failedFiles} unreadable ${failedFiles === 1 ? 'file' : 'files'} skipped)` : '';
      showTimedFolderStatus(
        `Imported ${importedTracks.length} ${importedTracks.length === 1 ? 'song' : 'songs'} from "${topFolder}"${skippedNote}.`
      );
      if (!engine.currentTrack || !engine.isPlaying || engine.currentTrack.source === 'synth') {
        playTrack(importedTracks[0]);
      }
    },
    [engine.currentTrack, engine.isPlaying, playTrack, showTimedFolderStatus]
  );

  const finalizeFolderImport = useCallback(
    async (imported: Array<{ track: Track; file: File }>) => {
      if (imported.length === 0) {
        showTimedFolderStatus(
          'No audio files (.mp3, .flac, .wav, .m4a, .ogg) found in that folder.',
          4200
        );
        return;
      }
      await handleImportTracks(imported);
      await finalizeFolderTracks(imported.map((e) => e.track));
    },
    [finalizeFolderTracks, showTimedFolderStatus]
  );

  const handlePickFolderInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) {
      e.target.value = '';
      return;
    }
    setFolderImportStatus(`Scanning 0 / ${files.length} files...`);
    try {
      const pairs = files.map((file) => {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
        const folderPath = resolveFolderPathFromRelativePath(rel, 'Picked Folder');
        return { file, folderPath };
      });
      const imported = await buildTracksFromFilePairs(pairs, (p) => {
        setFolderImportStatus(`Importing ${p.scanned} / ${p.found}: ${p.currentFile}`);
      });
      await finalizeFolderImport(imported);
    } catch {
      showTimedFolderStatus('Could not import files from that folder.', 4000);
    } finally {
      e.target.value = '';
    }
  };

  const handlePickFolder = useCallback(async () => {
    if (hasNativeFolderPicker()) {
      setFolderImportStatus('Opening Android folder picker...');
      try {
        const stemIds = new Set(PROCEDURAL_STEMS.map((s) => s.id));
        const result = await importFromNativeFolderPicker({
          onProgress: (p) => {
            setFolderImportStatus(`Importing ${p.scanned} / ${p.found}: ${p.currentFile}`);
          },
          onTrackReady: async ({ track, file }) => {
            // Persist each track + blob right away so File bytes can be garbage-collected on Android WebView
            await localDb.saveTrack(track, file);
            setSavedTracks((prev) => mergeImportedTracks(prev, [track]));
            setQueue((prev) => enqueueImportedOfflineTracks(prev, [track], stemIds));
          },
        });
        if (result.cancelled) {
          setFolderImportStatus('');
          return;
        }
        if (result.error) {
          showTimedFolderStatus(result.error, 4200);
          return;
        }
        await finalizeFolderTracks(result.tracks, result.failedFiles);
      } catch (err) {
        const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
        showTimedFolderStatus(`Could not read the selected Android folder.${detail}`, 4200);
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
        await finalizeFolderImport(imported);
        return;
      } catch (err) {
        setFolderImportStatus('');
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }

    folderPickerRef.current?.click();
  }, [finalizeFolderImport, showTimedFolderStatus]);

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

  const handleDeletePlaylists = useCallback(async (playlistIds: string[]) => {
    if (playlistIds.length === 0) return;
    const idSet = new Set(playlistIds);
    setPlaylists((prev) => prev.filter((p) => !idSet.has(p.id)));
    for (const pid of playlistIds) {
      await localDb.deletePlaylist(pid);
    }
  }, []);

  const handleAddTrackToPlaylist = async (playlistId: string, trackId: string) => {
    const target = playlistsRef.current.find((pl) => pl.id === playlistId);
    if (!target || target.trackIds.includes(trackId)) return;
    const updated: Playlist = { ...target, trackIds: [...target.trackIds, trackId] };
    setPlaylists((prev) => prev.map((pl) => (pl.id === playlistId ? updated : pl)));
    await localDb.savePlaylist(updated);
  };

  const handleAddMultipleTracksToPlaylist = useCallback(
    async (playlistId: string, trackIds: string[]) => {
      if (trackIds.length === 0) return;
      const target = playlistsRef.current.find((pl) => pl.id === playlistId);
      if (!target) return;
      const existing = new Set(target.trackIds);
      const additions = trackIds.filter((id) => !existing.has(id));
      if (additions.length === 0) return;
      const updated: Playlist = {
        ...target,
        trackIds: [...target.trackIds, ...additions],
      };
      setPlaylists((prev) => prev.map((pl) => (pl.id === playlistId ? updated : pl)));
      await localDb.savePlaylist(updated);
      triggerHaptic('success');
    },
    []
  );

  const handleCreatePlaylistWithTracks = useCallback(
    async (name: string, description: string, tracksToAdd: Track[]) => {
      const cleanName = name.trim();
      if (!cleanName) return;
      if (tracksToAdd.length > 0) {
        setSavedTracks((prev) => mergeImportedTracks(prev, tracksToAdd));
        await localDb.saveTracksBatch(tracksToAdd);
      }
      const pl: Playlist = {
        id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: cleanName,
        description: description.trim(),
        trackIds: Array.from(new Set(tracksToAdd.map((t) => t.id))),
        createdAt: Date.now(),
      };
      setPlaylists((prev) => [pl, ...prev]);
      await localDb.savePlaylist(pl);
      triggerHaptic('success');
    },
    []
  );

  const handleAddMultipleToQueue = useCallback((tracksToAdd: Track[]) => {
    if (tracksToAdd.length === 0) return;
    triggerHaptic('selection');
    setQueue((prev) => {
      const existing = new Set(prev.map((q) => q.id));
      const additions = tracksToAdd.filter((t) => !existing.has(t.id));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, []);

  const handlePlayNext = useCallback(
    (tracksOrTrack: Track | Track[]) => {
      const incoming = Array.isArray(tracksOrTrack) ? tracksOrTrack : [tracksOrTrack];
      if (incoming.length === 0) return;
      triggerHaptic('selection');
      const currentId = engine.currentTrack?.id ?? null;
      setQueue((prev) => insertPlayNextTracks(prev, incoming, currentId));
      const msg =
        incoming.length === 1
          ? `"${incoming[0].title}" will play next.`
          : `${incoming.length} tracks will play next.`;
      if (downloadToastTimerRef.current !== null) {
        window.clearTimeout(downloadToastTimerRef.current);
      }
      setDownloadToast({ text: msg, isError: false });
      downloadToastTimerRef.current = window.setTimeout(() => {
        setDownloadToast(null);
        downloadToastTimerRef.current = null;
      }, 3200);
    },
    [engine.currentTrack?.id]
  );

  const handleDeleteTracks = useCallback(async (trackIds: string[]) => {
    if (trackIds.length === 0) return;
    const idSet = new Set(trackIds);

    const activeId = audioEngine.getSnapshot().currentTrack?.id;
    if (activeId && idSet.has(activeId)) {
      audioEngine.pause();
    }

    setSavedTracks((prev) => prev.filter((t) => !idSet.has(t.id)));
    setQueue((prev) => prev.filter((t) => !idSet.has(t.id)));
    setFavoriteIds((prev) => {
      const next = prev.filter((id) => !idSet.has(id));
      if (next.length !== prev.length) {
        localDb.saveFavorites(next);
      }
      return next;
    });

    const modifiedPlaylists = playlistsRef.current
      .map((pl) => {
        const nextIds = pl.trackIds.filter((id) => !idSet.has(id));
        if (nextIds.length === pl.trackIds.length) return null;
        return { ...pl, trackIds: nextIds };
      })
      .filter((pl): pl is Playlist => pl !== null);

    if (modifiedPlaylists.length > 0) {
      const updatedById = new Map(modifiedPlaylists.map((pl) => [pl.id, pl]));
      setPlaylists((prev) => prev.map((pl) => updatedById.get(pl.id) || pl));
    }

    await localDb.deleteTracksBatch(trackIds);
    for (const pl of modifiedPlaylists) {
      await localDb.savePlaylist(pl);
    }
  }, []);

  const handleDeleteTrack = useCallback(
    async (trackId: string) => {
      await handleDeleteTracks([trackId]);
    },
    [handleDeleteTracks]
  );

  const downloadedTrackIdSet = useMemo(
    () => new Set(savedTracks.filter((t) => Boolean(t.isAppDownload)).map((t) => t.id)),
    [savedTracks]
  );

  const showDownloadToast = useCallback((text: string, isError = false) => {
    if (downloadToastTimerRef.current !== null) {
      window.clearTimeout(downloadToastTimerRef.current);
    }
    setDownloadToast({ text, isError });
    downloadToastTimerRef.current = window.setTimeout(() => {
      setDownloadToast(null);
      downloadToastTimerRef.current = null;
    }, 4200);
  }, []);

  const handleDownloadToApp = useCallback(
    async (tracksToDownload: Track[]) => {
      if (tracksToDownload.length === 0) return;
      triggerHaptic('selection');
      let savedCount = 0;
      let failedCount = 0;
      let lastTitle = tracksToDownload[0].title;

      for (let i = 0; i < tracksToDownload.length; i++) {
        const track = tracksToDownload[i];
        setActiveDownload({
          label: track.title,
          current: i + 1,
          total: tracksToDownload.length,
          percent: 5,
          mode: 'app',
        });
        try {
          const { track: downloadedTrack, blob } = await downloadTrackToAppStorage(track, (p) => {
            setActiveDownload({
              label: track.title,
              current: i + 1,
              total: tracksToDownload.length,
              percent: p.percent,
              mode: 'app',
            });
          });
          await localDb.saveTrack(downloadedTrack, blob);
          setSavedTracks((prev) => {
            const exists = prev.some((t) => t.id === downloadedTrack.id);
            if (exists) {
              return prev.map((t) => (t.id === downloadedTrack.id ? downloadedTrack : t));
            }
            return [downloadedTrack, ...prev];
          });
          setQueue((prev) =>
            prev.map((q) => (q.id === downloadedTrack.id ? { ...q, ...downloadedTrack } : q))
          );
          savedCount++;
          lastTitle = downloadedTrack.title;
        } catch {
          failedCount++;
        }
      }

      setActiveDownload(null);
      if (savedCount > 0) {
        triggerHaptic('success');
        const msg =
          tracksToDownload.length === 1
            ? `Saved "${lastTitle}" for offline playback in kaGO.PIaY.`
            : `Saved ${savedCount} of ${tracksToDownload.length} tracks to App Downloads.`;
        showDownloadToast(msg);
      } else if (failedCount > 0) {
        showDownloadToast('Could not save offline download right now. Please try again.', true);
      }
    },
    [showDownloadToast]
  );

  const handleRemoveAppDownloads = useCallback(
    async (trackIds: string[]) => {
      if (trackIds.length === 0) return;
      triggerHaptic('medium');
      const idSet = new Set(trackIds);
      const playlistTrackIdSet = new Set(playlistsRef.current.flatMap((p) => p.trackIds));

      const keepUpdatedIds: string[] = [];
      const fullDeleteIds: string[] = [];
      for (const id of idSet) {
        if (playlistTrackIdSet.has(id)) keepUpdatedIds.push(id);
        else fullDeleteIds.push(id);
      }

      if (keepUpdatedIds.length > 0) {
        const keepSet = new Set(keepUpdatedIds);
        const strippedTracks: Track[] = [];
        setSavedTracks((prev) =>
          prev.map((t) => {
            if (!keepSet.has(t.id)) return t;
            const stripped: Track = {
              ...t,
              isAppDownload: false,
              downloadedAt: undefined,
              downloadSizeBytes: undefined,
              downloadFormat: undefined,
            };
            strippedTracks.push(stripped);
            return stripped;
          })
        );
        if (strippedTracks.length > 0) {
          await localDb.saveTracksBatch(strippedTracks);
        }
        for (const id of keepUpdatedIds) {
          await localDb.deleteAudioBlob(id);
        }
      }

      if (fullDeleteIds.length > 0) {
        await handleDeleteTracks(fullDeleteIds);
      }

      showDownloadToast(
        trackIds.length === 1
          ? 'Removed from offline App Downloads.'
          : `Removed ${trackIds.length} songs from offline App Downloads.`
      );
    },
    [handleDeleteTracks, showDownloadToast]
  );

  const handleDownloadToDevice = useCallback(
    async (tracksToExport: Track[], formatId: DownloadFormatId) => {
      if (tracksToExport.length === 0) return;
      triggerHaptic('selection');
      let doneCount = 0;
      let lastLabel = '';

      for (let i = 0; i < tracksToExport.length; i++) {
        const track = tracksToExport[i];
        setActiveDownload({
          label: track.title,
          current: i + 1,
          total: tracksToExport.length,
          percent: 6,
          mode: 'device',
        });
        try {
          const result = await downloadTrackToLocalDevice(track, formatId, (p) => {
            setActiveDownload({
              label: track.title,
              current: i + 1,
              total: tracksToExport.length,
              percent: p.percent,
              mode: 'device',
            });
          });
          doneCount++;
          lastLabel = `${result.filename} (${result.actualFormatLabel})`;
        } catch (err) {
          if (tracksToExport.length === 1) {
            setActiveDownload(null);
            showDownloadToast(
              err instanceof Error ? err.message : 'Download failed. Please try again.',
              true
            );
            return;
          }
        }
      }

      setActiveDownload(null);
      if (doneCount > 0) {
        triggerHaptic('success');
        showDownloadToast(
          tracksToExport.length === 1
            ? `Saved ${lastLabel} to device Downloads.`
            : `Downloaded ${doneCount} of ${tracksToExport.length} files to device Downloads.`
        );
      } else {
        showDownloadToast('Could not download files to device right now.', true);
      }
    },
    [showDownloadToast]
  );

  const handleImportYouTubePlaylist = useCallback(
    async (
      urlOrId: string,
      customName?: string
    ): Promise<{ ok: boolean; trackCount?: number; error?: string }> => {
      const res = await fetchYouTubePlaylistByUrlOrId(urlOrId, customName);
      if (!res.ok || res.tracks.length === 0) {
        return {
          ok: false,
          error: res.error || 'Could not import that YouTube playlist.',
        };
      }

      setSavedTracks((prev) => mergeImportedTracks(prev, res.tracks));
      await localDb.saveTracksBatch(res.tracks);

      const pl: Playlist = {
        id: `yt-pl-${res.listId || Date.now().toString(36)}-${Date.now().toString(36)}`,
        name: res.title || customName?.trim() || 'YouTube Playlist',
        description: `Imported from YouTube (${res.tracks.length} songs)`,
        trackIds: res.tracks.map((t) => t.id),
        createdAt: Date.now(),
      };
      setPlaylists((prev) => [pl, ...prev]);
      await localDb.savePlaylist(pl);
      triggerHaptic('success');
      return { ok: true, trackCount: res.tracks.length };
    },
    []
  );

  const handleSaveLyrics = useCallback(async (entry: StoredLyrics) => {
    setLyricsMap((prev) => ({ ...prev, [entry.trackId]: entry }));
    await localDb.saveLyrics(entry);
  }, []);

  const handleFetchTrackLyrics = useCallback(
    async (track: Track, customQuery?: string) => {
      if (!track || fetchingLyricsIdsRef.current.has(track.id)) return;
      fetchingLyricsIdsRef.current.add(track.id);
      setIsFetchingLyrics(true);
      try {
        const fetched = await fetchSyncedLyricsForTrack(track, customQuery);
        if (fetched?.rawLrc) {
          await handleSaveLyrics({
            trackId: track.id,
            rawLrc: fetched.rawLrc,
            offsetSeconds: lyricsMap[track.id]?.offsetSeconds ?? 0,
            updatedAt: Date.now(),
          });
        }
      } finally {
        fetchingLyricsIdsRef.current.delete(track.id);
        setIsFetchingLyrics(false);
      }
    },
    [handleSaveLyrics, lyricsMap]
  );

  // Automatically fetch & cache synced LRC lyrics whenever a new song without local lyrics starts playing
  useEffect(() => {
    if (!lyricsHydrated) return;
    const track = engine.currentTrack;
    if (!track || track.source === 'synth') return;
    const hasSaved = Boolean(lyricsMap[track.id]?.rawLrc?.trim() || track.lrcLyrics?.trim());
    if (hasSaved || attemptedLyricsIdsRef.current.has(track.id)) return;
    attemptedLyricsIdsRef.current.add(track.id);
    void handleFetchTrackLyrics(track);
  }, [lyricsHydrated, engine.currentTrack?.id, lyricsMap, handleFetchTrackLyrics]);

  const handleUpdateLyricsOffset = async (trackId: string, offsetSeconds: number) => {
    const existing = lyricsMap[trackId];
    const track =
      allLibraryTracks.find((t) => t.id === trackId) ||
      (engine.currentTrack?.id === trackId ? engine.currentTrack : undefined);
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
        // @ts-expect-error webkitdirectory & directory enable folder picking across browsers
        webkitdirectory=""
        directory=""
        onChange={handlePickFolderInput}
        className="hidden"
      />

      <main className="mx-auto max-w-[1440px] px-3.5 py-4 sm:px-6 sm:py-6 lg:px-8 pb-[calc(9.5rem+env(safe-area-inset-bottom))] md:pb-28">
        {folderImportStatus && (
          <div className="mb-4 kago-panel-enter rounded-xl border border-[#E11D48]/50 bg-[#15090E] px-4 py-2.5 font-mono-tabular text-xs text-[#FDA4AF]">
            {folderImportStatus}
          </div>
        )}
        <div key={activeTab} className="kago-page-enter">
        {activeTab === 'dashboard' && (
          <DashboardView
            engine={engine}
            dsp={dsp}
            storedTrackCount={allLibraryTracks.length}
            recentTracks={allLibraryTracks}
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
            downloadedTrackIds={downloadedTrackIdSet}
            onPlayTrack={playTrack}
            onPlayCollection={playCollection}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onPlayNext={(t) => handlePlayNext(t)}
            onPlayMultipleNext={(trs) => handlePlayNext(trs)}
            onAddToQueue={(t) => {
              triggerHaptic('selection');
              setQueue((prev) => (prev.some((q) => q.id === t.id) ? prev : [...prev, t]));
            }}
            onAddMultipleToQueue={handleAddMultipleToQueue}
            onSaveTrackToLibrary={(t) => void handleSaveTrackToLibrary(t)}
            onSaveCollectionAsPlaylist={(name, desc, trs) =>
              void handleCreatePlaylistWithTracks(name, desc, trs)
            }
            onRequestDownloadTrack={(tr) =>
              setDownloadModalState({
                target: { kind: 'track', track: tr },
                initialStep: 'choice',
              })
            }
            onRequestDownloadCollection={(col) =>
              setDownloadModalState({
                target: { kind: 'collection', ...col },
                initialStep: 'choice',
              })
            }
          />
        )}

        {activeTab === 'library' && (
          <LibraryView
            tracks={allLibraryTracks}
            playlists={playlists}
            favoriteIds={favoriteIds}
            engine={engine}
            libraryFocusRequest={libraryFocusRequest}
            onPlayTrack={playTrack}
            onPlayCollection={playCollection}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onPlayNext={(t) => handlePlayNext(t)}
            onPlayMultipleNext={(trs) => handlePlayNext(trs)}
            onAddToQueue={(t) => {
              triggerHaptic('selection');
              setQueue((prev) => (prev.some((q) => q.id === t.id) ? prev : [...prev, t]));
            }}
            onAddMultipleToQueue={handleAddMultipleToQueue}
            onToggleFavorite={handleToggleFavorite}
            onPickSong={() => songPickerRef.current?.click()}
            onPickFolder={() => void handlePickFolder()}
            onOpenLiveStudio={() => setIsLiveStudioOpen(true)}
            onCreatePlaylist={(name, desc) => void handleCreatePlaylist(name, desc)}
            onCreatePlaylistWithTracks={(name, desc, trs) =>
              void handleCreatePlaylistWithTracks(name, desc, trs)
            }
            onImportYouTubePlaylist={handleImportYouTubePlaylist}
            onDeletePlaylist={(id) => void handleDeletePlaylist(id)}
            onDeletePlaylists={(ids) => void handleDeletePlaylists(ids)}
            onAddTrackToPlaylist={(plId, trId) => void handleAddTrackToPlaylist(plId, trId)}
            onAddMultipleTracksToPlaylist={(plId, trIds) =>
              void handleAddMultipleTracksToPlaylist(plId, trIds)
            }
            onDeleteTrack={(id) => void handleDeleteTrack(id)}
            onDeleteTracks={(ids) => void handleDeleteTracks(ids)}
            onRequestDownloadTrack={(tr) =>
              setDownloadModalState({
                target: { kind: 'track', track: tr },
                initialStep: 'choice',
              })
            }
            onRequestDownloadTrackFormats={(tr) =>
              setDownloadModalState({
                target: { kind: 'track', track: tr },
                initialStep: 'formats',
              })
            }
            onRequestDownloadCollection={(col) =>
              setDownloadModalState({
                target: { kind: 'collection', ...col },
                initialStep: 'choice',
              })
            }
            onRemoveAppDownloads={(ids) => void handleRemoveAppDownloads(ids)}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsView
            dsp={dsp}
            storedTrackCount={allLibraryTracks.length}
            isOnline={isOnline}
            autoplayRadioEnabled={autoplayRadioEnabled}
            themePrefs={themePrefs}
            visualizerPalette={visualizerPalette}
            onChangeVisualizerPalette={handleChangeVisualizerPalette}
            onChangeThemeMode={(mode: ThemeMode) =>
              setThemePrefs((prev) => ({ ...prev, mode }))
            }
            onChangeAccentColor={(accentHex, accentAlpha) =>
              setThemePrefs((prev) => ({ ...prev, accentHex, accentAlpha }))
            }
            onResetAccentColor={() =>
              setThemePrefs((prev) => ({
                ...prev,
                accentHex: DEFAULT_ACCENT_HEX,
                accentAlpha: 100,
              }))
            }
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
            downloadedTrackIds={downloadedTrackIdSet}
            engine={engine}
            onPlayTrack={playTrack}
            onTogglePlay={() => void audioEngine.togglePlay()}
            onPlayNext={(t) => handlePlayNext(t)}
            onAddToQueue={(t) => {
              triggerHaptic('selection');
              setQueue((prev) => (prev.some((q) => q.id === t.id) ? prev : [...prev, t]));
            }}
            onSaveTrackToLibrary={(t) => void handleSaveTrackToLibrary(t)}
            onPickSong={() => songPickerRef.current?.click()}
            onPickFolder={() => void handlePickFolder()}
            onRequestDownloadTrack={(tr) =>
              setDownloadModalState({
                target: { kind: 'track', track: tr },
                initialStep: 'choice',
              })
            }
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
            tracks={syncLyricsTracks}
            engine={engine}
            lyricsMap={lyricsMap}
            isFetchingLyrics={isFetchingLyrics}
            onFetchTrackLyrics={(tr, customQ) => void handleFetchTrackLyrics(tr, customQ)}
            onSaveLyrics={handleSaveLyrics}
            onSeek={(sec) => audioEngine.seek(sec)}
            onPlayTrack={playTrack}
            onBack={() => setActiveTab('settings')}
          />
        )}
        </div>
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
        visualizerPalette={visualizerPalette}
        onChangeVisualizerPalette={handleChangeVisualizerPalette}
        isFavorite={engine.currentTrack ? favoriteIds.includes(engine.currentTrack.id) : false}
        isDownloaded={
          engine.currentTrack
            ? downloadedTrackIdSet.has(engine.currentTrack.id) || Boolean(engine.currentTrack.isAppDownload)
            : false
        }
        onRequestDownloadTrack={(tr) =>
          setDownloadModalState({
            target: { kind: 'track', track: tr },
            initialStep: 'choice',
          })
        }
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
        onReorderQueue={handleReorderQueue}
        onReorderMultipleQueue={handleReorderMultipleQueue}
        shuffleEnabled={shuffleEnabled}
        onToggleShuffle={handleToggleShuffle}
        smartShuffleEnabled={smartShuffleEnabled}
        onToggleSmartShuffle={handleToggleSmartShuffle}
        onToggleFavorite={handleToggleFavorite}
        onOpenDsp={() => setIsDspOpen(true)}
        onUpdateLyricsOffset={(id, offset) => void handleUpdateLyricsOffset(id, offset)}
        onOpenStream={() => setActiveTab('stream')}
        onOpenLyricsStudio={() => setActiveTab('lyrics')}
        autoplayRadioEnabled={autoplayRadioEnabled}
        isFetchingRadio={isFetchingRadio}
        isFetchingLyrics={isFetchingLyrics}
        onFetchTrackLyrics={(tr, customQ) => void handleFetchTrackLyrics(tr, customQ)}
        onToggleAutoplayRadio={handleToggleAutoplayRadio}
      />

      {/* Active Download Progress / Completion Toast */}
      {(activeDownload || downloadToast) && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-[calc(8.75rem+env(safe-area-inset-bottom))] md:bottom-24 left-3 right-3 sm:left-auto sm:right-6 sm:w-[22rem] z-[95] rounded-xl border border-white/15 bg-[#0D0E12]/95 px-4 py-3 shadow-2xl backdrop-blur-md"
        >
          {activeDownload ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#E11D48]" />
                  <span className="truncate font-semibold text-[#F4F3F0]">
                    {activeDownload.mode === 'app' ? 'Saving offline' : 'Downloading'}{' '}
                    {activeDownload.total > 1
                      ? `(${activeDownload.current}/${activeDownload.total})`
                      : ''}
                    : {activeDownload.label}
                  </span>
                </div>
                <span className="font-mono-tabular shrink-0 text-[#FF4D6D]">
                  {activeDownload.percent}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-[#E11D48] transition-all duration-200"
                  style={{ width: `${Math.max(4, activeDownload.percent)}%` }}
                />
              </div>
            </div>
          ) : downloadToast ? (
            <div className="flex items-center justify-between gap-2.5 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                {downloadToast.isError ? (
                  <Download className="h-4 w-4 shrink-0 text-red-400" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                )}
                <span
                  className={`truncate font-medium ${
                    downloadToast.isError ? 'text-red-300' : 'text-[#F4F3F0]'
                  }`}
                >
                  {downloadToast.text}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDownloadToast(null)}
                aria-label="Dismiss download message"
                className="text-zinc-400 hover:text-white shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      )}

      <DownloadSheetModal
        target={downloadModalState?.target ?? null}
        initialStep={downloadModalState?.initialStep ?? 'choice'}
        savedTracks={savedTracks}
        isBusy={Boolean(activeDownload)}
        onClose={() => setDownloadModalState(null)}
        onSaveToApp={(trs) => void handleDownloadToApp(trs)}
        onRemoveFromApp={(ids) => void handleRemoveAppDownloads(ids)}
        onDownloadLocally={(trs, fmt) => void handleDownloadToDevice(trs, fmt)}
      />

      {showOfflineSwitchPrompt && (
        <div
          role="alertdialog"
          aria-live="assertive"
          aria-labelledby="poor-conn-title"
          data-testid="poor-connection-offline-prompt"
          className="kago-sheet-slide fixed bottom-[calc(8.75rem+env(safe-area-inset-bottom))] md:bottom-24 left-3 right-3 sm:left-auto sm:right-6 sm:w-[24rem] z-[85] rounded-xl border border-[#E11D48]/60 bg-[#0D0F15]/95 p-4 shadow-[0_20px_50px_rgba(0,0,0,0.9)] backdrop-blur-md"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#E11D48]/40 bg-[#E11D48]/15 text-[#FF4D6D]">
              <WifiOff className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h3 id="poor-conn-title" className="font-display text-sm font-bold text-[#F4F3F0]">
                  Poor Internet Connection
                </h3>
                <button
                  type="button"
                  onClick={handleDismissOfflinePrompt}
                  aria-label="Dismiss poor connection notification"
                  className="text-[#8E929B] hover:text-white cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[#9CA3AF]">
                Streaming has been interrupted for 30s. Switch to your offline library (
                <span className="font-mono-tabular text-[#F4F3F0]">
                  {offlineFallbackCount}{' '}
                  {savedTracks.some((t) => t.source === 'local') ? 'offline songs' : 'offline stems'}
                </span>
                ) instead?
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSwitchToOfflineListening}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-1.5 text-xs font-semibold text-white shadow-[0_0_16px_rgba(225,29,72,0.45)] hover:bg-[#BE123C] cursor-pointer"
                >
                  <Radio className="h-3.5 w-3.5" />
                  <span>Switch to Offline</span>
                </button>
                <button
                  type="button"
                  onClick={handleDismissOfflinePrompt}
                  className="rounded-lg border border-[#262936] bg-[#14161D] px-3 py-1.5 text-xs font-semibold text-[#C7C9D1] hover:border-[#3A3F50] hover:text-white cursor-pointer"
                >
                  Keep Trying
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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

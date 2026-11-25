import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ExternalLink,
  ListMusic,
  ListPlus,
  ListStart,
  Loader2,
  Mic,
  Music2,
  Play,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { EQ_PRESETS } from '../data/presetsAndStems';
import type {
  ActiveTab,
  AudioEngineSnapshot,
  DspSettings,
  LibrarySubTab,
  Playlist,
  Track,
} from '../types/audio';
import {
  blobToBase64,
  buildAiTrackSearchQuery,
  formatRecordingTimer,
  pickSupportedRecorderMimeType,
  type AiAssistantAction,
  type AiAssistantContextPayload,
  type AiAssistantResponse,
  type AiAssistantSource,
  type AiIdentifiedCandidate,
} from '../utils/aiAssistant';
import { triggerHaptic } from '../utils/haptics';
import { formatDuration } from '../utils/lrcParser';
import { isNativeAndroidApp } from '../utils/nativeMediaBridge';
import {
  formatTrackSummaryLine,
  matchPendingConfirmation,
  runSiriAssistantTurn,
  type PendingSiriAction,
} from '../utils/siriEngine';
import type { DownloadFormatId } from '../utils/streamDownloads';
import { searchStreamsUnified } from '../utils/streamSearch';

interface ResolvedCandidateCard {
  label: string;
  sublabel: string;
  reason?: string;
  track: Track | null;
  resolving: boolean;
}

interface CreatedPlaylistCard {
  name: string;
  description: string;
  tracks: Track[];
  resolving: boolean;
}

interface AssistantMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  hasAudioClip?: boolean;
  audioDurationSec?: number;
  sources?: AiAssistantSource[];
  candidates?: ResolvedCandidateCard[];
  awaitingConfirm?: boolean;
  createdPlaylists?: CreatedPlaylistCard[];
  appliedBadges?: string[];
  error?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export interface AiAssistantWidgetProps {
  engine: AudioEngineSnapshot;
  activeTab: ActiveTab;
  isFullscreenOpen: boolean;
  dsp: DspSettings;
  playlists: Playlist[];
  savedTracks: Track[];
  onPlayTrack: (track: Track) => void;
  onPlayCollection: (tracks: Track[], startIndex?: number) => void;
  onPlayNext: (track: Track) => void;
  onQueueTracks: (tracks: Track[]) => void;
  onCreatePlaylist: (name: string, description: string, tracks: Track[]) => Promise<void> | void;
  onTogglePlay: () => void;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeekBy: (seconds: number) => void;
  onToggleShuffle: () => void;
  onToggleAutoplayRadio: () => void;
  onOpenFullscreen: (open: boolean) => void;
  onOpenDsp: () => void;
  onOpenLiveStudio: () => void;
  onPickSong: () => void;
  onPickFolder: () => void;
  onNavigateTab: (tab: ActiveTab, librarySubTab?: LibrarySubTab, searchQuery?: string) => void;
  onUpdateDsp: (next: DspSettings) => void;
  onToggleFavorite: (trackId: string) => void;
  onDownloadToApp: (tracks: Track[]) => Promise<void> | void;
  onDownloadToDevice: (tracks: Track[], formatId: DownloadFormatId) => Promise<void> | void;
}

const MAX_RECORDING_SECONDS = 18;
const FAB_SIZE_PX = 40;
const FAB_MARGIN_PX = 14;
const FAB_STORAGE_KEY = 'kago_ai_fab_position_v1';

interface SavedFabPosition {
  side: 'left' | 'right';
  topRatio: number;
}

function loadSavedFabPosition(): SavedFabPosition | null {
  try {
    const raw = localStorage.getItem(FAB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedFabPosition>;
    if (
      (parsed.side === 'left' || parsed.side === 'right') &&
      typeof parsed.topRatio === 'number' &&
      Number.isFinite(parsed.topRatio)
    ) {
      return {
        side: parsed.side,
        topRatio: Math.max(0.12, Math.min(0.86, parsed.topRatio)),
      };
    }
  } catch {
    // Ignore invalid storage
  }
  return null;
}

function getSpeechRecognitionCtor(): (new () => BrowserSpeechRecognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function isMeaningfulSpokenCommand(transcript: string): boolean {
  const clean = transcript.trim().toLowerCase();
  if (clean.length < 2) return false;
  // Ignore pure humming/vocalise syllables so hum-recognition stays intact on web
  if (/^(?:hmm+|mmm+|hmmm+|la(?:\s+la)+|na(?:\s+na)+|da(?:\s+da)+|oh+|ah+|ooh+)$/i.test(clean)) {
    return false;
  }
  return /[a-z0-9]{2,}/i.test(clean);
}

export const AiAssistantWidget: React.FC<AiAssistantWidgetProps> = ({
  engine,
  activeTab,
  isFullscreenOpen,
  dsp,
  playlists,
  savedTracks,
  onPlayTrack,
  onPlayCollection,
  onPlayNext,
  onQueueTracks,
  onCreatePlaylist,
  onTogglePlay,
  onPlay,
  onPause,
  onNext,
  onPrev,
  onSeekBy,
  onToggleShuffle,
  onToggleAutoplayRadio,
  onOpenFullscreen,
  onOpenDsp,
  onOpenLiveStudio,
  onPickSong,
  onPickFolder,
  onNavigateTab,
  onUpdateDsp,
  onToggleFavorite,
  onDownloadToApp,
  onDownloadToDevice,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isDrawerMinimized, setIsDrawerMinimized] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingSiriAction | null>(null);

  // Draggable small round floating button position
  const [savedFabPos, setSavedFabPos] = useState<SavedFabPosition | null>(() =>
    loadSavedFabPosition()
  );
  const [dragCoords, setDragCoords] = useState<{ left: number; top: number } | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 390,
    h: typeof window !== 'undefined' ? window.innerHeight : 844,
  }));

  // Microphone recording + real audio visualizer bars + speech recognition
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [micBars, setMicBars] = useState<number[]>([0.18, 0.24, 0.3, 0.24, 0.18, 0.26, 0.2]);
  const [micError, setMicError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const speechRecRef = useRef<BrowserSpeechRecognition | null>(null);
  const speechTranscriptRef = useRef<string>('');
  const chunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartedAtRef = useRef<number>(0);
  const analyserCtxRef = useRef<AudioContext | null>(null);
  const analyserRafRef = useRef<number | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    lastLeft: number;
    lastTop: number;
    moved: boolean;
  } | null>(null);
  const skipNextClickRef = useRef(false);

  useEffect(() => {
    const onResize = () => {
      setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const cleanupRecordingResources = useCallback(() => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (analyserRafRef.current !== null) {
      window.cancelAnimationFrame(analyserRafRef.current);
      analyserRafRef.current = null;
    }
    if (analyserCtxRef.current) {
      void analyserCtxRef.current.close().catch(() => {});
      analyserCtxRef.current = null;
    }
    if (speechRecRef.current) {
      try {
        speechRecRef.current.abort();
      } catch {
        // Ignore teardown
      }
      speechRecRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((tr) => tr.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setRecordingSec(0);
    setLiveTranscript('');
    setMicBars([0.18, 0.24, 0.3, 0.24, 0.18, 0.26, 0.2]);
  }, []);

  useEffect(() => {
    return () => {
      discardRecordingRef.current = true;
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // Ignore teardown errors
      }
      cleanupRecordingResources();
    };
  }, [cleanupRecordingResources]);

  useEffect(() => {
    if (isOpen && !isDrawerMinimized) {
      scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isSending, isRecording, isOpen, isDrawerMinimized]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const buildContextPayload = useCallback((): AiAssistantContextPayload => {
    const cur = engine.currentTrack;
    return {
      currentTrack: cur
        ? {
            id: cur.id,
            title: cur.title,
            artist: cur.artist,
            album: cur.album,
            source: cur.source,
            duration: engine.duration || cur.duration,
            currentTime: engine.currentTime,
            genre: cur.genre,
          }
        : null,
      isPlaying: engine.isPlaying,
      isFullscreenOpen,
      activeTab,
      dsp: {
        preset: dsp.preset,
        bassBoostEnabled: dsp.bassBoostEnabled,
        bassBoostDb: dsp.bassBoostDb,
        crossfadeSeconds: dsp.crossfadeSeconds,
      },
      playlistNames: playlists.map((p) => p.name),
      libraryTracksCount: savedTracks.length,
    };
  }, [
    engine.currentTrack,
    engine.duration,
    engine.currentTime,
    engine.isPlaying,
    isFullscreenOpen,
    activeTab,
    dsp,
    playlists,
    savedTracks.length,
  ]);

  const resolveStreamTracks = useCallback(async (query: string, limit = 1): Promise<Track[]> => {
    const clean = query.trim();
    if (!clean) return [];
    try {
      const primary = await searchStreamsUnified({ query: clean, category: 'all' });
      if (primary.tracks.length > 0) return primary.tracks.slice(0, limit);
      const songsFallback = await searchStreamsUnified({ query: clean, category: 'songs' });
      return songsFallback.tracks.slice(0, limit);
    } catch {
      return [];
    }
  }, []);

  const resolveStreamTrack = useCallback(
    async (query: string): Promise<Track | null> => {
      const list = await resolveStreamTracks(query, 1);
      return list[0] ?? null;
    },
    [resolveStreamTracks]
  );

  const handleConfirmTrackDecision = useCallback(
    (messageId: string, track: Track, mode: 'play_now' | 'play_next' | 'add_to_queue') => {
      triggerHaptic('success');
      let badge = '';
      if (mode === 'play_now') {
        onPlayTrack(track);
        badge = `Playing "${track.title}"`;
      } else if (mode === 'play_next') {
        onPlayNext(track);
        badge = `Playing "${track.title}" next`;
      } else {
        onQueueTracks([track]);
        badge = `Queued "${track.title}"`;
      }
      setPendingAction(null);
      setMessages((prev) =>
        prev.map((m) =>
          m.id !== messageId
            ? m
            : {
                ...m,
                awaitingConfirm: false,
                appliedBadges: [...(m.appliedBadges || []), badge],
              }
        )
      );
    },
    [onPlayNext, onPlayTrack, onQueueTracks]
  );

  const handleCancelConfirmation = useCallback((messageId: string) => {
    triggerHaptic('light');
    setPendingAction(null);
    setMessages((prev) =>
      prev.map((m) =>
        m.id !== messageId
          ? m
          : {
              ...m,
              awaitingConfirm: false,
              appliedBadges: [...(m.appliedBadges || []), 'Cancelled'],
            }
      )
    );
  }, []);

  const executeAssistantActions = useCallback(
    async (messageId: string, actions: AiAssistantAction[]) => {
      if (actions.length === 0) return;

      const appliedBadges: string[] = [];
      const candidateSeeds: Array<{
        query: string;
        label: string;
        sublabel: string;
        reason?: string;
        autoMode?: 'ask_confirm' | 'play_now' | 'play_next' | 'add_to_queue';
      }> = [];
      const playlistActions: Array<Extract<AiAssistantAction, { type: 'create_playlist' }>> = [];

      for (const action of actions) {
        if (action.type === 'control_playback') {
          switch (action.command) {
            case 'play':
              onPlay();
              appliedBadges.push('Resumed playback');
              break;
            case 'pause':
              onPause();
              appliedBadges.push('Paused playback');
              break;
            case 'toggle':
              onTogglePlay();
              appliedBadges.push('Toggled playback');
              break;
            case 'next':
              onNext();
              appliedBadges.push('Skipped to next track');
              break;
            case 'previous':
              onPrev();
              appliedBadges.push('Previous track');
              break;
            case 'seek_relative': {
              const sec = action.valueSeconds ?? 10;
              onSeekBy(sec);
              appliedBadges.push(`${sec >= 0 ? 'Forwarded' : 'Rewound'} ${Math.abs(sec)}s`);
              break;
            }
            case 'toggle_shuffle':
              onToggleShuffle();
              appliedBadges.push('Toggled Shuffle');
              break;
            case 'toggle_autoplay_radio':
              onToggleAutoplayRadio();
              appliedBadges.push('Toggled Autoplay Radio');
              break;
            case 'open_fullscreen':
              onOpenFullscreen(true);
              appliedBadges.push('Opened Fullscreen Player');
              break;
            case 'open_lyrics':
              onNavigateTab('lyrics');
              appliedBadges.push('Opened Sync Lyrics');
              break;
            case 'open_dsp':
              onOpenDsp();
              appliedBadges.push('Opened DSP Equalizer');
              break;
            case 'open_live_studio':
              onOpenLiveStudio();
              appliedBadges.push('Opened Shared Live Studio');
              break;
            case 'pick_song':
              onPickSong();
              appliedBadges.push('Opened Song Picker');
              break;
            case 'pick_folder':
              onPickFolder();
              appliedBadges.push('Opened Folder Picker');
              break;
          }
          continue;
        }

        if (action.type === 'update_dsp') {
          const nextPreset = action.eqPreset ?? dsp.preset;
          const nextBands =
            action.eqPreset && action.eqPreset in EQ_PRESETS
              ? [...EQ_PRESETS[action.eqPreset]]
              : [...dsp.bands];
          onUpdateDsp({
            preset: nextPreset,
            bands: nextBands as DspSettings['bands'],
            bassBoostEnabled: action.bassBoostEnabled ?? dsp.bassBoostEnabled,
            bassBoostDb: action.bassBoostDb ?? dsp.bassBoostDb,
            crossfadeSeconds: action.crossfadeSeconds ?? dsp.crossfadeSeconds,
          });
          appliedBadges.push(
            action.eqPreset ? `EQ: ${action.eqPreset}` : 'Updated DSP Audio'
          );
          continue;
        }

        if (action.type === 'navigate_tab') {
          if (action.tab !== 'lyrics') {
            onOpenFullscreen(false);
          }
          onNavigateTab(action.tab, action.librarySubTab, action.searchQuery);
          appliedBadges.push(
            action.searchQuery
              ? `Searched "${action.searchQuery}"`
              : `Opened ${action.tab}`
          );
          continue;
        }

        if (action.type === 'toggle_favorite_current') {
          if (engine.currentTrack) {
            onToggleFavorite(engine.currentTrack.id);
            appliedBadges.push(
              action.favorite
                ? `Favorited "${engine.currentTrack.title}"`
                : 'Removed from favorites'
            );
          }
          continue;
        }

        if (action.type === 'download_current_track') {
          if (engine.currentTrack) {
            if (action.destination === 'device') {
              void onDownloadToDevice([engine.currentTrack], action.formatId ?? 'mp3-160');
              appliedBadges.push(`Downloading "${engine.currentTrack.title}"`);
            } else {
              void onDownloadToApp([engine.currentTrack]);
              appliedBadges.push(`Saving "${engine.currentTrack.title}" offline`);
            }
          }
          continue;
        }

        if (action.type === 'play_library_match') {
          const needle = action.query.toLowerCase();
          const match =
            savedTracks.find(
              (t) =>
                t.title.toLowerCase().includes(needle) ||
                t.artist.toLowerCase().includes(needle)
            ) || null;
          if (match) {
            if (action.mode === 'queue') {
              onQueueTracks([match]);
              appliedBadges.push(`Queued library track "${match.title}"`);
            } else {
              onPlayTrack(match);
              appliedBadges.push(`Playing "${match.title}"`);
            }
          } else {
            candidateSeeds.push({
              query: action.query,
              label: action.query,
              sublabel: 'Streaming Search',
              autoMode: action.mode === 'queue' ? 'add_to_queue' : 'ask_confirm',
            });
          }
          continue;
        }

        if (action.type === 'play_song') {
          candidateSeeds.push({
            query: action.query,
            label: action.title || action.query,
            sublabel: action.artist || 'YouTube / Audius Stream',
            autoMode: action.mode,
          });
          continue;
        }

        if (action.type === 'identify_song_candidates') {
          action.candidates.forEach((c: AiIdentifiedCandidate) => {
            candidateSeeds.push({
              query: buildAiTrackSearchQuery(c),
              label: c.title,
              sublabel: c.artist,
              reason: c.reason,
            });
          });
          continue;
        }

        if (action.type === 'create_playlist') {
          playlistActions.push(action);
        }
      }

      const uniqueSeeds: typeof candidateSeeds = [];
      const seenQueries = new Set<string>();
      for (const item of candidateSeeds) {
        const key = item.query.toLowerCase();
        if (!key || seenQueries.has(key)) continue;
        seenQueries.add(key);
        uniqueSeeds.push(item);
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id !== messageId
            ? m
            : {
                ...m,
                appliedBadges: appliedBadges.length > 0 ? appliedBadges : undefined,
                candidates:
                  uniqueSeeds.length > 0
                    ? uniqueSeeds.map((s) => ({
                        label: s.label,
                        sublabel: s.sublabel,
                        reason: s.reason,
                        track: null,
                        resolving: true,
                      }))
                    : undefined,
                createdPlaylists:
                  playlistActions.length > 0
                    ? playlistActions.map((pl) => ({
                        name: pl.name,
                        description: pl.description,
                        tracks: [],
                        resolving: true,
                      }))
                    : undefined,
              }
        )
      );

      if (uniqueSeeds.length > 0) {
        // When single play_song asks confirmation, pull up to 3 playable options
        const singleConfirm =
          uniqueSeeds.length === 1 && uniqueSeeds[0].autoMode === 'ask_confirm';

        if (singleConfirm) {
          const foundList = await resolveStreamTracks(uniqueSeeds[0].query, 3);
          const valid = foundList.filter(Boolean);
          if (valid.length > 0) {
            setPendingAction({
              kind: 'tracks',
              tracks: valid,
              label: uniqueSeeds[0].label,
            });
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id !== messageId
                ? m
                : {
                    ...m,
                    text:
                      valid.length > 0
                        ? `Found ${formatTrackSummaryLine(valid[0])}. Would you like me to play it now?`
                        : `I searched YouTube for "${uniqueSeeds[0].query}", but didn't find a playable stream right now.`,
                    awaitingConfirm: valid.length > 0,
                    candidates:
                      valid.length > 0
                        ? valid.map((tr) => ({
                            label: tr.title,
                            sublabel: `${tr.artist}${tr.duration > 0 ? ` · ${formatDuration(tr.duration)}` : ''}`,
                            track: tr,
                            resolving: false,
                          }))
                        : [
                            {
                              label: uniqueSeeds[0].label,
                              sublabel: 'No live stream found',
                              track: null,
                              resolving: false,
                            },
                          ],
                  }
            )
          );
        } else {
          const resolvedTracks = await Promise.all(
            uniqueSeeds.map((seed) => resolveStreamTrack(seed.query))
          );

          let triggeredAutoPlay = false;
          const confirmTracks: Track[] = [];
          const newBadges: string[] = [];

          resolvedTracks.forEach((tr, idx) => {
            const mode = uniqueSeeds[idx]?.autoMode;
            if (!tr) return;
            if (mode === 'ask_confirm') {
              confirmTracks.push(tr);
            } else if (mode === 'play_now' && !triggeredAutoPlay) {
              triggeredAutoPlay = true;
              onPlayTrack(tr);
              newBadges.push(`Playing "${tr.title}"`);
            } else if (mode === 'play_next') {
              onPlayNext(tr);
              newBadges.push(`Playing "${tr.title}" next`);
            } else if (mode === 'add_to_queue') {
              onQueueTracks([tr]);
              newBadges.push(`Queued "${tr.title}"`);
            }
          });

          if (confirmTracks.length > 0) {
            setPendingAction({
              kind: 'tracks',
              tracks: confirmTracks,
            });
          } else {
            const allResolved = resolvedTracks.filter((t): t is Track => Boolean(t));
            if (allResolved.length > 0 && !triggeredAutoPlay && newBadges.length === 0) {
              setPendingAction({ kind: 'tracks', tracks: allResolved });
            }
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id !== messageId
                ? m
                : {
                    ...m,
                    awaitingConfirm:
                      confirmTracks.length > 0 ||
                      (newBadges.length === 0 && resolvedTracks.some(Boolean)),
                    appliedBadges:
                      newBadges.length > 0
                        ? [...(m.appliedBadges || []), ...newBadges]
                        : m.appliedBadges,
                    candidates: uniqueSeeds.map((s, idx) => {
                      const tr = resolvedTracks[idx];
                      return {
                        label: tr?.title || s.label,
                        sublabel: tr
                          ? `${tr.artist}${tr.duration > 0 ? ` · ${formatDuration(tr.duration)}` : ''}`
                          : s.sublabel,
                        reason: s.reason,
                        track: tr,
                        resolving: false,
                      };
                    }),
                  }
            )
          );
        }
      }

      for (let pIdx = 0; pIdx < playlistActions.length; pIdx++) {
        const plAction = playlistActions[pIdx];
        const fetched = await Promise.all(
          plAction.trackQueries.map((q) => resolveStreamTrack(q))
        );
        const dedupedTracks: Track[] = [];
        const seenTrackIds = new Set<string>();
        for (const tr of fetched) {
          if (!tr || seenTrackIds.has(tr.id)) continue;
          seenTrackIds.add(tr.id);
          dedupedTracks.push(tr);
        }

        if (dedupedTracks.length > 0) {
          await onCreatePlaylist(
            plAction.name,
            plAction.description || `AI playlist (${dedupedTracks.length} tracks)`,
            dedupedTracks
          );
          if (plAction.autoPlay) {
            onPlayCollection(dedupedTracks, 0);
          } else {
            setPendingAction({
              kind: 'playlist',
              name: plAction.name,
              description: plAction.description,
              tracks: dedupedTracks,
            });
          }
          triggerHaptic('success');
        }

        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId || !m.createdPlaylists) return m;
            return {
              ...m,
              createdPlaylists: m.createdPlaylists.map((card, idx) =>
                idx === pIdx
                  ? {
                      ...card,
                      tracks: dedupedTracks,
                      resolving: false,
                    }
                  : card
              ),
            };
          })
        );
      }
    },
    [
      dsp,
      engine.currentTrack,
      onCreatePlaylist,
      onDownloadToApp,
      onDownloadToDevice,
      onNavigateTab,
      onNext,
      onOpenDsp,
      onOpenFullscreen,
      onOpenLiveStudio,
      onPause,
      onPickFolder,
      onPickSong,
      onPlay,
      onPlayCollection,
      onPlayNext,
      onPlayTrack,
      onPrev,
      onQueueTracks,
      onSeekBy,
      onToggleAutoplayRadio,
      onToggleFavorite,
      onTogglePlay,
      onToggleShuffle,
      onUpdateDsp,
      resolveStreamTrack,
      resolveStreamTracks,
      savedTracks,
    ]
  );

  const applySiriFallbackResult = useCallback(
    async (messageId: string, prompt: string, contextPayload: AiAssistantContextPayload) => {
      const result = await runSiriAssistantTurn({
        prompt,
        context: contextPayload,
        savedTracks,
        pendingAction,
      });

      if (result.clearPending) {
        setPendingAction(null);
      } else if (result.nextPending !== undefined) {
        setPendingAction(result.nextPending);
      }

      // Handle already-resolved tracks directly (from confirmation or play_next/queue)
      const resolvedDirect = result.resolvedTracks || [];
      const directBadges: string[] = [];
      let didAutoPlay = false;

      if (resolvedDirect.length > 0) {
        const primaryAction = result.actions.find((a) => a.type === 'play_song');
        const mode =
          primaryAction && primaryAction.type === 'play_song'
            ? primaryAction.mode
            : 'play_now';
        const tr = resolvedDirect[0];
        if (mode === 'play_next') {
          onPlayNext(tr);
          directBadges.push(`Playing "${tr.title}" next`);
        } else if (mode === 'add_to_queue') {
          onQueueTracks([tr]);
          directBadges.push(`Queued "${tr.title}"`);
        } else if (!didAutoPlay) {
          didAutoPlay = true;
          onPlayTrack(tr);
          directBadges.push(`Playing "${tr.title}"`);
        }
        triggerHaptic('success');
      }

      let playlistCards: CreatedPlaylistCard[] | undefined;
      if (result.createdPlaylist) {
        const { name, description, tracks, autoPlay } = result.createdPlaylist;
        if (tracks.length > 0) {
          await onCreatePlaylist(name, description, tracks);
          if (autoPlay) {
            onPlayCollection(tracks, 0);
            directBadges.push(`Playing "${name}"`);
          } else {
            directBadges.push(`Saved playlist "${name}"`);
          }
          triggerHaptic('success');
        }
        playlistCards = [
          {
            name,
            description,
            tracks,
            resolving: false,
          },
        ];
      }

      const displayTracks =
        result.awaitingConfirmTracks && result.awaitingConfirmTracks.length > 0
          ? result.awaitingConfirmTracks
          : resolvedDirect;

      setMessages((prev) => [
        ...prev,
        {
          id: messageId,
          role: 'model',
          text: result.reply,
          sources: result.sources,
          awaitingConfirm: Boolean(
            result.awaitingConfirmTracks &&
              result.awaitingConfirmTracks.length > 0 &&
              !result.clearPending
          ),
          appliedBadges: directBadges.length > 0 ? directBadges : undefined,
          candidates:
            displayTracks.length > 0
              ? displayTracks.map((tr) => ({
                  label: tr.title,
                  sublabel: `${tr.artist}${tr.duration > 0 ? ` · ${formatDuration(tr.duration)}` : ''}`,
                  track: tr,
                  resolving: false,
                }))
              : undefined,
          createdPlaylists: playlistCards,
        },
      ]);

      // Execute remaining non-track actions (playback controls, DSP, tabs, favorites, downloads)
      const nonTrackActions =
        resolvedDirect.length > 0
          ? result.actions.filter((a) => a.type !== 'play_song')
          : result.actions;

      if (nonTrackActions.length > 0) {
        await executeAssistantActions(messageId, nonTrackActions);
      }
    },
    [
      executeAssistantActions,
      onCreatePlaylist,
      onPlayCollection,
      onPlayNext,
      onPlayTrack,
      onQueueTracks,
      pendingAction,
      savedTracks,
    ]
  );

  const sendAssistantRequest = useCallback(
    async (options: {
      prompt?: string;
      audioBase64?: string;
      audioMimeType?: string;
      audioDurationSec?: number;
    }) => {
      const prompt = (options.prompt || '').trim();
      const hasAudio = Boolean(options.audioBase64);
      if (!prompt && !hasAudio) return;

      setMicError(null);
      setIsOpen(true);
      setIsDrawerMinimized(false);

      const userDisplay =
        prompt || `Voice / hummed audio (${formatRecordingTimer(options.audioDurationSec || 0)})`;
      const userMsgId = `u-${Date.now().toString(36)}`;
      const modelMsgId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

      const priorHistory = messages
        .filter((m) => !m.error && m.text.trim().length > 0)
        .slice(-8)
        .map((m) => ({
          role: m.role,
          text: m.text,
        }));

      setMessages((prev) => [
        ...prev,
        {
          id: userMsgId,
          role: 'user',
          text: userDisplay,
          hasAudioClip: hasAudio,
          audioDurationSec: options.audioDurationSec,
        },
      ]);
      setInputText('');
      setIsSending(true);
      triggerHaptic('selection');

      const contextPayload = buildContextPayload();

      try {
        // 1. Instant handling of conversational confirmations ("yes", "play next", "2nd one", "no")
        if (prompt && pendingAction && matchPendingConfirmation(prompt, pendingAction)) {
          await applySiriFallbackResult(modelMsgId, prompt, contextPayload);
          return;
        }

        const customApiBase = (import.meta.env.VITE_AI_API_URL || '').trim().replace(/\/$/, '');
        const assistEndpoint = customApiBase ? `${customApiBase}/api/ai/assist` : '/api/ai/assist';
        const canCallBackend = !isNativeAndroidApp() || Boolean(customApiBase);

        // Standalone Android APK without external backend: handle raw hum clips honestly & voice/text with live Siri engine
        if (!canCallBackend) {
          if (!prompt && hasAudio) {
            setMessages((prev) => [
              ...prev,
              {
                id: modelMsgId,
                role: 'model',
                text: 'Voice speech commands and lyrics searches work right now on your phone! For raw melody humming without words, please speak the song lyrics, artist, or title aloud (e.g. "Play Wakadinali Blow") or type it below.',
              },
            ]);
            return;
          }
          await applySiriFallbackResult(modelMsgId, prompt, contextPayload);
          return;
        }

        // 2. Web or configured backend: call Gemini /api/ai/assist first with strict JSON validation
        let backendSucceeded = false;
        let backendErrorMsg = '';
        try {
          const res = await fetch(assistEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              audioBase64: options.audioBase64,
              audioMimeType: options.audioMimeType,
              history: priorHistory,
              context: contextPayload,
            }),
          });

          const contentType = (res.headers.get('content-type') || '').toLowerCase();
          if (contentType.includes('application/json')) {
            const data = (await res.json().catch(() => ({}))) as Partial<AiAssistantResponse> & {
              error?: string;
            };
            const validReply = typeof data.reply === 'string' ? data.reply.trim() : '';
            const actions = Array.isArray(data.actions) ? data.actions : [];
            const sources = Array.isArray(data.sources) ? data.sources : [];

            if (res.ok && (validReply.length > 0 || actions.length > 0)) {
              backendSucceeded = true;
              const fallbackIntro =
                actions.length > 0 ? 'Searching and executing your request...' : '';
              setMessages((prev) => [
                ...prev,
                {
                  id: modelMsgId,
                  role: 'model',
                  text: validReply || fallbackIntro,
                  sources,
                },
              ]);
              if (actions.length > 0) {
                void executeAssistantActions(modelMsgId, actions);
              }
            } else if (data.error) {
              backendErrorMsg = data.error;
            }
          }
        } catch (netErr) {
          backendErrorMsg =
            netErr instanceof Error ? netErr.message : 'Could not reach AI backend.';
        }

        // 3. Seamless fallback to client/APK interactive Siri engine whenever backend is unavailable/HTML/503/429
        if (!backendSucceeded) {
          if (prompt) {
            await applySiriFallbackResult(modelMsgId, prompt, contextPayload);
          } else {
            throw new Error(
              backendErrorMsg ||
                'Audio hum analysis is temporarily unavailable right now. Try speaking or typing the lyrics or song name.'
            );
          }
        }
      } catch (err) {
        const errText =
          err instanceof Error && err.message
            ? err.message
            : 'Could not complete your request right now.';
        setMessages((prev) => [
          ...prev,
          {
            id: modelMsgId,
            role: 'model',
            text: errText,
            error: errText,
          },
        ]);
      } finally {
        setIsSending(false);
      }
    },
    [
      applySiriFallbackResult,
      buildContextPayload,
      executeAssistantActions,
      messages,
      pendingAction,
    ]
  );

  const stopRecording = useCallback(
    (discard = false) => {
      discardRecordingRef.current = discard;
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      if (speechRecRef.current) {
        try {
          if (discard) speechRecRef.current.abort();
          else speechRecRef.current.stop();
        } catch {
          // Ignore
        }
      }
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          cleanupRecordingResources();
        }
      } else {
        cleanupRecordingResources();
      }
    },
    [cleanupRecordingResources]
  );

  const startRecording = useCallback(async () => {
    setMicError(null);
    setIsOpen(true);
    setIsDrawerMinimized(false);
    speechTranscriptRef.current = '';
    setLiveTranscript('');

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setMicError('Microphone recording is not supported in this browser/device.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setMicError('Audio recording (MediaRecorder) is unavailable here.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;
      chunksRef.current = [];
      discardRecordingRef.current = false;

      // Start parallel speech recognition so spoken commands ("Play Wakadinali Blow") transcribe cleanly even offline/APK
      const SpeechCtor = getSpeechRecognitionCtor();
      if (SpeechCtor) {
        try {
          const sr = new SpeechCtor();
          sr.continuous = true;
          sr.interimResults = true;
          sr.lang = 'en-US';
          sr.onresult = (ev) => {
            const parts: string[] = [];
            for (let i = 0; i < ev.results.length; i++) {
              const seg = ev.results[i]?.[0]?.transcript;
              if (seg) parts.push(seg.trim());
            }
            const joined = parts.join(' ').trim();
            speechTranscriptRef.current = joined;
            setLiveTranscript(joined);
          };
          sr.onerror = () => {
            // Non-fatal: MediaRecorder audio capture continues smoothly
          };
          speechRecRef.current = sr;
          sr.start();
        } catch {
          speechRecRef.current = null;
        }
      }

      const mimeType = pickSupportedRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };

      recorder.onerror = () => {
        setMicError('Microphone capture failed. Check app permissions.');
        cleanupRecordingResources();
      };

      recorder.onstop = async () => {
        const shouldDiscard = discardRecordingRef.current;
        const durationElapsed = Math.max(
          1,
          Math.round((Date.now() - recordStartedAtRef.current) / 1000)
        );
        const capturedTranscript = speechTranscriptRef.current.trim();
        speechTranscriptRef.current = '';
        const recordedMime = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: recordedMime });
        chunksRef.current = [];
        cleanupRecordingResources();

        if (shouldDiscard) return;

        const typedHint = inputText.trim();
        if (!typedHint && isMeaningfulSpokenCommand(capturedTranscript)) {
          await sendAssistantRequest({ prompt: capturedTranscript });
          return;
        }

        if (blob.size < 256) return;

        try {
          const base64 = await blobToBase64(blob);
          await sendAssistantRequest({
            prompt: typedHint || (isNativeAndroidApp() ? capturedTranscript : ''),
            audioBase64: base64,
            audioMimeType: recordedMime,
            audioDurationSec: durationElapsed,
          });
        } catch {
          setMicError('Could not process audio clip. Please try again.');
        }
      };

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        try {
          const ctx = new AudioCtx();
          analyserCtxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 32;
          src.connect(analyser);
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          const tickLevels = () => {
            analyser.getByteFrequencyData(dataArray);
            const bars = [0, 1, 2, 3, 4, 5, 6].map((idx) => {
              const raw = dataArray[idx % dataArray.length] ?? 20;
              return Math.max(0.16, Math.min(1, raw / 180));
            });
            setMicBars(bars);
            analyserRafRef.current = window.requestAnimationFrame(tickLevels);
          };
          analyserRafRef.current = window.requestAnimationFrame(tickLevels);
        } catch {
          // Non-fatal
        }
      }

      recordStartedAtRef.current = Date.now();
      setRecordingSec(0);
      setIsRecording(true);
      triggerHaptic('medium');
      recorder.start(250);

      recordTimerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartedAtRef.current) / 1000);
        setRecordingSec(elapsed);
        if (elapsed >= MAX_RECORDING_SECONDS) {
          stopRecording(false);
        }
      }, 250);
    } catch (err) {
      cleanupRecordingResources();
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setMicError(
          'Microphone permission denied. Allow microphone access to hum or speak requests.'
        );
      } else {
        setMicError('Could not access microphone on this device.');
      }
    }
  }, [cleanupRecordingResources, inputText, sendAssistantRequest, stopRecording]);

  const handleMicToggle = () => {
    if (isSending) return;
    if (isRecording) {
      stopRecording(false);
    } else {
      void startRecording();
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRecording) {
      stopRecording(false);
      return;
    }
    if (!inputText.trim() || isSending) return;
    void sendAssistantRequest({ prompt: inputText });
  };

  const handleOpenAssistant = () => {
    triggerHaptic('light');
    setIsOpen(true);
    setIsDrawerMinimized(false);
    window.setTimeout(() => inputRef.current?.focus(), 60);
  };

  const handleCloseAssistant = () => {
    triggerHaptic('light');
    if (isRecording) {
      stopRecording(true);
    }
    setIsOpen(false);
  };

  const hasTrack = Boolean(engine.currentTrack);
  const isMobile = viewportSize.w < 768;
  const defaultBottomPx = isFullscreenOpen
    ? isMobile
      ? 205
      : 196
    : hasTrack
      ? isMobile
        ? 138
        : 96
      : isMobile
        ? 72
        : 24;

  const fabCoords = (() => {
    if (dragCoords) return dragCoords;
    const minTop = 68;
    const maxTop = Math.max(minTop + 40, viewportSize.h - 90);
    if (savedFabPos) {
      const left =
        savedFabPos.side === 'left'
          ? FAB_MARGIN_PX
          : Math.max(FAB_MARGIN_PX, viewportSize.w - FAB_SIZE_PX - FAB_MARGIN_PX);
      const top = Math.max(minTop, Math.min(maxTop, Math.round(savedFabPos.topRatio * viewportSize.h)));
      return { left, top };
    }
    return {
      left: Math.max(FAB_MARGIN_PX, viewportSize.w - FAB_SIZE_PX - (isMobile ? 14 : 24)),
      top: Math.max(minTop, viewportSize.h - defaultBottomPx - FAB_SIZE_PX),
    };
  })();

  const handleFabPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: fabCoords.left,
      originTop: fabCoords.top,
      lastLeft: fabCoords.left,
      lastTop: fabCoords.top,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture error
    }
  };

  const handleFabPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const st = dragStateRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.moved && Math.hypot(dx, dy) < 6) return;
    st.moved = true;
    const clampedLeft = Math.max(
      8,
      Math.min(viewportSize.w - FAB_SIZE_PX - 8, st.originLeft + dx)
    );
    const clampedTop = Math.max(
      60,
      Math.min(viewportSize.h - FAB_SIZE_PX - 64, st.originTop + dy)
    );
    st.lastLeft = clampedLeft;
    st.lastTop = clampedTop;
    setDragCoords({ left: clampedLeft, top: clampedTop });
  };

  const handleFabPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const st = dragStateRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    if (!st.moved) {
      skipNextClickRef.current = true;
      window.setTimeout(() => {
        skipNextClickRef.current = false;
      }, 250);
      setDragCoords(null);
      handleOpenAssistant();
      return;
    }

    skipNextClickRef.current = true;
    window.setTimeout(() => {
      skipNextClickRef.current = false;
    }, 250);

    const side: 'left' | 'right' =
      st.lastLeft + FAB_SIZE_PX / 2 < viewportSize.w / 2 ? 'left' : 'right';
    const nextPos: SavedFabPosition = {
      side,
      topRatio: Math.max(0.1, Math.min(0.86, st.lastTop / Math.max(1, viewportSize.h))),
    };
    setSavedFabPos(nextPos);
    setDragCoords(null);
    try {
      localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify(nextPos));
    } catch {
      // Ignore storage error
    }
    triggerHaptic('light');
  };

  const expandedBottomClass = isFullscreenOpen
    ? 'bottom-[calc(1.25rem+env(safe-area-inset-bottom))] md:bottom-6 md:right-6'
    : hasTrack
      ? 'bottom-[calc(8.6rem+env(safe-area-inset-bottom))] md:bottom-[5.75rem] md:right-6'
      : 'bottom-[calc(4.35rem+env(safe-area-inset-bottom))] md:bottom-6 md:right-6';

  if (!isOpen) {
    return (
      <button
        type="button"
        onPointerDown={handleFabPointerDown}
        onPointerMove={handleFabPointerMove}
        onPointerUp={handleFabPointerUp}
        onPointerCancel={() => {
          dragStateRef.current = null;
          setDragCoords(null);
        }}
        onClick={() => {
          if (skipNextClickRef.current) {
            skipNextClickRef.current = false;
            return;
          }
          handleOpenAssistant();
        }}
        aria-label="Open Ai music assistant (drag to move)"
        title="Ask Ai (tap to open, drag to move)"
        data-testid="ai-floating-fab"
        style={{
          left: `${fabCoords.left}px`,
          top: `${fabCoords.top}px`,
        }}
        className="touch-none select-none fixed z-[92] flex h-10 w-10 items-center justify-center rounded-full bg-[#E11D48] text-white font-display text-[15px] font-extrabold leading-none tracking-tight border-2 border-black ring-1 ring-white/25 shadow-[0_6px_22px_rgba(var(--kago-accent-rgb),0.55)] hover:bg-[#BE123C] cursor-pointer after:absolute after:-inset-1.5 after:content-['']"
      >
        Ai
      </button>
    );
  }

  const showDrawer = !isDrawerMinimized;
  const samplePrompt = engine.currentTrack
    ? `Where was "${engine.currentTrack.title}" by ${engine.currentTrack.artist} sampled from?`
    : 'Where was "Hotline Bling" by Drake sampled from?';

  return (
    <div
      role="dialog"
      aria-label="kaGO.PIaY Ai Assistant"
      data-testid="ai-assistant-widget"
      className={`fixed z-[92] left-3 right-3 sm:left-auto sm:right-5 sm:w-[27rem] ${expandedBottomClass} flex flex-col items-end gap-2.5`}
    >
      {/* Expandable Floating Sheet Above Capsule Input */}
      {showDrawer && (
        <div className="kago-sheet-slide w-full overflow-hidden rounded-2xl border border-[#262936] bg-[#0C0D12]/95 shadow-[0_24px_60px_rgba(0,0,0,0.88)] backdrop-blur-xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#1E2028] px-4 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#E11D48] font-display text-[11px] font-extrabold text-white">
                Ai
              </span>
              <span className="truncate font-display text-xs font-bold text-[#F4F3F0]">
                kaGO Ai Assistant
              </span>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    setMessages([]);
                    setPendingAction(null);
                    setMicError(null);
                  }}
                  aria-label="Clear assistant conversation"
                  title="Clear conversation"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[#8E929B] hover:bg-[#191B24] hover:text-white cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsDrawerMinimized(true)}
                aria-label="Minimize assistant panel"
                title="Minimize"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[#8E929B] hover:bg-[#191B24] hover:text-white cursor-pointer"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[48dvh] overflow-y-auto px-3.5 py-3 space-y-3">
            {micError && (
              <div
                role="alert"
                className="flex items-start justify-between gap-2 rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 text-xs text-red-200"
              >
                <span>{micError}</span>
                <button
                  type="button"
                  onClick={() => setMicError(null)}
                  aria-label="Dismiss microphone error"
                  className="shrink-0 text-red-300 hover:text-white cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Live Hum / Voice Recording Panel */}
            {isRecording && (
              <div className="rounded-xl border border-[#E11D48]/50 bg-[#15090E] p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#F4F3F0]">
                    Listening — speak a command or hum...
                  </span>
                  <span className="font-mono-tabular text-xs font-semibold text-[#FF4D6D]">
                    {formatRecordingTimer(recordingSec)} / {formatRecordingTimer(MAX_RECORDING_SECONDS)}
                  </span>
                </div>
                {liveTranscript && (
                  <p className="rounded-lg bg-black/40 px-2.5 py-1.5 text-xs italic text-[#F4F3F0]">
                    "{liveTranscript}"
                  </p>
                )}
                <div className="flex h-8 items-end justify-center gap-1.5 px-2">
                  {micBars.map((level, idx) => (
                    <span
                      key={idx}
                      className="w-1.5 rounded-full bg-[#E11D48] transition-[height] duration-75"
                      style={{ height: `${Math.round(level * 28)}px` }}
                    />
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => stopRecording(true)}
                    className="min-h-[38px] rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs font-semibold text-[#C7C9D1] hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => stopRecording(false)}
                    className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    <span>Send</span>
                  </button>
                </div>
              </div>
            )}

            {/* Quick Starter Actions when empty */}
            {messages.length === 0 && !isRecording && !isSending && (
              <div className="space-y-2">
                <p className="text-xs leading-relaxed text-[#9CA3AF]">
                  Ask me like Siri: find & confirm songs or YouTube mixes, identify lyrics, check samples, control EQ, or build playlists.
                </p>
                <div className="grid grid-cols-1 gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      void sendAssistantRequest({
                        prompt: 'Play a Kenyan popular song by Wakadinali called Blow',
                      })
                    }
                    className="flex min-h-[44px] items-center gap-2.5 rounded-xl border border-[#222530] bg-[#14161D] px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:border-[#E11D48]/60 cursor-pointer"
                  >
                    <Play className="h-4 w-4 shrink-0 text-[#FF4D6D]" />
                    <span className="truncate">Play a Kenyan popular song by Wakadinali called Blow</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void startRecording()}
                    className="flex min-h-[44px] items-center gap-2.5 rounded-xl border border-[#222530] bg-[#14161D] px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:border-[#E11D48]/60 cursor-pointer"
                  >
                    <Mic className="h-4 w-4 shrink-0 text-[#FF4D6D]" />
                    <span>Speak a command or hum a song</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInputText('Find song by lyrics: ');
                      inputRef.current?.focus();
                    }}
                    className="flex min-h-[44px] items-center gap-2.5 rounded-xl border border-[#222530] bg-[#14161D] px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:border-[#E11D48]/60 cursor-pointer"
                  >
                    <Music2 className="h-4 w-4 shrink-0 text-[#FF4D6D]" />
                    <span>Type lyrics to identify a song</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendAssistantRequest({ prompt: samplePrompt })}
                    className="flex min-h-[44px] items-center gap-2.5 rounded-xl border border-[#222530] bg-[#14161D] px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:border-[#E11D48]/60 cursor-pointer"
                  >
                    <Sparkles className="h-4 w-4 shrink-0 text-[#FF4D6D]" />
                    <span className="truncate">{samplePrompt}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInputText('Create a playlist for ');
                      inputRef.current?.focus();
                    }}
                    className="flex min-h-[44px] items-center gap-2.5 rounded-xl border border-[#222530] bg-[#14161D] px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:border-[#E11D48]/60 cursor-pointer"
                  >
                    <ListMusic className="h-4 w-4 shrink-0 text-[#FF4D6D]" />
                    <span>Create a playlist by artist, genre, or mood</span>
                  </button>
                </div>
              </div>
            )}

            {/* Conversation Messages */}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col gap-2 ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[#E11D48] text-white'
                      : msg.error
                        ? 'border border-red-500/40 bg-red-950/30 text-red-200'
                        : 'border border-[#222530] bg-[#14161D] text-[#F4F3F0]'
                  }`}
                >
                  {msg.hasAudioClip && (
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold opacity-90">
                      <Mic className="h-3 w-3" />
                      <span>Mic Audio Clip</span>
                    </div>
                  )}
                  <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                </div>

                {/* Executed App Control Confirmations */}
                {msg.appliedBadges && msg.appliedBadges.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {msg.appliedBadges.map((label, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300"
                      >
                        <Check className="h-3 w-3 shrink-0" />
                        <span>{label}</span>
                      </span>
                    ))}
                  </div>
                )}

                {/* Playable Track Results / Interactive Confirmation Cards */}
                {msg.candidates && msg.candidates.length > 0 && (
                  <div className="w-full space-y-1.5">
                    {msg.candidates.map((cand, idx) => (
                      <div
                        key={idx}
                        className={`rounded-xl border p-2.5 space-y-2 ${
                          idx === 0 && msg.awaitingConfirm
                            ? 'border-[#E11D48]/55 bg-[#15090E]'
                            : 'border-[#222530] bg-[#12141B]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2.5">
                          <div className="flex min-w-0 flex-1 items-center gap-2.5">
                            {cand.track?.artworkUrl ? (
                              <img
                                src={cand.track.artworkUrl}
                                alt={cand.label}
                                referrerPolicy="no-referrer"
                                className="h-10 w-10 shrink-0 rounded-lg object-cover border border-[#262936]"
                              />
                            ) : (
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#262936] bg-[#1A1C24] text-[#FF4D6D]">
                                {cand.resolving ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Music2 className="h-4 w-4" />
                                )}
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-semibold text-[#F4F3F0]">
                                {cand.label}
                              </p>
                              <p className="truncate text-[11px] text-[#8E929B]">{cand.sublabel}</p>
                              {cand.reason && (
                                <p className="mt-0.5 line-clamp-1 text-[10px] text-[#9CA3AF]">
                                  {cand.reason}
                                </p>
                              )}
                            </div>
                          </div>

                          {cand.track && !(idx === 0 && msg.awaitingConfirm) && (
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  handleConfirmTrackDecision(msg.id, cand.track!, 'play_next')
                                }
                                aria-label={`Play ${cand.track.title} next`}
                                title="Play Next"
                                className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#282B36] bg-[#14161D] text-[#C7C9D1] hover:border-[#E11D48] hover:text-white cursor-pointer"
                              >
                                <ListStart className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleConfirmTrackDecision(msg.id, cand.track!, 'add_to_queue')
                                }
                                aria-label={`Add ${cand.track.title} to queue`}
                                title="Queue"
                                className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#282B36] bg-[#14161D] text-[#C7C9D1] hover:border-[#E11D48] hover:text-white cursor-pointer"
                              >
                                <ListPlus className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleConfirmTrackDecision(msg.id, cand.track!, 'play_now')
                                }
                                aria-label={`Play ${cand.track.title}`}
                                className="inline-flex h-9 items-center gap-1 rounded-lg bg-[#E11D48] px-2.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                              >
                                <Play className="h-3.5 w-3.5 fill-current" />
                                <span>Play</span>
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Interactive Confirmation Bar on Top Match */}
                        {cand.track && idx === 0 && msg.awaitingConfirm && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            <button
                              type="button"
                              onClick={() =>
                                handleConfirmTrackDecision(msg.id, cand.track!, 'play_now')
                              }
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                            >
                              <Play className="h-3.5 w-3.5 fill-current" />
                              <span>Yes, Play Now</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleConfirmTrackDecision(msg.id, cand.track!, 'play_next')
                              }
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-2.5 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                            >
                              <ListStart className="h-3.5 w-3.5 text-[#FF4D6D]" />
                              <span>Play Next</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleConfirmTrackDecision(msg.id, cand.track!, 'add_to_queue')
                              }
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-2.5 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                            >
                              <ListPlus className="h-3.5 w-3.5 text-[#FF4D6D]" />
                              <span>Queue</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCancelConfirmation(msg.id)}
                              className="inline-flex min-h-[38px] items-center rounded-lg border border-[#282B36] bg-[#14161D] px-2.5 py-1.5 text-xs font-medium text-[#9CA3AF] hover:text-white cursor-pointer"
                            >
                              No
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Created Playlists */}
                {msg.createdPlaylists && msg.createdPlaylists.length > 0 && (
                  <div className="w-full space-y-2">
                    {msg.createdPlaylists.map((pl, idx) => (
                      <div
                        key={idx}
                        className="rounded-xl border border-[#E11D48]/40 bg-[#15090E] p-3 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-display text-xs font-bold text-[#F4F3F0]">
                              {pl.name}
                            </p>
                            <p className="mt-0.5 text-[11px] text-[#9CA3AF]">
                              {pl.resolving
                                ? 'Finding playable songs...'
                                : `${pl.tracks.length} playable songs saved to Library`}
                            </p>
                          </div>
                          {pl.resolving && (
                            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#FF4D6D]" />
                          )}
                        </div>
                        {!pl.resolving && pl.tracks.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setPendingAction(null);
                                onPlayCollection(pl.tracks, 0);
                              }}
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                            >
                              <Play className="h-3.5 w-3.5 fill-current" />
                              <span>Play Playlist</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                onOpenFullscreen(false);
                                onNavigateTab('library', 'playlists');
                              }}
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                            >
                              <Sliders className="h-3.5 w-3.5 text-[#FF4D6D]" />
                              <span>Open Playlists</span>
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Grounded Web Sources */}
                {msg.sources && msg.sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {msg.sources.map((src) => (
                      <a
                        key={src.uri}
                        href={src.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-[#262936] bg-[#12141B] px-2 py-1 text-[10px] font-medium text-[#9CA3AF] hover:border-[#E11D48]/60 hover:text-white"
                      >
                        <span className="max-w-[10rem] truncate">{src.title}</span>
                        <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {isSending && (
              <div className="flex items-center gap-2 text-xs text-[#9CA3AF]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#FF4D6D]" />
                <span>Searching & working on it...</span>
              </div>
            )}

            <div ref={scrollEndRef} />
          </div>
        </div>
      )}

      {/* Capsule Input Bar (Mic icon left + input field + send/close) */}
      <form
        onSubmit={handleFormSubmit}
        className="flex w-full items-center gap-1.5 rounded-full border border-[#262936] bg-[#0C0D12]/95 px-2 py-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.88)] backdrop-blur-xl"
      >
        <button
          type="button"
          onClick={handleMicToggle}
          disabled={isSending}
          aria-label={isRecording ? 'Stop recording audio' : 'Hum or speak to Ai'}
          title={isRecording ? 'Tap to send spoken/hummed audio' : 'Speak a command or hum a song'}
          data-testid="ai-mic-button"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
            isRecording
              ? 'bg-[#E11D48] text-white shadow-[0_0_18px_rgba(var(--kago-accent-rgb),0.75)]'
              : 'bg-[#14161D] text-[#FF4D6D] hover:bg-[#1C1E27]'
          }`}
        >
          {isRecording ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-5 w-5" />}
        </button>

        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
            if (isDrawerMinimized) setIsDrawerMinimized(false);
          }}
          onFocus={() => {
            if (isDrawerMinimized) setIsDrawerMinimized(false);
          }}
          placeholder={
            pendingAction
              ? 'Reply "yes", "play next", or ask anything...'
              : isRecording
                ? 'Listening... tap stop when done'
                : 'Ask anything, find a song or mix, lyrics...'
          }
          disabled={isSending}
          data-testid="ai-text-input"
          className="min-w-0 flex-1 bg-transparent px-1.5 py-2 text-sm text-[#F4F3F0] placeholder:text-[#8E929B] focus:outline-none disabled:opacity-60"
        />

        {inputText.trim().length > 0 && !isRecording && (
          <button
            type="submit"
            disabled={isSending}
            aria-label="Send message to Ai"
            data-testid="ai-send-button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#E11D48] text-white hover:bg-[#BE123C] cursor-pointer disabled:opacity-50"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}

        <button
          type="button"
          onClick={handleCloseAssistant}
          aria-label="Close Ai assistant"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#8E929B] hover:bg-[#191B24] hover:text-white cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Disc3,
  GripVertical,
  Heart,
  Loader2,
  Mic2,
  Minus,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  SkipBack,
  SkipForward,
  Sliders,
  Trash2,
} from 'lucide-react';
import type { DspSettings, StoredLyrics, Track } from '../types/audio';
import { formatDuration, parseLrc, findActiveLyricIndex } from '../utils/lrcParser';
import { sanitizeTrackForLyrics } from '../utils/lyricsFetcher';
import { triggerHaptic } from '../utils/haptics';
import { fetchRelatedRadioTracks } from '../utils/streamRadio';
import { SpectrumVisualizer } from './SpectrumVisualizer';
import { VinylTurntable } from './VinylTurntable';
import { WatchVideoViewport } from './WatchVideoViewport';

type FullscreenSubTab = 'turntable' | 'video' | 'lyrics' | 'queue';

interface FullscreenPlayerProps {
  isOpen: boolean;
  onClose: () => void;
  track: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  queue: Track[];
  dsp: DspSettings;
  isFavorite: boolean;
  storedLyrics?: StoredLyrics;
  isInAppPip: boolean;
  onToggleInAppPip: () => void;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onNext: () => void;
  onPrev: () => void;
  onPlayTrack: (track: Track) => void;
  onRemoveFromQueue: (trackId: string) => void;
  onReorderQueue?: (fromIndex: number, toIndex: number) => void;
  onToggleFavorite: (trackId: string) => void;
  onOpenDsp: () => void;
  onUpdateLyricsOffset: (trackId: string, offset: number) => void;
  onOpenStream: () => void;
  onOpenLyricsStudio?: () => void;
  autoplayRadioEnabled: boolean;
  isFetchingRadio: boolean;
  isFetchingLyrics?: boolean;
  onFetchTrackLyrics?: (track: Track, customQuery?: string) => void;
  onToggleAutoplayRadio: () => void;
}

export const FullscreenPlayer: React.FC<FullscreenPlayerProps> = ({
  isOpen,
  onClose,
  track,
  isPlaying,
  currentTime,
  duration,
  queue,
  dsp,
  isFavorite,
  storedLyrics,
  isInAppPip,
  onToggleInAppPip,
  onTogglePlay,
  onSeek,
  onSeekBy,
  onNext,
  onPrev,
  onPlayTrack,
  onRemoveFromQueue,
  onReorderQueue,
  onToggleFavorite,
  onOpenDsp,
  onUpdateLyricsOffset,
  onOpenStream,
  onOpenLyricsStudio,
  autoplayRadioEnabled,
  isFetchingRadio,
  isFetchingLyrics = false,
  onFetchTrackLyrics,
  onToggleAutoplayRadio,
}) => {
  const [subTab, setSubTab] = useState<FullscreenSubTab>('turntable');
  const [fallbackRelated, setFallbackRelated] = useState<Track[]>([]);
  const [loadingWatchRelated, setLoadingWatchRelated] = useState(false);
  const [lyricSearchQuery, setLyricSearchQuery] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const pointerDragFromRef = useRef<number | null>(null);
  const activeLineRef = useRef<HTMLButtonElement | null>(null);

  const rawLrc = storedLyrics?.rawLrc ?? track?.lrcLyrics ?? '';
  const offsetSeconds = storedLyrics?.offsetSeconds ?? 0;
  const parsedLines = useMemo(() => parseLrc(rawLrc), [rawLrc]);
  const activeIdx = useMemo(
    () => findActiveLyricIndex(parsedLines, currentTime, offsetSeconds),
    [parsedLines, currentTime, offsetSeconds]
  );

  // Sync manual search box when switching tracks
  useEffect(() => {
    if (!track) return;
    const { searchQuery } = sanitizeTrackForLyrics(track.title, track.artist);
    setLyricSearchQuery(searchQuery || track.title);
  }, [track?.id]);

  // Smoothly auto-center active lyric line while Sync Lyrics tab is open
  useEffect(() => {
    if (subTab === 'lyrics' && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIdx, subTab]);

  // Build horizontally scrollable related video suggestions from live queue (+ fallback fetch)
  const queueRelated = useMemo(() => {
    if (!track) return [];
    const seen = new Set<string>([track.id]);
    const list: Track[] = [];
    for (const q of queue) {
      if (seen.has(q.id)) continue;
      if (q.autoQueued || Boolean(q.youtubeId) || q.source === 'stream') {
        seen.add(q.id);
        list.push(q);
      }
    }
    return list;
  }, [queue, track?.id]);

  useEffect(() => {
    setFallbackRelated([]);
  }, [track?.id]);

  useEffect(() => {
    if (!isOpen || subTab !== 'video' || !track) return;
    if (queueRelated.length >= 3) {
      return;
    }
    let cancelled = false;
    setLoadingWatchRelated(true);
    void fetchRelatedRadioTracks(track, [track.id, ...queueRelated.map((t) => t.id)])
      .then((fetched) => {
        if (!cancelled) setFallbackRelated(fetched);
      })
      .finally(() => {
        if (!cancelled) setLoadingWatchRelated(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, subTab, track?.id, queueRelated.length]);

  const relatedSuggestions = useMemo(() => {
    if (!track) return [];
    const merged: Track[] = [];
    const seen = new Set<string>([track.id]);
    for (const item of [...queueRelated, ...fallbackRelated]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return merged.slice(0, 12);
  }, [queueRelated, fallbackRelated, track?.id]);

  if (!isOpen || !track) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen Vinyl Turntable Player"
      className="fixed inset-0 z-50 flex flex-col bg-black text-[#F4F3F0]"
    >
      {/* Top Bar */}
      <div className="shrink-0 flex items-center justify-between gap-2 sm:gap-4 border-b border-[#1A1C24] bg-[#06070A] px-3 py-3 sm:px-6 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-3">
        <button
          type="button"
          onClick={() => {
            triggerHaptic('light');
            onClose();
          }}
          aria-label="Back from fullscreen player"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[#242732] bg-[#111319] px-2.5 sm:px-3 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-4 w-4 text-[#E11D48]" />
          <span className="hidden min-[420px]:inline">Back</span>
        </button>

        {/* 4-Tab Switcher (Turntable | Watch Video | Sync Lyrics | Queue) */}
        <div
          role="tablist"
          aria-label="Fullscreen player views"
          className="flex min-w-0 flex-1 max-w-fit items-center gap-1 overflow-x-auto no-scrollbar rounded-lg border border-[#222530] bg-[#0D0E13] p-1"
        >
          {(
            [
              { id: 'turntable', label: 'Turntable' },
              { id: 'video', label: 'Watch Video' },
              { id: 'lyrics', label: 'Sync Lyrics' },
              { id: 'queue', label: 'Queue' },
            ] as const
          ).map((t) => {
            const active = subTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  triggerHaptic('light');
                  setSubTab(t.id);
                }}
                className={`shrink-0 rounded-md px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                    : 'text-[#8E929B] hover:text-white'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => {
            triggerHaptic('light');
            onOpenDsp();
          }}
          aria-label="Open Hardware DSP Studio"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#242732] bg-[#111319] text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
        >
          <Sliders className="h-4 w-4" />
        </button>
      </div>

      {/* Main Content Stage */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl">
          {subTab === 'turntable' && (
            <div className="kago-panel-enter space-y-6">
              <VinylTurntable
                track={track}
                isPlaying={isPlaying}
                onTogglePlay={() => {
                  triggerHaptic('light');
                  onTogglePlay();
                }}
                size="lg"
              />
              <SpectrumVisualizer isPlaying={isPlaying} dsp={dsp} compact />
            </div>
          )}

          {subTab === 'video' && (
            <div className="space-y-3.5">
              <WatchVideoViewport
                track={track}
                isPlaying={isPlaying}
                currentTime={currentTime}
                zIndex={60}
                compact
                isInAppPip={isInAppPip}
                onToggleInAppPip={() => {
                  onToggleInAppPip();
                  onClose();
                }}
                onOpenStream={() => {
                  onClose();
                  onOpenStream();
                }}
              />

              {/* Horizontal Related Videos Scroller (3 rectangles visible side-by-side) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#C7C9D1]">
                      Up Next · Related Videos
                    </span>
                    {(isFetchingRadio || loadingWatchRelated) && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E11D48]" />
                    )}
                  </div>
                  <span className="font-mono-tabular text-[11px] text-[#8E929B]">
                    Scroll for more
                  </span>
                </div>

                {relatedSuggestions.length > 0 ? (
                  <div
                    data-testid="related-video-suggestions"
                    className="no-scrollbar flex gap-2.5 overflow-x-auto snap-x snap-mandatory pb-1"
                  >
                    {relatedSuggestions.map((rec) => (
                      <button
                        key={rec.id}
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          onPlayTrack({ ...rec, autoQueued: false });
                        }}
                        className="kago-press-subtle group w-[calc((100%-20px)/3)] min-w-[110px] sm:min-w-[168px] shrink-0 snap-start overflow-hidden rounded-xl border border-[#222530] bg-[#0D0E12] text-left hover:border-[#E11D48] transition-colors cursor-pointer"
                      >
                        <div className="relative aspect-video w-full overflow-hidden bg-[#14161E]">
                          {rec.artworkUrl ? (
                            <img
                              src={rec.artworkUrl}
                              alt={rec.title}
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center">
                              <Disc3 className="h-6 w-6 text-[#E11D48]" />
                            </div>
                          )}
                          <div className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#E11D48] text-white shadow">
                              <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
                            </span>
                          </div>
                          <span className="absolute bottom-1 right-1 rounded bg-black/85 px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold text-[#F4F3F0]">
                            {formatDuration(rec.duration)}
                          </span>
                        </div>
                        <div className="p-2">
                          <p className="truncate text-xs font-semibold text-[#F4F3F0] group-hover:text-[#FF4D6D]">
                            {rec.title}
                          </p>
                          <p className="mt-0.5 truncate text-[11px] text-[#8E929B]">
                            {rec.artist}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] px-4 py-3 text-xs text-[#8E929B]">
                    {loadingWatchRelated || isFetchingRadio
                      ? 'Finding related videos for this track...'
                      : 'No related video suggestions yet.'}
                  </div>
                )}
              </div>

              {/* Shorter Spectrum Visualizer directly below Next Video Suggestions */}
              <SpectrumVisualizer isPlaying={isPlaying} dsp={dsp} height={52} />
            </div>
          )}

          {subTab === 'lyrics' && (
            <div className="kago-panel-enter space-y-4">
              {/* Sync Status & Calibration Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1F2129] bg-[#0D0E12] px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Mic2 className="h-4 w-4 shrink-0 text-[#E11D48]" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-[#F4F3F0]">Synced Lyrics</span>
                      {isFetchingLyrics && (
                        <span className="inline-flex items-center gap-1 font-mono-tabular text-[11px] text-[#FF4D6D]">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Fetching...</span>
                        </span>
                      )}
                    </div>
                    <p className="truncate font-mono-tabular text-[11px] text-[#8E929B]">
                      Tap any lyric line to jump playback
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {onFetchTrackLyrics && (
                    <button
                      type="button"
                      disabled={isFetchingLyrics}
                      onClick={() => {
                        triggerHaptic('light');
                        onFetchTrackLyrics(track);
                      }}
                      aria-label="Refresh synced lyrics"
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#2A2D39] bg-[#14161D] px-2.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw
                        className={`h-3 w-3 text-[#E11D48] ${isFetchingLyrics ? 'animate-spin' : ''}`}
                      />
                      <span>Sync</span>
                    </button>
                  )}

                  <button
                    type="button"
                    aria-label="Decrease lyric timing offset"
                    onClick={() => {
                      triggerHaptic('light');
                      onUpdateLyricsOffset(
                        track.id,
                        Math.max(-2, Number((offsetSeconds - 0.1).toFixed(1)))
                      );
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2A2D39] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="w-12 text-center font-mono-tabular text-xs font-bold text-[#FF4D6D]">
                    {offsetSeconds >= 0 ? `+${offsetSeconds.toFixed(1)}s` : `${offsetSeconds.toFixed(1)}s`}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase lyric timing offset"
                    onClick={() => {
                      triggerHaptic('light');
                      onUpdateLyricsOffset(
                        track.id,
                        Math.min(2, Number((offsetSeconds + 0.1).toFixed(1)))
                      );
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2A2D39] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      onUpdateLyricsOffset(track.id, 0);
                    }}
                    className="rounded-md border border-[#2A2D39] bg-[#14161D] px-2 py-1 font-mono-tabular text-xs text-[#8E929B] hover:text-white cursor-pointer"
                  >
                    0.0s
                  </button>
                </div>
              </div>

              {/* Spotify / Apple Music-Style Real-Time Synced Lyrics Stage */}
              {parsedLines.length > 0 ? (
                <div
                  data-testid="fullscreen-synced-lyrics-stage"
                  className="max-h-[46vh] overflow-y-auto rounded-2xl border border-[#1F2129] bg-[#0D0E12] px-3 py-8 sm:px-6 text-center space-y-2.5"
                >
                  {parsedLines.map((line, idx) => {
                    const isActive = idx === activeIdx;
                    const isPast = activeIdx >= 0 && idx < activeIdx;
                    return (
                      <button
                        key={`${line.time}-${idx}`}
                        ref={isActive ? activeLineRef : undefined}
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          onSeek(line.time);
                        }}
                        aria-current={isActive ? 'true' : undefined}
                        className={`block w-full rounded-xl px-4 py-2.5 transition-all duration-300 cursor-pointer ${
                          isActive
                            ? 'scale-[1.02] border border-[#E11D48]/40 bg-[#E11D48]/15 text-xl sm:text-2xl font-extrabold text-[#FF4D6D] shadow-[0_0_16px_rgba(225,29,72,0.28)]'
                            : isPast
                            ? 'text-sm sm:text-base font-medium text-[#6B7280] opacity-70 hover:opacity-100'
                            : 'text-base sm:text-lg font-semibold text-[#C7C9D1] hover:text-[#F4F3F0]'
                        }`}
                      >
                        {line.text}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-[#1F2129] bg-[#0D0E12] p-6 sm:p-8 text-center space-y-4">
                  {isFetchingLyrics ? (
                    <div className="flex flex-col items-center gap-2.5 py-4">
                      <Loader2 className="h-7 w-7 animate-spin text-[#E11D48]" />
                      <p className="text-sm font-semibold text-[#F4F3F0]">
                        Matching time-synced lyrics for &ldquo;{track.title}&rdquo;...
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-[#8E929B]">
                        No synced lyrics matched automatically yet. Search by song &amp; artist name or open the Sync Studio.
                      </p>
                      {onFetchTrackLyrics && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            onFetchTrackLyrics(track, lyricSearchQuery.trim() || undefined);
                          }}
                          className="mx-auto flex max-w-md flex-col sm:flex-row gap-2"
                        >
                          <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8E929B]" />
                            <input
                              type="text"
                              value={lyricSearchQuery}
                              onChange={(e) => setLyricSearchQuery(e.target.value)}
                              placeholder="Artist Song Title..."
                              aria-label="Search synced lyrics query"
                              className="w-full rounded-lg border border-[#262936] bg-[#07080B] py-2 pl-9 pr-3 text-xs text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none"
                            />
                          </div>
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                          >
                            <Search className="h-3.5 w-3.5" />
                            <span>Find Lyrics</span>
                          </button>
                        </form>
                      )}
                      {onOpenLyricsStudio && (
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onOpenLyricsStudio();
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A2D39] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                        >
                          <Mic2 className="h-3.5 w-3.5 text-[#E11D48]" />
                          <span>Open Sync Lyrics Studio</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {subTab === 'queue' && (
            <div className="kago-panel-enter space-y-2">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#1F2129] bg-[#0D0E12] px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#8E929B]">
                  <span className="font-semibold text-[#F4F3F0]">Active Playback Queue</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{queue.length} tracks</span>
                  {queue.length > 1 && onReorderQueue && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Drag or use arrows to reorder</span>
                    </>
                  )}
                  {isFetchingRadio && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular text-[#FF4D6D]">Finding related songs...</span>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={autoplayRadioEnabled}
                  onClick={() => {
                    triggerHaptic('light');
                    onToggleAutoplayRadio();
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                    autoplayRadioEnabled
                      ? 'border-[#E11D48] bg-[#E11D48]/15 text-[#FF4D6D]'
                      : 'border-[#252834] bg-[#14161D] text-[#8E929B] hover:text-white'
                  }`}
                >
                  <Radio className="h-3.5 w-3.5" />
                  <span>Auto Radio: {autoplayRadioEnabled ? 'ON' : 'OFF'}</span>
                </button>
              </div>
              {queue.length === 0 ? (
                <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-8 text-center text-sm text-[#8E929B]">
                  Queue is empty. Add songs from Stream or Library.
                </div>
              ) : (
                queue.map((qTrack, idx) => {
                  const active = qTrack.id === track.id;
                  const isDragging = dragIdx === idx;
                  const isDropTarget = dragOverIdx === idx && dragIdx !== null && dragIdx !== idx;
                  return (
                    <div
                      key={`${qTrack.id}-${idx}`}
                      data-queue-index={idx}
                      draggable={Boolean(onReorderQueue) && queue.length > 1}
                      onDragStart={(e) => {
                        if (!onReorderQueue) return;
                        triggerHaptic('reorder', 10);
                        setDragIdx(idx);
                        setDragOverIdx(idx);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(idx));
                      }}
                      onDragOver={(e) => {
                        if (!onReorderQueue || dragIdx === null) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragOverIdx !== idx) {
                          triggerHaptic('selection', 35);
                          setDragOverIdx(idx);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (onReorderQueue && dragIdx !== null && dragIdx !== idx) {
                          onReorderQueue(dragIdx, idx);
                        }
                        setDragIdx(null);
                        setDragOverIdx(null);
                      }}
                      onDragEnd={() => {
                        setDragIdx(null);
                        setDragOverIdx(null);
                      }}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 sm:px-3.5 py-2.5 transition-[transform,background-color,border-color,opacity] duration-150 ${
                        isDropTarget
                          ? 'scale-[1.01] border-[#E11D48] bg-[#E11D48]/20'
                          : active
                          ? 'border-[#E11D48] bg-[#E11D48]/10'
                          : 'border-[#1F2129] bg-[#0D0E12]'
                      } ${isDragging ? 'scale-[0.985] opacity-55' : ''}`}
                    >
                      {onReorderQueue && queue.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Drag to reorder ${qTrack.title}`}
                          title="Drag to reorder"
                          onPointerDown={(e) => {
                            if (e.pointerType === 'mouse') return;
                            e.preventDefault();
                            triggerHaptic('reorder', 10);
                            pointerDragFromRef.current = idx;
                            setDragIdx(idx);
                            setDragOverIdx(idx);
                            try {
                              e.currentTarget.setPointerCapture(e.pointerId);
                            } catch {
                              // Ignore pointer capture failure
                            }
                          }}
                          onPointerMove={(e) => {
                            if (pointerDragFromRef.current === null) return;
                            const hit = document
                              .elementFromPoint(e.clientX, e.clientY)
                              ?.closest('[data-queue-index]');
                            const rawIdx = hit?.getAttribute('data-queue-index');
                            if (rawIdx !== null && rawIdx !== undefined) {
                              const parsed = Number(rawIdx);
                              if (Number.isInteger(parsed) && parsed !== dragOverIdx) {
                                triggerHaptic('selection', 35);
                                setDragOverIdx(parsed);
                              }
                            }
                          }}
                          onPointerUp={() => {
                            const from = pointerDragFromRef.current;
                            const to = dragOverIdx;
                            pointerDragFromRef.current = null;
                            if (from !== null && to !== null && from !== to) {
                              onReorderQueue(from, to);
                            }
                            setDragIdx(null);
                            setDragOverIdx(null);
                          }}
                          onPointerCancel={() => {
                            pointerDragFromRef.current = null;
                            setDragIdx(null);
                            setDragOverIdx(null);
                          }}
                          className="touch-none flex h-8 w-6 shrink-0 items-center justify-center rounded text-[#8E929B] hover:text-white cursor-grab active:cursor-grabbing"
                        >
                          <GripVertical className="h-4 w-4" />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onPlayTrack(qTrack)}
                        className="kago-press-subtle flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer"
                      >
                        <span
                          className={`w-5 shrink-0 font-mono-tabular text-xs ${
                            active ? 'font-bold text-[#FF4D6D]' : 'text-[#8E929B]'
                          }`}
                        >
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p
                              className={`truncate text-sm font-semibold ${
                                active ? 'text-[#FF4D6D]' : 'text-[#F4F3F0]'
                              }`}
                            >
                              {qTrack.title}
                            </p>
                            {qTrack.autoQueued && !active && (
                              <span className="shrink-0 rounded border border-[#2C303E] bg-[#14161E] px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
                                Auto Radio
                              </span>
                            )}
                          </div>
                          <p className="truncate text-xs text-[#8E929B]">{qTrack.artist}</p>
                        </div>
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        <span className="hidden sm:inline mr-1 font-mono-tabular text-xs text-[#8E929B]">
                          {formatDuration(qTrack.duration)}
                        </span>
                        {onReorderQueue && queue.length > 1 && (
                          <>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => onReorderQueue(idx, idx - 1)}
                              aria-label={`Move ${qTrack.title} up`}
                              title="Move up"
                              className="flex h-8 w-7 items-center justify-center rounded text-[#8E929B] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                            >
                              <ChevronUp className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === queue.length - 1}
                              onClick={() => onReorderQueue(idx, idx + 1)}
                              aria-label={`Move ${qTrack.title} down`}
                              title="Move down"
                              className="flex h-8 w-7 items-center justify-center rounded text-[#8E929B] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('light');
                            onRemoveFromQueue(qTrack.id);
                          }}
                          aria-label={`Remove ${qTrack.title} from queue`}
                          className="flex h-8 w-8 items-center justify-center rounded text-[#8E929B] hover:text-[#FF4D6D] cursor-pointer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Transport Deck */}
      <div className="shrink-0 border-t border-[#1F2129] bg-[#08090D] px-3.5 py-3 sm:px-8 sm:py-4 pb-[max(0.85rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
                {track.title}
              </h2>
              <p className="truncate text-xs text-[#8E929B]">
                {track.artist} · {track.album}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('selection');
                onToggleFavorite(track.id);
              }}
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              className={`flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-lg border border-[#242732] bg-[#121319] transition-colors cursor-pointer ${
                isFavorite ? 'text-[#FF4D6D]' : 'text-[#8E929B] hover:text-white'
              }`}
            >
              <Heart className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} />
            </button>
          </div>

          {/* Seek Bar: Red for played portion, White for remaining */}
          <div className="mt-3 sm:mt-4">
            {(() => {
              const safeMax = Math.max(1, duration);
              const clampedPos = Math.min(Math.max(0, currentTime), safeMax);
              const progressPct = duration > 0 ? Math.min(100, Math.max(0, (clampedPos / safeMax) * 100)) : 0;
              return (
                <input
                  type="range"
                  min={0}
                  max={safeMax}
                  step={0.5}
                  value={clampedPos}
                  aria-label="Seek audio position"
                  onChange={(e) => onSeek(Number(e.target.value))}
                  style={{ '--slider-progress': `${progressPct}%` } as React.CSSProperties}
                  className="hardware-slider seek-progress-slider w-full"
                />
              );
            })()}
            <div className="mt-1 flex items-center justify-between font-mono-tabular text-xs text-[#8E929B]">
              <span>{formatDuration(currentTime)}</span>
              <span>{formatDuration(duration)}</span>
            </div>
          </div>

          {/* Touch-Friendly Transport Controls */}
          <div className="mt-2.5 sm:mt-3 flex items-center justify-center gap-2.5 min-[380px]:gap-4 sm:gap-6">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onSeekBy(-10);
              }}
              aria-label="Rewind 10 seconds"
              className="flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-full border border-[#242732] bg-[#121319] text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
            >
              <RotateCcw className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onPrev();
              }}
              aria-label="Previous track"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-[#242732] bg-[#121319] text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
            >
              <SkipBack className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('selection');
                onTogglePlay();
              }}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-[#E11D48] text-white shadow-[0_0_24px_rgba(225,29,72,0.65)] hover:bg-[#BE123C] transition-colors cursor-pointer"
            >
              {isPlaying ? (
                <Pause className="h-6 w-6 fill-current" />
              ) : (
                <Play className="h-6 w-6 fill-current ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onNext();
              }}
              aria-label="Next track"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-[#242732] bg-[#121319] text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
            >
              <SkipForward className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onSeekBy(10);
              }}
              aria-label="Forward 10 seconds"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-[#242732] bg-[#121319] text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
            >
              <RotateCw className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

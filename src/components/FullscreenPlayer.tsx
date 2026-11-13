import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Heart,
  Minus,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Sliders,
  Trash2,
} from 'lucide-react';
import type { DspSettings, StoredLyrics, Track } from '../types/audio';
import { findActiveLyricIndex, formatDuration, parseLrc } from '../utils/lrcParser';
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
  onToggleFavorite: (trackId: string) => void;
  onOpenDsp: () => void;
  onUpdateLyricsOffset: (trackId: string, offset: number) => void;
  onOpenStream: () => void;
  autoplayRadioEnabled: boolean;
  isFetchingRadio: boolean;
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
  onToggleFavorite,
  onOpenDsp,
  onUpdateLyricsOffset,
  onOpenStream,
  autoplayRadioEnabled,
  isFetchingRadio,
  onToggleAutoplayRadio,
}) => {
  const [subTab, setSubTab] = useState<FullscreenSubTab>('turntable');
  const activeLineRef = useRef<HTMLButtonElement | null>(null);

  const rawLrc = storedLyrics?.rawLrc ?? track?.lrcLyrics ?? '';
  const offsetSeconds = storedLyrics?.offsetSeconds ?? 0;
  const parsedLines = useMemo(() => parseLrc(rawLrc), [rawLrc]);
  const activeIdx = useMemo(
    () => findActiveLyricIndex(parsedLines, currentTime, offsetSeconds),
    [parsedLines, currentTime, offsetSeconds]
  );

  useEffect(() => {
    if (subTab === 'lyrics' && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIdx, subTab]);

  if (!isOpen || !track) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen Vinyl Turntable Player"
      className="fixed inset-0 z-50 flex flex-col bg-black text-[#F4F3F0] animate-[fadeIn_180ms_ease-out]"
    >
      {/* Top Bar */}
      <div className="flex items-center justify-between gap-2 sm:gap-4 border-b border-[#1A1C24] bg-[#06070A] px-3 py-3 sm:px-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Collapse fullscreen player"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#242732] bg-[#111319] text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
        >
          <ChevronDown className="h-5 w-5" />
        </button>

        {/* 4-Tab Switcher (Turntable | Watch Video | Sync Lyrics | Queue) */}
        <div
          role="tablist"
          aria-label="Fullscreen player views"
          className="flex items-center gap-1 overflow-x-auto rounded-lg border border-[#222530] bg-[#0D0E13] p-1"
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
                onClick={() => setSubTab(t.id)}
                className={`rounded-md px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
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
          onClick={onOpenDsp}
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
            <div className="space-y-6">
              <VinylTurntable
                track={track}
                isPlaying={isPlaying}
                onTogglePlay={onTogglePlay}
                size="lg"
              />
              <SpectrumVisualizer isPlaying={isPlaying} dsp={dsp} compact />
            </div>
          )}

          {subTab === 'video' && (
            <div className="space-y-5">
              <WatchVideoViewport
                track={track}
                isPlaying={isPlaying}
                currentTime={currentTime}
                zIndex={60}
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
              <SpectrumVisualizer isPlaying={isPlaying} dsp={dsp} compact />
            </div>
          )}

          {subTab === 'lyrics' && (
            <div className="space-y-5">
              {/* Calibration Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1F2129] bg-[#0D0E12] px-4 py-3">
                <span className="text-xs font-semibold text-[#C7C9D1]">
                  Timing Offset Calibration
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Decrease lyric timing offset"
                    onClick={() =>
                      onUpdateLyricsOffset(
                        track.id,
                        Math.max(-2, Number((offsetSeconds - 0.1).toFixed(1)))
                      )
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2A2D39] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="w-14 text-center font-mono-tabular text-xs font-bold text-[#FF4D6D]">
                    {offsetSeconds >= 0 ? `+${offsetSeconds.toFixed(1)}s` : `${offsetSeconds.toFixed(1)}s`}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase lyric timing offset"
                    onClick={() =>
                      onUpdateLyricsOffset(
                        track.id,
                        Math.min(2, Number((offsetSeconds + 0.1).toFixed(1)))
                      )
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2A2D39] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onUpdateLyricsOffset(track.id, 0)}
                    className="rounded-md border border-[#2A2D39] bg-[#14161D] px-2.5 py-1 font-mono-tabular text-xs text-[#8E929B] hover:text-white cursor-pointer"
                  >
                    0.0s
                  </button>
                </div>
              </div>

              {/* Scrollable Glowing Lyrics */}
              {parsedLines.length > 0 ? (
                <div className="space-y-3 py-6 text-center">
                  {parsedLines.map((line, idx) => {
                    const isActive = idx === activeIdx;
                    return (
                      <button
                        key={`${line.time}-${idx}`}
                        ref={isActive ? activeLineRef : undefined}
                        type="button"
                        onClick={() => onSeek(line.time)}
                        className={`block w-full rounded-lg px-4 py-2 transition-all cursor-pointer ${
                          isActive
                            ? 'scale-[1.03] text-xl sm:text-2xl font-bold text-[#FF3B5C] drop-shadow-[0_0_14px_rgba(225,29,72,0.75)]'
                            : 'text-base sm:text-lg text-[#737885] hover:text-[#D1D5DB]'
                        }`}
                      >
                        {line.text}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-10 text-center">
                  <p className="text-sm text-[#8E929B]">
                    No synced LRC lyrics saved for this track yet. Open the Sync Lyrics screen to import or author timestamps.
                  </p>
                </div>
              )}
            </div>
          )}

          {subTab === 'queue' && (
            <div className="space-y-2">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#1F2129] bg-[#0D0E12] px-3.5 py-2.5">
                <div className="flex items-center gap-2 text-xs text-[#8E929B]">
                  <span className="font-semibold text-[#F4F3F0]">Active Playback Queue</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{queue.length} tracks</span>
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
                  onClick={onToggleAutoplayRadio}
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
                  return (
                    <div
                      key={`${qTrack.id}-${idx}`}
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 ${
                        active
                          ? 'border-[#E11D48] bg-[#E11D48]/10'
                          : 'border-[#1F2129] bg-[#0D0E12]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onPlayTrack(qTrack)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer"
                      >
                        <span
                          className={`w-6 font-mono-tabular text-xs ${
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

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono-tabular text-xs text-[#8E929B]">
                          {formatDuration(qTrack.duration)}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemoveFromQueue(qTrack.id)}
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
      <div className="border-t border-[#1F2129] bg-[#08090D] px-4 py-4 sm:px-8 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-display text-lg font-bold text-[#F4F3F0]">
                {track.title}
              </h2>
              <p className="truncate text-xs text-[#8E929B]">
                {track.artist} · {track.album}
              </p>
            </div>

            <button
              type="button"
              onClick={() => onToggleFavorite(track.id)}
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              className={`flex h-11 w-11 items-center justify-center rounded-lg border border-[#242732] bg-[#121319] transition-colors cursor-pointer ${
                isFavorite ? 'text-[#FF4D6D]' : 'text-[#8E929B] hover:text-white'
              }`}
            >
              <Heart className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} />
            </button>
          </div>

          {/* Seek Bar */}
          <div className="mt-4">
            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={0.5}
              value={Math.min(currentTime, duration || 1)}
              aria-label="Seek audio position"
              onChange={(e) => onSeek(Number(e.target.value))}
              className="hardware-slider w-full"
            />
            <div className="mt-1.5 flex items-center justify-between font-mono-tabular text-xs text-[#8E929B]">
              <span>{formatDuration(currentTime)}</span>
              <span>{formatDuration(duration)}</span>
            </div>
          </div>

          {/* Touch-Friendly Transport Controls */}
          <div className="mt-3 flex items-center justify-center gap-3 sm:gap-6">
            <button
              type="button"
              onClick={() => onSeekBy(-10)}
              aria-label="Rewind 10 seconds"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-[#242732] bg-[#121319] text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
            >
              <RotateCcw className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous track"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-[#242732] bg-[#121319] text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
            >
              <SkipBack className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={onTogglePlay}
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
              onClick={onNext}
              aria-label="Next track"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-[#242732] bg-[#121319] text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
            >
              <SkipForward className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={() => onSeekBy(10)}
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

import React from 'react';
import {
  AudioWaveform,
  ChevronUp,
  Heart,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
} from 'lucide-react';
import type { Track } from '../types/audio';
import { formatDuration } from '../utils/lrcParser';

interface MiniPlayerProps {
  track: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isFavorite: boolean;
  onTogglePlay: () => void;
  onSeekBy: (seconds: number) => void;
  onNext: () => void;
  onToggleFavorite: (trackId: string) => void;
  onExpand: () => void;
}

export const MiniPlayer: React.FC<MiniPlayerProps> = ({
  track,
  isPlaying,
  currentTime,
  duration,
  isFavorite,
  onTogglePlay,
  onSeekBy,
  onNext,
  onToggleFavorite,
  onExpand,
}) => {
  if (!track) return null;

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      data-testid="floating-mini-player"
      className="fixed inset-x-2.5 sm:inset-x-3 bottom-[calc(58px+env(safe-area-inset-bottom))] md:bottom-4 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-full md:max-w-4xl z-30 overflow-hidden rounded-xl border border-[#262936] bg-[#0C0D12]/95 backdrop-blur-md shadow-[0_16px_48px_rgba(0,0,0,0.8)]"
    >
      {/* Top Crimson (played) / White (unplayed) Progress Line */}
      <div className="h-0.5 w-full bg-white/85">
        <div
          className="h-full bg-[#E11D48] shadow-[0_0_8px_#E11D48] transition-[width] duration-150"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 sm:gap-3 px-2.5 py-2 sm:px-4 sm:py-2.5">
        {/* Track Info Trigger -> Opens Fullscreen Player */}
        <button
          type="button"
          onClick={onExpand}
          aria-label={`Expand fullscreen player for ${track.title}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer group"
        >
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#262936] bg-[#14161F]">
            {track.artworkUrl ? (
              <img
                src={track.artworkUrl}
                alt={track.title}
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            ) : (
              <AudioWaveform
                className={`h-5 w-5 text-[#E11D48] ${isPlaying ? 'animate-pulse' : ''}`}
              />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-[#F4F3F0] group-hover:text-white">
                {track.title}
              </span>
              {track.source === 'synth' && (
                <span className="shrink-0 rounded border border-[#E11D48]/50 bg-[#E11D48]/15 px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wide text-[#FF4D6D]">
                  Synth
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-[#8E929B]">
              <span className="truncate">{track.artist}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 font-mono-tabular">
                {formatDuration(currentTime)} / {formatDuration(duration)}
              </span>
            </div>
          </div>
        </button>

        {/* Transport Controls */}
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onToggleFavorite(track.id)}
            aria-label={isFavorite ? `Remove ${track.title} from favorites` : `Favorite ${track.title}`}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors cursor-pointer ${
              isFavorite ? 'text-[#FF4D6D]' : 'text-[#8E929B] hover:text-white'
            }`}
          >
            <Heart className={`h-4 w-4 ${isFavorite ? 'fill-current' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => onSeekBy(-10)}
            aria-label="Rewind 10 seconds"
            title="Rewind 10s"
            className="hidden sm:flex h-9 w-9 items-center justify-center rounded-lg text-[#B4B7C2] hover:bg-[#191B24] hover:text-white transition-colors cursor-pointer"
          >
            <RotateCcw className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause playback' : 'Play track'}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E11D48] text-white shadow-[0_0_16px_rgba(225,29,72,0.55)] hover:bg-[#BE123C] transition-colors cursor-pointer"
          >
            {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current ml-0.5" />}
          </button>

          <button
            type="button"
            onClick={() => onSeekBy(10)}
            aria-label="Forward 10 seconds"
            title="Forward 10s"
            className="hidden sm:flex h-9 w-9 items-center justify-center rounded-lg text-[#B4B7C2] hover:bg-[#191B24] hover:text-white transition-colors cursor-pointer"
          >
            <RotateCw className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onNext}
            aria-label="Skip to next track"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#B4B7C2] hover:bg-[#191B24] hover:text-white transition-colors cursor-pointer"
          >
            <SkipForward className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onExpand}
            aria-label="Open fullscreen player"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#8E929B] hover:bg-[#191B24] hover:text-white transition-colors cursor-pointer"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

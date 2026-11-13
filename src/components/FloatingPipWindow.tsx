import React, { useEffect, useRef } from 'react';
import { Maximize2, Pause, Play, X } from 'lucide-react';
import { audioEngine } from '../audio/AudioEngine';
import type { Track } from '../types/audio';

interface FloatingPipWindowProps {
  isOpen: boolean;
  track: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onExpand: () => void;
  onClose: () => void;
}

export const FloatingPipWindow: React.FC<FloatingPipWindowProps> = ({
  isOpen,
  track,
  isPlaying,
  onTogglePlay,
  onExpand,
  onClose,
}) => {
  const videoSlotRef = useRef<HTMLDivElement | null>(null);
  const hasYouTube = Boolean(track?.youtubeId);

  useEffect(() => {
    if (!isOpen || !hasYouTube) return;
    const el = videoSlotRef.current;
    if (!el) return;
    const detach = audioEngine.attachYouTubeViewport(el, 65);
    return () => {
      detach();
    };
  }, [isOpen, hasYouTube, track?.youtubeId]);

  if (!isOpen || !track || !hasYouTube) return null;

  return (
    <aside
      aria-label="Floating Picture-in-Picture Video Player"
      className="fixed bottom-36 right-3 sm:bottom-24 sm:right-6 z-[64] w-72 sm:w-80 overflow-hidden rounded-xl border border-[#2D313F] bg-[#0B0C10] shadow-[0_18px_48px_rgba(0,0,0,0.9)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[#1E2028] bg-[#101218] px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-[#F4F3F0]">{track.title}</p>
          <p className="truncate text-[10px] text-[#8E929B]">{track.artist}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause floating video' : 'Play floating video'}
            className="flex h-7 w-7 items-center justify-center rounded border border-[#262936] bg-[#161821] text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand video to fullscreen player"
            className="flex h-7 w-7 items-center justify-center rounded border border-[#262936] bg-[#161821] text-[#8E929B] hover:border-[#E11D48] hover:text-white cursor-pointer"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close floating Picture-in-Picture"
            className="flex h-7 w-7 items-center justify-center rounded border border-[#262936] bg-[#161821] text-[#8E929B] hover:border-[#E11D48] hover:text-[#FF4D6D] cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div ref={videoSlotRef} className="aspect-video w-full bg-black" />
    </aside>
  );
};

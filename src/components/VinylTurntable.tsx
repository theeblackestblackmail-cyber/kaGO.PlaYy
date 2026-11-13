import React, { useState } from 'react';
import { Disc3 } from 'lucide-react';
import type { Track } from '../types/audio';

interface VinylTurntableProps {
  track: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  size?: 'md' | 'lg';
}

export const VinylTurntable: React.FC<VinylTurntableProps> = ({
  track,
  isPlaying,
  onTogglePlay,
  size = 'md',
}) => {
  const [rpm, setRpm] = useState<'33' | '45'>('33');
  const platterSize = size === 'lg' ? 'h-64 w-64 sm:h-76 sm:w-76' : 'h-56 w-56 sm:h-64 sm:w-64';

  return (
    <div className="flex flex-col items-center">
      <div className="mb-4 flex w-full items-center justify-between">
        <div>
          <h3 className="font-display text-base font-bold text-[#F4F3F0]">
            Pro-Direct Drive Turntable
          </h3>
          <p className="text-xs text-[#8E929B]">
            Click platter to {isPlaying ? 'pause' : 'start'} motor
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRpm((prev) => (prev === '33' ? '45' : '33'))}
          className="rounded-md border border-[#2A2D39] bg-[#14161D] px-3 py-1.5 font-mono-tabular text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
        >
          {rpm} RPM
        </button>
      </div>

      {/* Turntable Plinth Stage */}
      <div className="relative flex w-full items-center justify-center rounded-xl border border-[#1E2028] bg-[#07080B] py-6 px-4">
        {/* Spinning Vinyl Platter Button */}
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={isPlaying ? 'Pause turntable platter' : 'Play turntable platter'}
          className={`relative ${platterSize} rounded-full border-2 border-[#252834] bg-[#0B0C10] shadow-[0_12px_40px_rgba(0,0,0,0.85)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]`}
        >
          {/* Rotating Vinyl Disc */}
          <div
            className={`absolute inset-1.5 rounded-full ${
              rpm === '33' ? 'vinyl-spinning-33' : 'vinyl-spinning-45'
            } ${isPlaying ? '' : 'vinyl-paused'}`}
            style={{
              background:
                'repeating-radial-gradient(circle at center, #0c0d11 0px, #0c0d11 2px, #171921 3px, #0d0e13 4px)',
            }}
          >
            {/* Subtle specular sweep */}
            <div
              className="pointer-events-none absolute inset-0 rounded-full opacity-25"
              style={{
                background:
                  'conic-gradient(from 35deg, transparent 0deg, rgba(255,255,255,0.22) 35deg, transparent 80deg, transparent 180deg, rgba(255,255,255,0.18) 215deg, transparent 265deg)',
              }}
            />

            {/* Center Label */}
            <div className="absolute inset-0 m-auto flex h-[38%] w-[38%] items-center justify-center overflow-hidden rounded-full border-2 border-[#E11D48]/80 bg-[#14161E] shadow-inner">
              {track?.artworkUrl ? (
                <img
                  src={track.artworkUrl}
                  alt={track.title}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex flex-col items-center justify-center px-2 text-center">
                  <Disc3 className="h-5 w-5 text-[#E11D48]" />
                  <span className="mt-1 line-clamp-2 text-[9px] font-bold text-[#F4F3F0]">
                    {track?.title || 'kaGO.PIaY'}
                  </span>
                </div>
              )}
              {/* Center Spindle Hole */}
              <div className="absolute h-3 w-3 rounded-full border border-[#323646] bg-[#050507]" />
            </div>
          </div>
        </button>

        {/* Metallic Tonearm with Glowing Crimson Stylus */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-4 sm:right-8 sm:top-5 origin-[22px_22px] transition-transform duration-500 ease-out"
          style={{
            transform: isPlaying ? 'rotate(24deg)' : 'rotate(-6deg)',
          }}
        >
          {/* Pivot Gimbal Base */}
          <div className="relative h-11 w-11 rounded-full border border-[#3B3F4E] bg-[#1A1C24] shadow-md">
            <div className="absolute inset-2 rounded-full border border-[#52576B] bg-[#282B36]" />
            {/* Metallic Arm Tube */}
            <div
              className="absolute left-[19px] top-[22px] h-32 sm:h-36 w-1.5 rounded-full bg-gradient-to-b from-[#9CA3AF] via-[#D1D5DB] to-[#6B7280] shadow-md"
              style={{ transform: 'rotate(8deg)', transformOrigin: 'top center' }}
            >
              {/* Headshell + Stylus */}
              <div className="absolute -bottom-3 -left-1.5 h-6 w-4 rounded-sm border border-[#4B5563] bg-[#181A22]">
                <div
                  className={`mx-auto mt-3.5 h-2 w-2 rounded-full transition-all ${
                    isPlaying
                      ? 'bg-[#FF2E54] shadow-[0_0_10px_#FF2E54,0_0_18px_#E11D48]'
                      : 'bg-[#6B7280]'
                  }`}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

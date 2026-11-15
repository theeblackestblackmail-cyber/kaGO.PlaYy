import React from 'react';
import { Sliders, WifiOff } from 'lucide-react';
import type { ActiveTab } from '../types/audio';
import { triggerHaptic } from '../utils/haptics';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenDsp: () => void;
  isOnline: boolean;
  isPlaying: boolean;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'stream', label: 'Stream' },
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
  { id: 'search', label: 'Search' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenDsp,
  isOnline,
  isPlaying,
}) => {
  return (
    <div className="sticky top-0 z-40 bg-black/85 backdrop-blur-md pt-[env(safe-area-inset-top)]">
      {!isOnline && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 border-b border-[#E11D48]/30 bg-[#1A080D] px-3 py-1.5 text-center text-xs font-medium text-[#FDA4AF]"
        >
          <WifiOff className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />
          <span className="truncate">Offline Mode — Local Audio Engine &amp; Built-In Stems Active</span>
        </div>
      )}

      <header className="border-b border-[#1F2129]">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-3 sm:gap-4 px-3.5 sm:px-6 lg:px-8">
          {/* Left: Brand Logo */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onSelectTab('dashboard');
            }}
            className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 cursor-pointer group"
            aria-label="kaGO.PIaY Dashboard"
          >
            <span
              className={`h-2.5 w-2.5 rounded-full bg-[#E11D48] transition-shadow ${
                isPlaying
                  ? 'shadow-[0_0_12px_#E11D48,0_0_24px_rgba(225,29,72,0.8)]'
                  : 'shadow-[0_0_8px_rgba(225,29,72,0.65)]'
              }`}
            />
            <span className="font-display text-lg font-extrabold tracking-tight text-[#F4F3F0] group-hover:text-white">
              kaGO.PIaY
            </span>
          </button>

          {/* Center: 5 Single-Line Desktop Tabs */}
          <nav aria-label="Main navigation" className="hidden md:flex items-center gap-6">
            {NAV_ITEMS.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    onSelectTab(item.id);
                  }}
                  className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active ? 'text-[#FF4D6D]' : 'text-[#8E929B] hover:text-[#F4F3F0]'
                  }`}
                >
                  {item.label}
                  <span
                    className={`absolute inset-x-0 bottom-0 h-0.5 bg-[#E11D48] shadow-[0_0_10px_rgba(225,29,72,0.8)] transition-transform duration-200 origin-center ${
                      active ? 'scale-x-100 opacity-100' : 'scale-x-0 opacity-0'
                    }`}
                  />
                </button>
              );
            })}
          </nav>

          {/* Right: Equalizer Button */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onOpenDsp();
              }}
              aria-label="Open Hardware DSP Studio"
              title="Hardware DSP Studio"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#282B36] bg-[#121318] text-[#F4F3F0] hover:border-[#E11D48] hover:text-[#FF4D6D] transition-colors cursor-pointer"
            >
              <Sliders className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
    </div>
  );
};

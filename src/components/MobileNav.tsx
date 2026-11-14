import React from 'react';
import { LayoutDashboard, Library, Radio, Search, Settings } from 'lucide-react';
import type { ActiveTab } from '../types/audio';

interface MobileNavProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
}

const MOBILE_ITEMS: Array<{
  id: ActiveTab;
  label: string;
  Icon: React.FC<{ className?: string }>;
}> = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'stream', label: 'Stream', Icon: Radio },
  { id: 'library', label: 'Library', Icon: Library },
  { id: 'settings', label: 'Settings', Icon: Settings },
  { id: 'search', label: 'Search', Icon: Search },
];

export const MobileNav: React.FC<MobileNavProps> = ({ activeTab, onSelectTab }) => {
  const handleTap = (tab: ActiveTab) => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(12);
      } catch {
        // Ignore if vibration blocked
      }
    }
    onSelectTab(tab);
  };

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[#1F2129] bg-[#08090C]/95 backdrop-blur-md md:hidden pb-[env(safe-area-inset-bottom)]"
    >
      {MOBILE_ITEMS.map(({ id, label, Icon }) => {
        const active = activeTab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => handleTap(id)}
            className={`flex min-h-[52px] flex-col items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
              active ? 'text-[#FF4D6D]' : 'text-[#8E929B] hover:text-[#F4F3F0]'
            }`}
          >
            <Icon className={`h-5 w-5 ${active ? 'text-[#E11D48]' : ''}`} />
            <span className="truncate max-w-full">{label}</span>
          </button>
        );
      })}
    </nav>
  );
};

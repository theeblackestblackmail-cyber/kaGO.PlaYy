import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  Disc3,
  FolderOpen,
  ListPlus,
  Loader2,
  Music,
  Pause,
  Play,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { CURATED_STREAM_BANK } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type { AudioEngineSnapshot, Track } from '../types/audio';
import { formatDuration } from '../utils/lrcParser';
import { triggerHaptic } from '../utils/haptics';
import { pushRecentSearch } from '../utils/streamFilter';
import { fetchMusicSuggestions, searchStreamsUnified } from '../utils/streamSearch';

interface SearchViewProps {
  libraryTracks: Track[];
  engine: AudioEngineSnapshot;
  onPlayTrack: (track: Track) => void;
  onTogglePlay: () => void;
  onAddToQueue: (track: Track) => void;
  onSaveTrackToLibrary: (track: Track) => void;
  onPickSong: () => void;
  onPickFolder: () => void;
}

const POPULAR_SEARCHES = [
  'Drake Hotline Bling',
  'Burna Boy Last Last',
  'The Weeknd Blinding Lights',
  'Kendrick Lamar Not Like Us',
  'Tyla Water',
];

export const SearchView: React.FC<SearchViewProps> = ({
  libraryTracks,
  engine,
  onPlayTrack,
  onTogglePlay,
  onAddToQueue,
  onSaveTrackToLibrary,
  onPickSong,
  onPickFolder,
}) => {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    localDb.loadRecentSearches()
  );
  const [streamResults, setStreamResults] = useState<Track[]>(CURATED_STREAM_BANK);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearchedOnline, setHasSearchedOnline] = useState(false);

  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localDb.saveRecentSearches(recentSearches);
  }, [recentSearches]);

  useEffect(() => {
    const onDocClick = (ev: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(ev.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Live YouTube autocomplete suggestions
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const next = await fetchMusicSuggestions(trimmed);
      if (!cancelled) {
        setSuggestions(next);
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Instant local library filter
  const localMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return libraryTracks.slice(0, 6);
    return libraryTracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q) ||
        (t.folderPath || '').toLowerCase().includes(q)
    );
  }, [libraryTracks, query]);

  const executeOnlineSearch = async (searchText: string) => {
    const cleanQ = searchText.trim();
    setShowSuggestions(false);
    if (!cleanQ) return;

    setRecentSearches((prev) => pushRecentSearch(prev, cleanQ));

    setIsSearching(true);
    setHasSearchedOnline(true);

    try {
      const { tracks: liveSongs } = await searchStreamsUnified({
        query: cleanQ,
        category: 'all',
      });
      setStreamResults(liveSongs.length > 0 ? liveSongs : CURATED_STREAM_BANK);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Unified Search Header */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#F4F3F0]">Search Music</h1>
            <p className="mt-1 text-xs text-[#8E929B]">
              Find songs across your offline library and full-length YouTube streams
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onPickSong}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
            >
              <Music className="h-3.5 w-3.5 text-[#E11D48]" />
              <span>Pick Song</span>
            </button>
            <button
              type="button"
              onClick={onPickFolder}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
            >
              <FolderOpen className="h-3.5 w-3.5 text-[#E11D48]" />
              <span>Pick Folder</span>
            </button>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void executeOnlineSearch(query);
          }}
          className="mt-4 flex flex-col sm:flex-row gap-2.5"
        >
          <div ref={searchBoxRef} className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8E929B]" />
            <input
              type="text"
              value={query}
              onFocus={() => setShowSuggestions(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowSuggestions(true);
              }}
              placeholder="Search local songs, artists, or YouTube..."
              aria-label="Search library and YouTube music"
              className="w-full rounded-lg border border-[#262936] bg-[#07080B] py-2.5 pl-10 pr-4 text-sm text-[#F4F3F0] placeholder-[#6B7280] focus:border-[#E11D48] focus:outline-none"
            />

            {showSuggestions && suggestions.length > 0 && (
              <div
                role="listbox"
                aria-label="Search suggestions"
                className="kago-panel-enter absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-lg border border-[#282B36] bg-[#101219] shadow-2xl"
              >
                {suggestions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      triggerHaptic('selection');
                      setQuery(item);
                      void executeOnlineSearch(item);
                    }}
                    className="kago-press-subtle flex w-full items-center gap-2.5 border-b border-[#1A1C24] px-3.5 py-2.5 text-left text-xs text-[#E5E7EB] last:border-b-0 hover:bg-[#1A1D27] hover:text-white cursor-pointer"
                  >
                    <Search className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />
                    <span className="truncate">{item}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={isSearching}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#E11D48] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_16px_rgba(225,29,72,0.4)] hover:bg-[#BE123C] disabled:opacity-60 transition-colors whitespace-nowrap cursor-pointer"
          >
            {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            <span>Search</span>
          </button>
        </form>

        {/* Popular Picks */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-[#8E929B]">
            <Sparkles className="h-3 w-3 text-[#E11D48]" />
            Popular:
          </span>
          {POPULAR_SEARCHES.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setQuery(term);
                void executeOnlineSearch(term);
              }}
              className="rounded-md border border-[#252834] bg-[#14161D] px-2.5 py-1 text-xs text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
            >
              {term}
            </button>
          ))}
        </div>

        {/* Recent Searches */}
        {recentSearches.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[#8E929B]">Recent:</span>
            {recentSearches.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setQuery(term);
                  void executeOnlineSearch(term);
                }}
                className="rounded-md border border-[#252834] bg-[#14161D] px-2.5 py-1 text-xs text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
              >
                {term}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setRecentSearches([]);
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[#8E929B] hover:text-[#FF4D6D] cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
              <span>Clear</span>
            </button>
          </div>
        )}
      </section>

      {/* Matching Offline Library Songs */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
            {query.trim() ? 'Matching Local Songs' : 'From Your Offline Library'}
          </h2>
          <span className="font-mono-tabular text-xs text-[#8E929B]">
            {localMatches.length} {localMatches.length === 1 ? 'track' : 'tracks'}
          </span>
        </div>

        {localMatches.length === 0 ? (
          <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5 text-center text-xs text-[#8E929B]">
            No local tracks matched &ldquo;{query}&rdquo;. Search online streams below.
          </div>
        ) : (
          <div className="divide-y divide-[#1A1C24] rounded-xl border border-[#1F2129] bg-[#0D0E12] overflow-hidden">
            {localMatches.map((track) => {
              const isCurrent = engine.currentTrack?.id === track.id;
              const isTrackPlaying = isCurrent && engine.isPlaying;
              return (
                <div
                  key={track.id}
                  className={`flex items-center justify-between gap-3 px-4 py-3 ${
                    isCurrent ? 'bg-[#17090E]' : 'hover:bg-[#13151C]'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('selection');
                        if (isCurrent) onTogglePlay();
                        else onPlayTrack(track);
                      }}
                      aria-label={isTrackPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border cursor-pointer ${
                        isCurrent
                          ? 'border-[#E11D48] bg-[#E11D48] text-white'
                          : 'border-[#252834] bg-[#15171E] text-[#F4F3F0] hover:border-[#E11D48]'
                      }`}
                    >
                      {isTrackPlaying ? (
                        <Pause className="h-4 w-4 fill-current" />
                      ) : (
                        <Play className="h-4 w-4 fill-current ml-0.5" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#F4F3F0]">{track.title}</p>
                      <p className="truncate text-xs text-[#8E929B]">
                        {track.artist} · {track.album}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono-tabular text-xs text-[#8E929B]">
                      {formatDuration(track.duration)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('selection');
                        onAddToQueue(track);
                      }}
                      aria-label={`Queue ${track.title}`}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[#8E929B] hover:bg-[#1C1E27] hover:text-white cursor-pointer"
                    >
                      <ListPlus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Online YouTube & Stream Results */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
            {hasSearchedOnline ? 'YouTube & Stream Matches' : 'Recommended Streams'}
          </h2>
          <span className="font-mono-tabular text-xs text-[#8E929B]">
            {streamResults.length} results
          </span>
        </div>

        <div className="kago-panel-enter grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {streamResults.map((track) => {
            const isCurrent = engine.currentTrack?.id === track.id;
            const isTrackPlaying = isCurrent && engine.isPlaying;
            return (
              <article
                key={track.id}
                className={`flex flex-col justify-between rounded-xl border p-4 transition-colors ${
                  isCurrent
                    ? 'border-[#E11D48] bg-[#13090E]'
                    : 'border-[#1F2129] bg-[#0D0E12] hover:border-[#303444]'
                }`}
              >
                <div>
                  <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-[#222530] bg-[#14161E]">
                    {track.artworkUrl ? (
                      <img
                        src={track.artworkUrl}
                        alt={track.title}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Disc3 className="h-9 w-9 text-[#E11D48]" />
                      </div>
                    )}
                    <span className="absolute bottom-2 right-2 rounded border border-[#2B2E3A] bg-black/85 px-2 py-0.5 font-mono-tabular text-xs font-semibold text-[#F4F3F0]">
                      {formatDuration(track.duration)}
                    </span>
                  </div>

                  <div className="mt-3">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate font-display text-sm sm:text-base font-bold text-[#F4F3F0]">
                        {track.title}
                      </h3>
                      {track.isOfficial && (
                        <BadgeCheck className="h-4 w-4 shrink-0 text-[#E11D48]" />
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[#8E929B]">{track.artist}</p>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-[#1A1C24] pt-3">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('selection');
                      onAddToQueue(track);
                      onSaveTrackToLibrary(track);
                    }}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer"
                  >
                    <ListPlus className="h-3.5 w-3.5" />
                    <span>Queue</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('selection');
                      if (isCurrent) onTogglePlay();
                      else onPlayTrack(track);
                    }}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                  >
                    {isTrackPlaying ? (
                      <>
                        <Pause className="h-3.5 w-3.5 fill-current" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span>Play</span>
                      </>
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};

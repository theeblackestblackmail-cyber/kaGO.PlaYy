import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  CheckCircle2,
  Disc3,
  Download,
  FolderOpen,
  ListPlus,
  ListStart,
  Loader2,
  Music,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { CURATED_STREAM_BANK } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type { AudioEngineSnapshot, Track } from '../types/audio';
import { formatDuration } from '../utils/lrcParser';
import { triggerHaptic } from '../utils/haptics';
import {
  analyzeTrackContentProfile,
  nextDiscoveryVisitSeed,
  pickContentBasedPopularSearches,
  rankContentBasedCandidates,
  readDiscoveryHistory,
  readDiscoveryText,
  readSessionSeenSongKeys,
  rotateCuratedFallbackTracks,
  writeDiscoveryHistory,
  writeDiscoveryText,
} from '../utils/streamDiscovery';
import { pushRecentSearch } from '../utils/streamFilter';
import { isStreamDownloadableTrack } from '../utils/streamDownloads';
import {
  fetchDiverseDiscoveryFeed,
  fetchMusicSuggestions,
  searchStreamsUnified,
} from '../utils/streamSearch';

interface SearchViewProps {
  libraryTracks: Track[];
  downloadedTrackIds?: Set<string>;
  engine: AudioEngineSnapshot;
  externalSearch?: { query: string; nonce: number } | null;
  onPlayTrack: (track: Track) => void;
  onTogglePlay: () => void;
  onPlayNext?: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onSaveTrackToLibrary: (track: Track) => void;
  onPickSong: () => void;
  onPickFolder: () => void;
  onRequestDownloadTrack?: (track: Track) => void;
}

const SEARCH_POPULAR_STORAGE_KEY = 'kago_search_last_popular';
const SEARCH_FEED_STORAGE_KEY = 'kago_search_last_feed_query';
const SEARCH_SEEDS_STORAGE_KEY = 'kago_search_last_seeds';
const SEARCH_SESSION_SEEN_KEY = 'kago_search_session_seen';

export const SearchView: React.FC<SearchViewProps> = ({
  libraryTracks,
  downloadedTrackIds,
  engine,
  externalSearch,
  onPlayTrack,
  onTogglePlay,
  onPlayNext,
  onAddToQueue,
  onSaveTrackToLibrary,
  onPickSong,
  onPickFolder,
  onRequestDownloadTrack,
}) => {
  const [visitSeed] = useState<number>(() => nextDiscoveryVisitSeed('kago_search_visit_seed'));
  const currentContentProfile = useMemo(
    () => analyzeTrackContentProfile(engine.currentTrack),
    [engine.currentTrack]
  );

  const [popularSearches, setPopularSearches] = useState<string[]>(() => {
    const prev = readDiscoveryHistory(SEARCH_POPULAR_STORAGE_KEY);
    const initialProfile = analyzeTrackContentProfile(engine.currentTrack);
    const next = pickContentBasedPopularSearches(
      5,
      visitSeed,
      ['Drake Hotline Bling', ...prev],
      initialProfile
    );
    writeDiscoveryHistory(SEARCH_POPULAR_STORAGE_KEY, next);
    return next;
  });

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    localDb.loadRecentSearches()
  );
  const [streamResults, setStreamResults] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(true);
  const [hasSearchedOnline, setHasSearchedOnline] = useState(false);

  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const searchRequestIdRef = useRef(0);
  const streamResultsRef = useRef<Track[]>([]);
  streamResultsRef.current = streamResults;
  const loadedAnchorTrackIdRef = useRef<string | null | undefined>(undefined);
  const currentTrackRef = useRef<Track | null>(engine.currentTrack);
  currentTrackRef.current = engine.currentTrack;

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

  const loadDiverseRecommendations = useCallback(
    async (seed: number, anchorTrack: Track | null = currentTrackRef.current) => {
      const reqId = ++searchRequestIdRef.current;
      loadedAnchorTrackIdRef.current = anchorTrack?.id ?? null;
      setIsSearching(true);

      const fallbackForAnchor = () => {
        const profile = analyzeTrackContentProfile(anchorTrack);
        const seenKeys = readSessionSeenSongKeys(SEARCH_SESSION_SEEN_KEY);
        const rankedFallback = rankContentBasedCandidates(CURATED_STREAM_BANK, profile, {
          seenSongKeys: seenKeys,
          visitSeed: seed,
          maxResults: 9,
        });
        return rankedFallback.length > 0
          ? rankedFallback
          : rotateCuratedFallbackTracks(CURATED_STREAM_BANK, seed);
      };

      try {
        const prevFeedQuery = readDiscoveryText(SEARCH_FEED_STORAGE_KEY);
        const prevSeeds = readDiscoveryHistory(SEARCH_SEEDS_STORAGE_KEY);
        const feed = await fetchDiverseDiscoveryFeed({
          visitSeed: seed,
          currentTrack: anchorTrack,
          previousSeeds: prevSeeds,
          previousFeedQuery: prevFeedQuery,
          targetCount: 12,
          sessionSeenStorageKey: SEARCH_SESSION_SEEN_KEY,
        });
        if (searchRequestIdRef.current !== reqId) return;
        if (feed.usedFeedQuery) {
          writeDiscoveryText(SEARCH_FEED_STORAGE_KEY, feed.usedFeedQuery);
        }
        if (feed.usedSeeds.length > 0) {
          writeDiscoveryHistory(SEARCH_SEEDS_STORAGE_KEY, feed.usedSeeds);
        }
        setStreamResults(feed.tracks.length > 0 ? feed.tracks : fallbackForAnchor());
      } catch {
        if (searchRequestIdRef.current !== reqId) return;
        setStreamResults(fallbackForAnchor());
      } finally {
        if (searchRequestIdRef.current === reqId) {
          setIsSearching(false);
        }
      }
    },
    []
  );

  // Load content-based recommendations on mount and when playback switches externally
  useEffect(() => {
    const activeId = engine.currentTrack?.id ?? null;
    if (loadedAnchorTrackIdRef.current === activeId) return;
    if (query.trim() || hasSearchedOnline) return;

    // Avoid shuffling cards out from under the user's finger when they tap Play inside this grid
    const playedFromGrid =
      activeId !== null && streamResultsRef.current.some((t) => t.id === activeId);
    if (loadedAnchorTrackIdRef.current !== undefined && playedFromGrid) {
      loadedAnchorTrackIdRef.current = activeId;
      return;
    }

    const nextSeed =
      loadedAnchorTrackIdRef.current === undefined
        ? visitSeed
        : nextDiscoveryVisitSeed('kago_search_visit_seed');
    const profile = analyzeTrackContentProfile(engine.currentTrack);
    setPopularSearches((prev) => {
      const next = pickContentBasedPopularSearches(5, nextSeed, prev, profile);
      writeDiscoveryHistory(SEARCH_POPULAR_STORAGE_KEY, next);
      return next;
    });
    void loadDiverseRecommendations(nextSeed, engine.currentTrack);
  }, [engine.currentTrack, hasSearchedOnline, loadDiverseRecommendations, query, visitSeed]);

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

  const handleRefreshPopular = useCallback(() => {
    triggerHaptic('light');
    const nextSeed = nextDiscoveryVisitSeed('kago_search_visit_seed');
    setPopularSearches((prev) => {
      const next = pickContentBasedPopularSearches(
        5,
        nextSeed,
        prev,
        currentContentProfile
      );
      writeDiscoveryHistory(SEARCH_POPULAR_STORAGE_KEY, next);
      return next;
    });
  }, [currentContentProfile]);

  const executeOnlineSearch = useCallback(async (searchText: string) => {
    const cleanQ = searchText.trim();
    setShowSuggestions(false);
    if (!cleanQ) {
      setHasSearchedOnline(false);
      const nextSeed = nextDiscoveryVisitSeed('kago_search_visit_seed');
      await loadDiverseRecommendations(nextSeed, engine.currentTrack);
      return;
    }

    const reqId = ++searchRequestIdRef.current;
    setRecentSearches((prev) => pushRecentSearch(prev, cleanQ));

    setIsSearching(true);
    setHasSearchedOnline(true);

    try {
      const { tracks: liveSongs } = await searchStreamsUnified({
        query: cleanQ,
        category: 'all',
      });
      if (searchRequestIdRef.current !== reqId) return;
      setStreamResults(
        liveSongs.length > 0
          ? liveSongs
          : rotateCuratedFallbackTracks(CURATED_STREAM_BANK, visitSeed)
      );
    } finally {
      if (searchRequestIdRef.current === reqId) {
        setIsSearching(false);
      }
    }
  }, [engine.currentTrack, loadDiverseRecommendations, visitSeed]);

  const lastExternalNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!externalSearch?.query.trim()) return;
    if (lastExternalNonceRef.current === externalSearch.nonce) return;
    lastExternalNonceRef.current = externalSearch.nonce;
    const clean = externalSearch.query.trim();
    setQuery(clean);
    void executeOnlineSearch(clean);
  }, [executeOnlineSearch, externalSearch]);

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

        {/* Dynamic Popular Picks */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-[#8E929B]">
            <Sparkles className="h-3 w-3 text-[#E11D48]" />
            Popular:
          </span>
          {popularSearches.map((term) => (
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
            onClick={handleRefreshPopular}
            aria-label="Shuffle popular searches"
            className="inline-flex items-center gap-1 rounded-md border border-[#252834] bg-[#101218] px-2 py-1 text-[11px] font-medium text-[#9CA3AF] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
          >
            <RefreshCw className="h-3 w-3" />
            <span>Refresh</span>
          </button>
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
            {query.trim()
              ? `No local tracks matched "${query}". Search online streams below.`
              : 'No offline songs saved yet. Pick a song or upload a folder to play offline.'}
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
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="font-mono-tabular text-xs text-[#8E929B] mr-1">
                      {formatDuration(track.duration)}
                    </span>
                    {onPlayNext && (
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          onPlayNext(track);
                        }}
                        aria-label={`Play ${track.title} next`}
                        title="Play Next"
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[#8E929B] hover:bg-[#1C1E27] hover:text-white cursor-pointer"
                      >
                        <ListStart className="h-4 w-4 text-[#E11D48]" />
                      </button>
                    )}
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
              {hasSearchedOnline
                ? 'YouTube & Stream Matches'
                : currentContentProfile
                  ? `Recommended for "${engine.currentTrack?.title}"`
                  : 'Recommended Streams'}
            </h2>
            {!hasSearchedOnline && currentContentProfile?.resolvedGenre && (
              <p className="mt-0.5 text-[11px] text-[#8E929B] truncate">
                Content-matched {currentContentProfile.resolvedGenre} picks · unique every session
              </p>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            {!hasSearchedOnline && (
              <button
                type="button"
                data-testid="search-refresh-recommendations"
                disabled={isSearching}
                onClick={() => {
                  triggerHaptic('light');
                  const nextSeed = nextDiscoveryVisitSeed('kago_search_visit_seed');
                  void loadDiverseRecommendations(nextSeed, engine.currentTrack);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#252834] bg-[#14161D] px-2.5 py-1 text-xs font-semibold text-[#D1D5DB] hover:border-[#E11D48] hover:text-white disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className={`h-3 w-3 ${isSearching ? 'animate-spin' : ''}`} />
                <span>Refresh Mix</span>
              </button>
            )}
            <span className="font-mono-tabular text-xs text-[#8E929B]">
              {streamResults.length} results
            </span>
          </div>
        </div>

        {isSearching && streamResults.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2, 3, 4, 5].map((idx) => (
              <div
                key={idx}
                className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 space-y-3"
              >
                <div className="aspect-[16/10] w-full rounded-lg bg-[#161822]" />
                <div className="h-4 w-3/4 rounded bg-[#1A1D28]" />
                <div className="h-3 w-1/2 rounded bg-[#151821]" />
              </div>
            ))}
          </div>
        ) : (
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
                    {onRequestDownloadTrack && isStreamDownloadableTrack(track) && (() => {
                      const isSavedOffline =
                        Boolean(track.isAppDownload) || Boolean(downloadedTrackIds?.has(track.id));
                      return (
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('selection');
                            onRequestDownloadTrack(track);
                          }}
                          aria-label={
                            isSavedOffline
                              ? `Downloaded ${track.title}`
                              : `Download ${track.title}`
                          }
                          title={
                            isSavedOffline
                              ? 'Saved in App Downloads (tap for local export or removal)'
                              : 'Download to app or device storage'
                          }
                          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
                            isSavedOffline
                              ? 'border-[#10B981]/50 bg-[#10B981]/10 text-[#10B981]'
                              : 'border-[#282B36] bg-[#14161D] text-[#D1D5DB] hover:border-[#E11D48] hover:text-white'
                          }`}
                        >
                          {isSavedOffline ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <Download className="h-4 w-4 text-[#E11D48]" />
                          )}
                        </button>
                      );
                    })()}
                    {onPlayNext && (
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          onPlayNext(track);
                          onSaveTrackToLibrary(track);
                        }}
                        aria-label={`Play ${track.title} next`}
                        title="Play Next"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#282B36] bg-[#14161D] text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer"
                      >
                        <ListStart className="h-4 w-4 text-[#E11D48]" />
                      </button>
                    )}
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
        )}
      </section>
    </div>
  );
};

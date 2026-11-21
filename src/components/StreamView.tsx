import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  BookmarkPlus,
  Check,
  Disc3,
  ListMusic,
  ListPlus,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { CURATED_STREAM_BANK, STREAM_GENRES } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type {
  AudioEngineSnapshot,
  StreamArtistResult,
  StreamSearchCategory,
  Track,
} from '../types/audio';
import { formatDuration } from '../utils/lrcParser';
import { triggerHaptic } from '../utils/haptics';
import { hasNativeHttpBridge } from '../utils/nativeMediaBridge';
import {
  nextDiscoveryVisitSeed,
  pickDiscoveryFeedQuery,
  pickDynamicPopularSearches,
  rotateCuratedFallbackTracks,
} from '../utils/streamDiscovery';
import { pushRecentSearch } from '../utils/streamFilter';
import { fetchYouTubePlaylistByUrlOrId } from '../utils/youtubePlaylist';
import {
  fetchMusicSuggestions,
  searchStreamsUnified,
  searchYouTubeNatively,
} from '../utils/streamSearch';

interface StreamViewProps {
  engine: AudioEngineSnapshot;
  onPlayTrack: (track: Track) => void;
  onPlayCollection?: (tracks: Track[], startIndex: number) => void;
  onTogglePlay: () => void;
  onAddToQueue: (track: Track) => void;
  onAddMultipleToQueue?: (tracks: Track[]) => void;
  onSaveTrackToLibrary: (track: Track) => void;
  onSaveCollectionAsPlaylist?: (name: string, description: string, tracks: Track[]) => void;
}

const STREAM_CATEGORIES: Array<{ id: StreamSearchCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'songs', label: 'Songs' },
  { id: 'videos', label: 'Videos' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'featured_playlists', label: 'Featured Playlists' },
  { id: 'podcasts', label: 'Podcasts' },
];

const POPULAR_PICKS_STORAGE_KEY = 'kago_last_popular_picks';
const FEED_QUERY_STORAGE_KEY = 'kago_last_stream_feed_query';

function readStoredStringArray(key: string): string[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function readStoredString(key: string): string {
  try {
    if (typeof sessionStorage === 'undefined') return '';
    return sessionStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage quota / privacy restrictions
  }
}

function formatCompactViews(views?: number): string {
  if (!views || views <= 0) return '';
  if (views >= 1_000_000_000) return `${(views / 1_000_000_000).toFixed(1)}B views`;
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
  if (views >= 1_000) return `${Math.round(views / 1_000)}K views`;
  return `${views} views`;
}

export const StreamView: React.FC<StreamViewProps> = ({
  engine,
  onPlayTrack,
  onPlayCollection,
  onTogglePlay,
  onAddToQueue,
  onAddMultipleToQueue,
  onSaveTrackToLibrary,
  onSaveCollectionAsPlaylist,
}) => {
  const [visitSeed] = useState<number>(() => nextDiscoveryVisitSeed('kago_stream_visit_seed'));
  const [popularPicks, setPopularPicks] = useState<string[]>(() => {
    const previousPicks = readStoredStringArray(POPULAR_PICKS_STORAGE_KEY);
    const next = pickDynamicPopularSearches(5, visitSeed, [
      'Drake Hotline Bling',
      ...previousPicks,
    ]);
    writeSessionValue(POPULAR_PICKS_STORAGE_KEY, JSON.stringify(next));
    return next;
  });

  const [query, setQuery] = useState('');
  const [selectedGenre, setSelectedGenre] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<StreamSearchCategory>('all');
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    localDb.loadRecentSearches()
  );
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [results, setResults] = useState<Track[]>([]);
  const [artistResults, setArtistResults] = useState<StreamArtistResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const [loadingCollectionId, setLoadingCollectionId] = useState<string | null>(null);
  const [inspectedCollection, setInspectedCollection] = useState<Track | null>(null);
  const [inspectedTracks, setInspectedTracks] = useState<Track[]>([]);
  const [isLoadingCollection, setIsLoadingCollection] = useState(false);
  const [savedCollectionPlaylist, setSavedCollectionPlaylist] = useState(false);
  const [statusNote, setStatusNote] = useState<string>('');
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const searchRequestIdRef = useRef(0);

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

  // Load a fresh discovery feed on mount instead of showing static default cards
  useEffect(() => {
    const reqId = ++searchRequestIdRef.current;
    const prevFeedQuery = readStoredString(FEED_QUERY_STORAGE_KEY);
    const discoveryQuery = pickDiscoveryFeedQuery(visitSeed, prevFeedQuery);
    writeSessionValue(FEED_QUERY_STORAGE_KEY, discoveryQuery);

    const loadInitialFeed = async () => {
      setIsLoading(true);
      try {
        const { tracks: liveSongs, artists: liveArtists } = await searchStreamsUnified({
          query: discoveryQuery,
          genre: '',
          category: 'all',
        });
        if (searchRequestIdRef.current !== reqId) return;
        setArtistResults(liveArtists);
        if (liveSongs.length > 0) {
          setResults(liveSongs);
        } else {
          setResults(rotateCuratedFallbackTracks(CURATED_STREAM_BANK, visitSeed));
        }
      } catch {
        if (searchRequestIdRef.current !== reqId) return;
        setArtistResults([]);
        setResults(rotateCuratedFallbackTracks(CURATED_STREAM_BANK, visitSeed));
        setStatusNote('Offline fallback active — rotating local discovery mix.');
      } finally {
        if (searchRequestIdRef.current === reqId) {
          setIsLoading(false);
        }
      }
    };

    void loadInitialFeed();
  }, [visitSeed]);

  // Debounced YouTube popular search suggestions (works both on server and natively inside Android APK)
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

  const handleShufflePopularPicks = useCallback(() => {
    triggerHaptic('light');
    const freshSeed = nextDiscoveryVisitSeed('kago_stream_visit_seed');
    setPopularPicks((prev) => {
      const next = pickDynamicPopularSearches(5, freshSeed, prev);
      writeSessionValue(POPULAR_PICKS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const executeSearch = async (
    searchText: string,
    genreFilter = selectedGenre,
    category: StreamSearchCategory = selectedCategory
  ) => {
    const reqId = ++searchRequestIdRef.current;
    const cleanQ = searchText.trim();
    setShowSuggestions(false);
    setInspectedCollection(null);
    setInspectedTracks([]);
    setSavedCollectionPlaylist(false);

    if (cleanQ) {
      setRecentSearches((prev) => pushRecentSearch(prev, cleanQ));
    }

    setIsLoading(true);
    setStatusNote('');

    try {
      const effectiveQuery =
        cleanQ || genreFilter
          ? cleanQ
          : pickDiscoveryFeedQuery(nextDiscoveryVisitSeed('kago_stream_visit_seed'));

      const { tracks: liveSongs, artists: liveArtists, source: sourceFlag } =
        await searchStreamsUnified({
          query: effectiveQuery,
          genre: genreFilter,
          category,
        });

      if (searchRequestIdRef.current !== reqId) return;

      setArtistResults(liveArtists);

      const rotatedFallback = rotateCuratedFallbackTracks(CURATED_STREAM_BANK, visitSeed);
      const localMatches = rotatedFallback.filter((item) => {
        const matchesGenre = !genreFilter || item.genre?.toLowerCase() === genreFilter.toLowerCase();
        const matchesQuery =
          !cleanQ ||
          item.title.toLowerCase().includes(cleanQ.toLowerCase()) ||
          item.artist.toLowerCase().includes(cleanQ.toLowerCase()) ||
          (item.genre || '').toLowerCase().includes(cleanQ.toLowerCase());
        return matchesGenre && matchesQuery;
      });

      const merged = liveSongs.length > 0 ? liveSongs : localMatches;
      setResults(merged.length > 0 ? merged : category === 'artists' ? [] : rotatedFallback);
      if (sourceFlag === 'fallback' && liveSongs.length === 0 && liveArtists.length === 0) {
        setStatusNote(
          cleanQ
            ? `No official stream matched "${cleanQ}". Showing rotated offline sound bank.`
            : 'Showing rotated offline sound bank tracks.'
        );
      }
    } catch {
      if (searchRequestIdRef.current !== reqId) return;
      setArtistResults([]);
      const rotatedFallback = rotateCuratedFallbackTracks(CURATED_STREAM_BANK, visitSeed);
      const localMatches = rotatedFallback.filter(
        (item) => !genreFilter || item.genre?.toLowerCase() === genreFilter.toLowerCase()
      );
      setResults(localMatches.length > 0 ? localMatches : rotatedFallback);
      setStatusNote('Offline fallback active — sound bank loaded.');
    } finally {
      if (searchRequestIdRef.current === reqId) {
        setIsLoading(false);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void executeSearch(query, selectedGenre, selectedCategory);
  };

  const handleGenreClick = (genre: string) => {
    triggerHaptic('light');
    const nextGenre = selectedGenre === genre ? '' : genre;
    setSelectedGenre(nextGenre);
    void executeSearch(query, nextGenre, selectedCategory);
  };

  const handleCategoryClick = (category: StreamSearchCategory) => {
    triggerHaptic('light');
    setSelectedCategory(category);
    void executeSearch(query, selectedGenre, category);
  };

  const resolvePlaylistTracks = async (playlistId: string, title: string): Promise<Track[]> => {
    const res = await fetchYouTubePlaylistByUrlOrId(playlistId, title);
    return res.tracks;
  };

  const handleInspectCollection = async (collection: Track) => {
    triggerHaptic('selection');
    setInspectedCollection(collection);
    setInspectedTracks([]);
    setSavedCollectionPlaylist(false);
    setIsLoadingCollection(true);
    setStatusNote('');

    try {
      let tracks: Track[] = [];
      if (collection.youtubePlaylistId) {
        tracks = await resolvePlaylistTracks(collection.youtubePlaylistId, collection.title);
      }
      if (tracks.length === 0) {
        const fallback = await searchStreamsUnified({
          query: `${collection.artist} ${collection.title}`.trim(),
          genre: collection.genre || '',
          category: 'songs',
        });
        tracks = fallback.tracks;
      }
      setInspectedTracks(tracks);
      if (tracks.length === 0) {
        setStatusNote(`Could not load tracks inside "${collection.title}".`);
      }
    } catch {
      setInspectedTracks([]);
      setStatusNote(`Could not load tracks inside "${collection.title}".`);
    } finally {
      setIsLoadingCollection(false);
    }
  };

  const handleCollectionAction = async (collection: Track, mode: 'play' | 'queue') => {
    if (!collection.youtubePlaylistId) {
      if (mode === 'play') onPlayTrack(collection);
      else {
        onAddToQueue(collection);
        onSaveTrackToLibrary(collection);
      }
      return;
    }

    setLoadingCollectionId(collection.id);
    try {
      let tracks = await resolvePlaylistTracks(collection.youtubePlaylistId, collection.title);
      if (tracks.length === 0) {
        const fallback = await searchYouTubeNatively(
          `${collection.artist} ${collection.title}`,
          collection.genre || '',
          'songs'
        );
        tracks = fallback.tracks;
      }

      if (tracks.length === 0) {
        setStatusNote(`Could not load tracks from "${collection.title}". Try searching the song title.`);
        return;
      }

      if (mode === 'play') {
        if (onPlayCollection) {
          onPlayCollection(tracks, 0);
        } else {
          onPlayTrack(tracks[0]);
          tracks.slice(1).forEach((t) => onAddToQueue(t));
        }
        tracks.forEach((t) => onSaveTrackToLibrary(t));
        setStatusNote(`Playing "${tracks[0].title}" + queued ${tracks.length - 1} tracks from "${collection.title}".`);
      } else {
        if (onAddMultipleToQueue) {
          onAddMultipleToQueue(tracks);
        } else {
          tracks.forEach((t) => onAddToQueue(t));
        }
        tracks.forEach((t) => onSaveTrackToLibrary(t));
        setStatusNote(`Added ${tracks.length} tracks from "${collection.title}" to queue.`);
      }
    } finally {
      setLoadingCollectionId(null);
    }
  };

  const handleAutoRecover = async (track: Track) => {
    setRecoveringId(track.id);
    try {
      let recoveredTrack: Track | null = null;

      try {
        const res = await fetch(
          `/api/stream/recover?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(
            track.artist
          )}&genre=${encodeURIComponent(track.genre || '')}&excludeId=${encodeURIComponent(
            track.youtubeId || ''
          )}`
        );
        if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
          const data = (await res.json()) as {
            mode?: string;
            youtubeId?: string;
            streamUrl?: string;
            duration?: number;
            artworkUrl?: string;
            recoveredFrom?: string;
          };
          if (data.mode === 'alternate-youtube' && data.youtubeId) {
            recoveredTrack = {
              ...track,
              youtubeId: data.youtubeId,
              streamUrl: undefined,
              streamProvider: 'youtube',
              duration: data.duration || track.duration,
              artworkUrl: data.artworkUrl || track.artworkUrl,
              recoveredFrom: data.recoveredFrom || 'Alternate YouTube Audio',
            };
          } else if (data.mode === 'alternate-stream' && data.streamUrl) {
            recoveredTrack = {
              ...track,
              youtubeId: undefined,
              streamUrl: data.streamUrl,
              streamProvider: 'audius',
              duration: data.duration || track.duration,
              artworkUrl: data.artworkUrl || track.artworkUrl,
              recoveredFrom: data.recoveredFrom || 'Audius Full-Length Mirror',
            };
          }
        }
      } catch {
        // Fall through to native APK recovery
      }

      if (!recoveredTrack && hasNativeHttpBridge()) {
        const altOut = await searchYouTubeNatively(
          `${track.artist} ${track.title} topic`,
          track.genre || '',
          'songs',
          track.youtubeId
        );
        const altTracks = altOut.tracks;
        if (altTracks[0]?.youtubeId) {
          recoveredTrack = {
            ...track,
            youtubeId: altTracks[0].youtubeId,
            streamUrl: undefined,
            streamProvider: 'youtube',
            duration: altTracks[0].duration || track.duration,
            artworkUrl: altTracks[0].artworkUrl || track.artworkUrl,
            recoveredFrom: `Alternate YouTube (${altTracks[0].youtubeId})`,
          };
        }
      }

      if (!recoveredTrack) {
        recoveredTrack = {
          ...track,
          youtubeId: undefined,
          streamUrl: undefined,
          streamProvider: 'synth',
          recoveredFrom: 'Local Synth Engine Stem',
          synthProfile: track.synthProfile || {
            bpm: 118,
            rootFreq: 55,
            scale: [0, 3, 7, 10, 12],
            patternStyle: 'neon',
            description: 'Auto-recovered procedural synth stream',
          },
        };
      }

      setResults((prev) => prev.map((t) => (t.id === track.id ? recoveredTrack! : t)));
      setStatusNote(`Auto-Recovery ready for "${track.title}" via ${recoveredTrack.recoveredFrom}.`);
      onPlayTrack(recoveredTrack);
    } finally {
      setRecoveringId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Search Header Card */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#F4F3F0]">Free Music Streamer</h1>
            <p className="text-xs text-[#8E929B]">
              Zero-signup full-length YouTube music &amp; video search ranked by official artist tracks
            </p>
          </div>
          {statusNote && (
            <p className="font-mono-tabular text-xs text-[#FF4D6D]">{statusNote}</p>
          )}
        </div>

        {/* Search Form + Live YouTube Autocomplete Suggestions */}
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col sm:flex-row gap-2.5">
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
              placeholder="Search artist, song, album, or playlist..."
              aria-label="Search free music streams"
              className="w-full rounded-lg border border-[#262936] bg-[#07080B] py-2.5 pl-10 pr-4 text-sm text-[#F4F3F0] placeholder-[#6B7280] focus:border-[#E11D48] focus:outline-none"
            />

            {showSuggestions && suggestions.length > 0 && (
              <div
                role="listbox"
                aria-label="Popular search suggestions"
                className="kago-panel-enter absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-lg border border-[#282B36] bg-[#101219] shadow-2xl"
              >
                {suggestions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      triggerHaptic('selection');
                      setQuery(item);
                      setShowSuggestions(false);
                      void executeSearch(item, selectedGenre, selectedCategory);
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
            disabled={isLoading}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#E11D48] px-6 py-2.5 text-sm font-semibold text-white shadow-[0_0_16px_rgba(225,29,72,0.4)] hover:bg-[#BE123C] disabled:opacity-60 transition-colors whitespace-nowrap cursor-pointer"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            <span>Search</span>
          </button>
        </form>

        {/* Horizontally Scrollable Stream Search Categories */}
        <div
          role="tablist"
          aria-label="Stream search categories"
          className="no-scrollbar mt-3.5 flex items-center gap-2 overflow-x-auto pb-1"
        >
          {STREAM_CATEGORIES.map((cat) => {
            const active = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handleCategoryClick(cat.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'border-[#E11D48] bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                    : 'border-[#252834] bg-[#13151C] text-[#B4B7C2] hover:border-[#3A3F50] hover:text-white'
                }`}
              >
                {active && <Check className="h-3.5 w-3.5 stroke-[2.5]" />}
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* Dynamic Popular Song Recommendations */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-[#8E929B]">
            <Sparkles className="h-3 w-3 text-[#E11D48]" />
            Popular:
          </span>
          {popularPicks.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setQuery(term);
                void executeSearch(term, '', selectedCategory);
              }}
              className="rounded-md border border-[#252834] bg-[#14161D] px-2.5 py-1 text-xs text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
            >
              {term}
            </button>
          ))}
          <button
            type="button"
            onClick={handleShufflePopularPicks}
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
                  void executeSearch(term, selectedGenre, selectedCategory);
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

        {/* 8 Curated Sound Bank Genres */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#1C1E26] pt-4">
          {STREAM_GENRES.map((genre) => {
            const active = selectedGenre === genre;
            return (
              <button
                key={genre}
                type="button"
                onClick={() => handleGenreClick(genre)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'border-[#E11D48] bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                    : 'border-[#252834] bg-[#13151C] text-[#B4B7C2] hover:border-[#3A3F50] hover:text-white'
                }`}
              >
                {genre}
              </button>
            );
          })}
        </div>
      </section>

      {/* Album / Playlist Tracklist Detail View (opens without auto-playing) */}
      {inspectedCollection && (
        <section
          aria-label={`${inspectedCollection.title} tracklist`}
          data-testid="collection-inspector-view"
          className="kago-panel-enter space-y-4 rounded-xl border border-[#242732] bg-[#0D0E12] p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setInspectedCollection(null);
                setInspectedTracks([]);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer whitespace-nowrap"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to Results</span>
            </button>

            <span className="font-mono-tabular text-xs uppercase tracking-wider text-[#9CA3AF]">
              {inspectedCollection.resultType === 'album' ? 'Album Tracklist' : 'Playlist Tracklist'}
            </span>
          </div>

          <div className="flex flex-col sm:flex-row gap-5 border-b border-[#1C1E26] pb-5">
            <div className="h-32 w-full sm:w-44 shrink-0 overflow-hidden rounded-xl border border-[#262936] bg-[#14161E]">
              {inspectedCollection.artworkUrl ? (
                <img
                  src={inspectedCollection.artworkUrl}
                  alt={inspectedCollection.title}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <ListMusic className="h-10 w-10 text-[#E11D48]" />
                </div>
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
              <div>
                <h2 className="font-display text-xl sm:text-2xl font-bold text-[#F4F3F0] break-words">
                  {inspectedCollection.title}
                </h2>
                <p className="mt-1 text-xs sm:text-sm text-[#9CA3AF]">
                  {inspectedCollection.artist}
                  {inspectedTracks.length > 0 && (
                    <span className="font-mono-tabular text-[#FF4D6D]">
                      {' '}
                      · {inspectedTracks.length}{' '}
                      {inspectedTracks.length === 1 ? 'track' : 'tracks'}
                    </span>
                  )}
                </p>
              </div>

              {inspectedTracks.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('selection');
                      if (onPlayCollection) {
                        onPlayCollection(inspectedTracks, 0);
                      } else {
                        onPlayTrack(inspectedTracks[0]);
                      }
                    }}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    <span>Play All</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('selection');
                      if (onAddMultipleToQueue) {
                        onAddMultipleToQueue(inspectedTracks);
                      } else {
                        inspectedTracks.forEach((t) => onAddToQueue(t));
                      }
                      setStatusNote(
                        `Queued all ${inspectedTracks.length} tracks from "${inspectedCollection.title}".`
                      );
                    }}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap"
                  >
                    <ListPlus className="h-3.5 w-3.5 text-[#E11D48]" />
                    <span>Queue All</span>
                  </button>

                  {onSaveCollectionAsPlaylist && (
                    <button
                      type="button"
                      disabled={savedCollectionPlaylist}
                      onClick={() => {
                        triggerHaptic('success');
                        onSaveCollectionAsPlaylist(
                          inspectedCollection.title,
                          `${inspectedCollection.artist} · ${inspectedTracks.length} tracks`,
                          inspectedTracks
                        );
                        setSavedCollectionPlaylist(true);
                        setStatusNote(`Saved "${inspectedCollection.title}" to your Playlists.`);
                      }}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] disabled:opacity-60 cursor-pointer whitespace-nowrap"
                    >
                      {savedCollectionPlaylist ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-[#10B981]" />
                          <span>Saved to Playlists</span>
                        </>
                      ) : (
                        <>
                          <BookmarkPlus className="h-3.5 w-3.5 text-[#E11D48]" />
                          <span>Save Playlist</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {isLoadingCollection ? (
            <div className="flex items-center justify-center gap-2.5 py-12 text-xs text-[#9CA3AF]">
              <Loader2 className="h-4 w-4 animate-spin text-[#E11D48]" />
              <span>Loading tracks inside &ldquo;{inspectedCollection.title}&rdquo;...</span>
            </div>
          ) : inspectedTracks.length === 0 ? (
            <div className="rounded-xl border border-[#1F2129] bg-[#090A0E] p-8 text-center text-xs text-[#8E929B]">
              No individual tracks could be resolved for this album or playlist. Try another result.
            </div>
          ) : (
            <div className="divide-y divide-[#1A1C24] rounded-xl border border-[#1F2129] bg-[#090A0E]">
              {inspectedTracks.map((trk, idx) => {
                const isCurrent = engine.currentTrack?.id === trk.id;
                const isPlaying = isCurrent && engine.isPlaying;
                return (
                  <div
                    key={trk.id}
                    className={`flex items-center justify-between gap-3 px-4 py-3 first:rounded-t-xl last:rounded-b-xl transition-colors ${
                      isCurrent ? 'bg-[#17090E]' : 'hover:bg-[#13151C]'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="w-5 shrink-0 text-right font-mono-tabular text-xs text-[#6B7280]">
                        {idx + 1}
                      </span>

                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          if (isCurrent) {
                            onTogglePlay();
                          } else if (onPlayCollection) {
                            onPlayCollection(inspectedTracks, idx);
                          } else {
                            onPlayTrack(trk);
                          }
                        }}
                        aria-label={isPlaying ? `Pause ${trk.title}` : `Play ${trk.title}`}
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
                          isCurrent
                            ? 'border-[#E11D48] bg-[#E11D48] text-white'
                            : 'border-[#252834] bg-[#15171E] text-[#F4F3F0] hover:border-[#E11D48]'
                        }`}
                      >
                        {isPlaying ? (
                          <Pause className="h-4 w-4 fill-current" />
                        ) : (
                          <Play className="h-4 w-4 fill-current ml-0.5" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-sm font-semibold ${
                            isCurrent ? 'text-[#FF4D6D]' : 'text-[#F4F3F0]'
                          }`}
                        >
                          {trk.title}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-[#8E929B]">{trk.artist}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="mr-1 font-mono-tabular text-xs text-[#8E929B]">
                        {formatDuration(trk.duration)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          onAddToQueue(trk);
                          onSaveTrackToLibrary(trk);
                        }}
                        aria-label={`Queue ${trk.title}`}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-[#252834] bg-[#14161D] text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer"
                      >
                        <ListPlus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onSaveTrackToLibrary(trk);
                          setStatusNote(`Saved "${trk.title}" to Library.`);
                        }}
                        aria-label={`Save ${trk.title} to Library`}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-[#252834] bg-[#14161D] text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Matching Artists Section (hidden when inspecting an album/playlist) */}
      {!inspectedCollection &&
        artistResults.length > 0 &&
        (selectedCategory === 'all' || selectedCategory === 'artists') && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[#9CA3AF]">
                Artists
              </h2>
              <span className="font-mono-tabular text-xs text-[#6B7280]">
                Tap an artist to view top songs
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {artistResults.slice(0, selectedCategory === 'artists' ? 8 : 3).map((artist) => (
                <button
                  key={artist.id}
                  type="button"
                  onClick={() => {
                    triggerHaptic('selection');
                    setQuery(artist.name);
                    setSelectedCategory('songs');
                    void executeSearch(artist.name, selectedGenre, 'songs');
                  }}
                  className="kago-press-subtle flex items-center gap-3.5 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-3.5 text-left transition-colors hover:border-[#E11D48] cursor-pointer"
                >
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full border border-[#282B36] bg-[#14161D]">
                    {artist.thumbnailUrl ? (
                      <img
                        src={artist.thumbnailUrl}
                        alt={artist.name}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <UserCheck className="h-6 w-6 text-[#E11D48]" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-display text-sm font-bold text-[#F4F3F0]">
                        {artist.name}
                      </span>
                      {artist.isOfficial && (
                        <BadgeCheck className="h-4 w-4 shrink-0 text-[#E11D48]" />
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[#8E929B]">
                      Artists
                      {artist.subscriberText && artist.subscriberText !== 'Artist'
                        ? ` · ${artist.subscriberText}`
                        : ''}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

      {/* Loading Skeleton Grid (avoids flashing static fallback cards) */}
      {!inspectedCollection && isLoading && results.length === 0 && (
        <section
          aria-label="Loading stream discovery tracks"
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
        >
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
        </section>
      )}

      {/* 3-Column Stream Results Grid */}
      {!inspectedCollection && results.length > 0 && (
        <section className="kago-panel-enter grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {results.map((track) => {
            const isCurrent = engine.currentTrack?.id === track.id;
            const isTrackPlaying = isCurrent && engine.isPlaying;
            const isRecovering = recoveringId === track.id;
            const isCollectionBusy = loadingCollectionId === track.id;
            const viewsLabel = formatCompactViews(track.viewCount);
            const isPlaylistCollection = Boolean(
              track.youtubePlaylistId ||
                track.resultType === 'album' ||
                track.resultType === 'playlist'
            );

            return (
              <article
                key={track.id}
                className={`flex flex-col justify-between rounded-xl border p-4 transition-[border-color,background-color,transform] duration-200 ${
                  isCurrent
                    ? 'border-[#E11D48] bg-[#13090E]'
                    : 'border-[#1F2129] bg-[#0D0E12] hover:border-[#303444]'
                }`}
              >
                {isPlaylistCollection ? (
                  <button
                    type="button"
                    onClick={() => void handleInspectCollection(track)}
                    aria-label={`View tracks inside ${track.title}`}
                    className="group text-left cursor-pointer"
                  >
                    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-[#222530] bg-[#14161E]">
                      {track.artworkUrl ? (
                        <img
                          src={track.artworkUrl}
                          alt={track.title}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#161822] to-[#0A0B0F]">
                          <ListMusic className="h-10 w-10 text-[#E11D48]" />
                        </div>
                      )}
                      {track.resultType && track.resultType !== 'song' && (
                        <span className="absolute left-2 top-2 rounded bg-black/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#F4F3F0] border border-[#2B2E3A]">
                          {track.resultType}
                        </span>
                      )}
                      <span className="absolute bottom-2 right-2 rounded bg-black/85 px-2 py-0.5 font-mono-tabular text-xs font-semibold text-[#F4F3F0] border border-[#2B2E3A]">
                        {track.trackCount ? `${track.trackCount} tracks` : 'Tap to open'}
                      </span>
                    </div>

                    <div className="mt-3">
                      <div className="flex items-center gap-1.5">
                        <h2 className="font-display text-base font-bold text-[#F4F3F0] truncate group-hover:text-[#FF4D6D] transition-colors">
                          {track.title}
                        </h2>
                        {track.isOfficial && (
                          <BadgeCheck
                            className="h-4 w-4 shrink-0 text-[#E11D48]"
                            aria-label="Official artist collection"
                          />
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-[#8E929B] truncate">{track.artist}</p>
                      <div className="mt-1.5 flex items-center gap-2 font-mono-tabular text-[11px] text-[#9CA3AF]">
                        <span className="truncate">Tap to view tracks</span>
                        {track.album && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="truncate text-[#6B7280]">{track.album}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </button>
                ) : (
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
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#161822] to-[#0A0B0F]">
                          <Disc3 className="h-10 w-10 text-[#E11D48]" />
                        </div>
                      )}
                      {track.resultType && track.resultType !== 'song' && (
                        <span className="absolute left-2 top-2 rounded bg-black/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#F4F3F0] border border-[#2B2E3A]">
                          {track.resultType}
                        </span>
                      )}
                      <span className="absolute bottom-2 right-2 rounded bg-black/85 px-2 py-0.5 font-mono-tabular text-xs font-semibold text-[#F4F3F0] border border-[#2B2E3A]">
                        {formatDuration(track.duration)}
                      </span>
                    </div>

                    <div className="mt-3">
                      <div className="flex items-center gap-1.5">
                        <h2 className="font-display text-base font-bold text-[#F4F3F0] truncate">
                          {track.title}
                        </h2>
                        {track.isOfficial && (
                          <BadgeCheck
                            className="h-4 w-4 shrink-0 text-[#E11D48]"
                            aria-label="Official artist track"
                          />
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-[#8E929B] truncate">{track.artist}</p>
                      <div className="mt-1.5 flex items-center gap-2 font-mono-tabular text-[11px] text-[#6B7280]">
                        <span className="truncate">ID: {track.id}</span>
                        {viewsLabel && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#9CA3AF] truncate">{viewsLabel}</span>
                          </>
                        )}
                        {track.recoveredFrom && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#FF4D6D] truncate">{track.recoveredFrom}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#1A1C24] pt-3">
                  {isPlaylistCollection ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleInspectCollection(track)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <ListMusic className="h-3.5 w-3.5 text-[#E11D48]" />
                        <span>View Tracks</span>
                      </button>

                      <button
                        type="button"
                        disabled={isCollectionBusy}
                        onClick={() => {
                          triggerHaptic('selection');
                          void handleCollectionAction(track, 'queue');
                        }}
                        aria-label={`Queue ${track.title}`}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <ListPlus className="h-3.5 w-3.5" />
                        <span>Queue All</span>
                      </button>

                      <button
                        type="button"
                        disabled={isCollectionBusy}
                        onClick={() => {
                          triggerHaptic('selection');
                          void handleCollectionAction(track, 'play');
                        }}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-60 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        {isCollectionBusy ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Loading...</span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5 fill-current" />
                            <span>Play All</span>
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          void handleAutoRecover(track);
                        }}
                        disabled={isRecovering}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-2.5 py-2 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${isRecovering ? 'animate-spin text-[#E11D48]' : ''}`}
                        />
                        <span>Auto-Recovery</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          onAddToQueue(track);
                          onSaveTrackToLibrary(track);
                        }}
                        aria-label={`Queue ${track.title}`}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <ListPlus className="h-3.5 w-3.5" />
                        <span>Queue</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          if (isCurrent) {
                            onTogglePlay();
                          } else {
                            onPlayTrack(track);
                          }
                        }}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap cursor-pointer"
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
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
};

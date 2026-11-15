import React, { useEffect, useRef, useState } from 'react';
import {
  BadgeCheck,
  Check,
  Disc3,
  ListPlus,
  Loader2,
  Pause,
  Play,
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
import { hasNativeHttpBridge, nativeFetchText } from '../utils/nativeMediaBridge';
import {
  extractYouTubePlaylistTracks,
  pushRecentSearch,
} from '../utils/streamFilter';
import {
  fetchMusicSuggestions,
  searchStreamsUnified,
  searchYouTubeNatively,
} from '../utils/streamSearch';

interface StreamViewProps {
  engine: AudioEngineSnapshot;
  onPlayTrack: (track: Track) => void;
  onTogglePlay: () => void;
  onAddToQueue: (track: Track) => void;
  onSaveTrackToLibrary: (track: Track) => void;
}

const POPULAR_PICKS = [
  'Drake Hotline Bling',
  'The Weeknd Blinding Lights',
  'Burna Boy Last Last',
  'Kendrick Lamar Not Like Us',
  'Rema Calm Down',
];

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
  onTogglePlay,
  onAddToQueue,
  onSaveTrackToLibrary,
}) => {
  const [query, setQuery] = useState('');
  const [selectedGenre, setSelectedGenre] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<StreamSearchCategory>('all');
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    localDb.loadRecentSearches()
  );
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [results, setResults] = useState<Track[]>(CURATED_STREAM_BANK);
  const [artistResults, setArtistResults] = useState<StreamArtistResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const [loadingCollectionId, setLoadingCollectionId] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string>('');
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

  const executeSearch = async (
    searchText: string,
    genreFilter = selectedGenre,
    category: StreamSearchCategory = selectedCategory
  ) => {
    const cleanQ = searchText.trim();
    setShowSuggestions(false);

    if (cleanQ) {
      setRecentSearches((prev) => pushRecentSearch(prev, cleanQ));
    }

    setIsLoading(true);
    setStatusNote('');

    try {
      const { tracks: liveSongs, artists: liveArtists, source: sourceFlag } =
        await searchStreamsUnified({
          query: cleanQ,
          genre: genreFilter,
          category,
        });

      setArtistResults(liveArtists);

      const localMatches = CURATED_STREAM_BANK.filter((item) => {
        const matchesGenre = !genreFilter || item.genre?.toLowerCase() === genreFilter.toLowerCase();
        const matchesQuery =
          !cleanQ ||
          item.title.toLowerCase().includes(cleanQ.toLowerCase()) ||
          item.artist.toLowerCase().includes(cleanQ.toLowerCase()) ||
          (item.genre || '').toLowerCase().includes(cleanQ.toLowerCase());
        return matchesGenre && matchesQuery;
      });

      const merged = liveSongs.length > 0 ? liveSongs : localMatches;
      setResults(merged.length > 0 ? merged : category === 'artists' ? [] : CURATED_STREAM_BANK);
      if (sourceFlag === 'fallback' && liveSongs.length === 0 && liveArtists.length === 0) {
        setStatusNote(
          cleanQ
            ? `No official stream matched "${cleanQ}". Showing offline curated sound bank.`
            : 'Showing curated offline sound bank tracks (individual songs only).'
        );
      }
    } catch {
      setArtistResults([]);
      const localMatches = CURATED_STREAM_BANK.filter(
        (item) => !genreFilter || item.genre?.toLowerCase() === genreFilter.toLowerCase()
      );
      setResults(localMatches.length > 0 ? localMatches : CURATED_STREAM_BANK);
      setStatusNote('Offline fallback active — curated sound bank loaded.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void executeSearch(query, selectedGenre, selectedCategory);
  };

  const handleGenreClick = (genre: string) => {
    const nextGenre = selectedGenre === genre ? '' : genre;
    setSelectedGenre(nextGenre);
    void executeSearch(query, nextGenre, selectedCategory);
  };

  const handleCategoryClick = (category: StreamSearchCategory) => {
    setSelectedCategory(category);
    void executeSearch(query, selectedGenre, category);
  };

  const resolvePlaylistTracks = async (playlistId: string, title: string): Promise<Track[]> => {
    try {
      const res = await fetch(
        `/api/stream/playlist?list=${encodeURIComponent(playlistId)}&title=${encodeURIComponent(title)}`
      );
      if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
        const data = (await res.json()) as { tracks?: Track[] };
        if (Array.isArray(data.tracks) && data.tracks.length > 0) {
          return data.tracks;
        }
      }
    } catch {
      // Fall through to Android native HTTP bridge
    }

    if (hasNativeHttpBridge()) {
      const nativeRes = await nativeFetchText(
        `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
        9000
      );
      if (nativeRes?.ok && nativeRes.text) {
        return extractYouTubePlaylistTracks(nativeRes.text, title);
      }
    }

    return [];
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
        onPlayTrack(tracks[0]);
        tracks.slice(1).forEach((t) => {
          onAddToQueue(t);
          onSaveTrackToLibrary(t);
        });
        setStatusNote(`Playing "${tracks[0].title}" + queued ${tracks.length - 1} tracks from "${collection.title}".`);
      } else {
        tracks.forEach((t) => {
          onAddToQueue(t);
          onSaveTrackToLibrary(t);
        });
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
              placeholder="Search artist, popular song, or mood..."
              aria-label="Search free music streams"
              className="w-full rounded-lg border border-[#262936] bg-[#07080B] py-2.5 pl-10 pr-4 text-sm text-[#F4F3F0] placeholder-[#6B7280] focus:border-[#E11D48] focus:outline-none"
            />

            {showSuggestions && suggestions.length > 0 && (
              <div
                role="listbox"
                aria-label="Popular search suggestions"
                className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-lg border border-[#282B36] bg-[#101219] shadow-2xl"
              >
                {suggestions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setQuery(item);
                      setShowSuggestions(false);
                      void executeSearch(item, selectedGenre, selectedCategory);
                    }}
                    className="flex w-full items-center gap-2.5 border-b border-[#1A1C24] px-3.5 py-2.5 text-left text-xs text-[#E5E7EB] last:border-b-0 hover:bg-[#1A1D27] hover:text-white cursor-pointer"
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

        {/* Horizontally Scrollable Stream Search Categories (All, Songs, Videos, Albums, Artists, Playlists, Featured Playlists, Podcasts) */}
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

        {/* Popular Song Recommendations */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-[#8E929B]">
            <Sparkles className="h-3 w-3 text-[#E11D48]" />
            Popular:
          </span>
          {POPULAR_PICKS.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => {
                setQuery(term);
                void executeSearch(term, '', selectedCategory);
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
              onClick={() => setRecentSearches([])}
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

      {/* Matching Artists Section (shown on All when artists match or on Artists category) */}
      {artistResults.length > 0 && (selectedCategory === 'all' || selectedCategory === 'artists') && (
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
                  setQuery(artist.name);
                  setSelectedCategory('songs');
                  void executeSearch(artist.name, selectedGenre, 'songs');
                }}
                className="flex items-center gap-3.5 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-3.5 text-left transition-colors hover:border-[#E11D48] cursor-pointer"
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
                    Artists{artist.subscriberText && artist.subscriberText !== 'Artist' ? ` · ${artist.subscriberText}` : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 3-Column Stream Results Grid */}
      {results.length > 0 && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {results.map((track) => {
            const isCurrent = engine.currentTrack?.id === track.id;
            const isTrackPlaying = isCurrent && engine.isPlaying;
            const isRecovering = recoveringId === track.id;
            const isCollectionBusy = loadingCollectionId === track.id;
            const viewsLabel = formatCompactViews(track.viewCount);
            const isPlaylistCollection = Boolean(track.youtubePlaylistId);

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
                      {isPlaylistCollection && track.trackCount
                        ? `${track.trackCount} tracks`
                        : formatDuration(track.duration)}
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
                      <span className="truncate">
                        {isPlaylistCollection ? track.album : `ID: ${track.id}`}
                      </span>
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

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#1A1C24] pt-3">
                  {!isPlaylistCollection && (
                    <button
                      type="button"
                      onClick={() => handleAutoRecover(track)}
                      disabled={isRecovering}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-2.5 py-2 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${isRecovering ? 'animate-spin text-[#E11D48]' : ''}`}
                      />
                      <span>Auto-Recovery</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isCollectionBusy}
                    onClick={() => {
                      if (isPlaylistCollection) {
                        void handleCollectionAction(track, 'queue');
                      } else {
                        onAddToQueue(track);
                        onSaveTrackToLibrary(track);
                      }
                    }}
                    aria-label={`Queue ${track.title}`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <ListPlus className="h-3.5 w-3.5" />
                    <span>{isPlaylistCollection ? 'Queue All' : 'Queue'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={isCollectionBusy}
                    onClick={() => {
                      if (isPlaylistCollection) {
                        void handleCollectionAction(track, 'play');
                      } else if (isCurrent) {
                        onTogglePlay();
                      } else {
                        onPlayTrack(track);
                      }
                    }}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-60 transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {isCollectionBusy ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Loading...</span>
                      </>
                    ) : isTrackPlaying ? (
                      <>
                        <Pause className="h-3.5 w-3.5 fill-current" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span>{isPlaylistCollection ? 'Play All' : 'Play'}</span>
                      </>
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
};

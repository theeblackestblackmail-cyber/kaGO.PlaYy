import React, { useEffect, useRef, useState } from 'react';
import {
  BadgeCheck,
  Disc3,
  ListPlus,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { CURATED_STREAM_BANK, STREAM_GENRES } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type { AudioEngineSnapshot, Track } from '../types/audio';
import { formatDuration } from '../utils/lrcParser';
import { hasNativeHttpBridge, nativeFetchText } from '../utils/nativeMediaBridge';
import {
  extractYouTubeSearchResults,
  isIndividualSong,
  parseYouTubeSuggestResponse,
  rankYouTubeSearchResults,
  toYouTubeTracks,
} from '../utils/streamFilter';

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
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    localDb.loadRecentSearches()
  );
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [results, setResults] = useState<Track[]>(CURATED_STREAM_BANK);
  const [isLoading, setIsLoading] = useState(false);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
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
      try {
        const res = await fetch(`/api/stream/suggest?q=${encodeURIComponent(trimmed)}`);
        if (!cancelled && res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
          const data = (await res.json()) as { suggestions?: string[] };
          setSuggestions(data.suggestions || []);
          return;
        }
      } catch {
        // Fall through to native Android HTTP bridge
      }

      if (!cancelled && hasNativeHttpBridge()) {
        const nativeRes = await nativeFetchText(
          `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(
            trimmed
          )}`,
          4500
        );
        if (!cancelled && nativeRes?.ok && nativeRes.text) {
          setSuggestions(parseYouTubeSuggestResponse(nativeRes.text));
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const searchYouTubeNatively = async (
    searchTerm: string,
    genreFilter: string,
    excludeId?: string
  ): Promise<Track[]> => {
    if (!hasNativeHttpBridge()) return [];
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
      searchTerm
    )}&sp=EgIQAQ%3D%3D`;
    const nativeRes = await nativeFetchText(ytUrl, 9000);
    if (!nativeRes?.ok || !nativeRes.text) return [];

    const extracted = extractYouTubeSearchResults(nativeRes.text).filter(
      (item) => !excludeId || item.videoId !== excludeId
    );
    const ranked = rankYouTubeSearchResults(extracted, searchTerm).slice(0, 12);
    return toYouTubeTracks(ranked, genreFilter);
  };

  const executeSearch = async (searchText: string, genreFilter = selectedGenre) => {
    const cleanQ = searchText.trim();
    setShowSuggestions(false);

    if (cleanQ) {
      setRecentSearches((prev) =>
        [cleanQ, ...prev.filter((item) => item.toLowerCase() !== cleanQ.toLowerCase())].slice(0, 8)
      );
    }

    setIsLoading(true);
    setStatusNote('');
    const effectiveTerm =
      [cleanQ, genreFilter ? `${genreFilter} music` : ''].filter(Boolean).join(' ') || 'top music hits';

    try {
      let liveSongs: Track[] = [];
      let sourceFlag = 'live';

      // 1. Try server /api/stream/search (AI Studio / Web Node server)
      try {
        const params = new URLSearchParams();
        if (cleanQ) params.set('q', cleanQ);
        if (genreFilter) params.set('genre', genreFilter);

        const res = await fetch(`/api/stream/search?${params.toString()}`);
        if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
          const data = (await res.json()) as { results?: Track[]; source?: string };
          liveSongs = (data.results || []).filter((t) =>
            isIndividualSong(t.title, t.album, t.duration)
          );
          sourceFlag = data.source || 'live';
        }
      } catch {
        // Fall through to native APK / Audius search
      }

      // 2. Android APK native YouTube search bridge (fetches real YouTube directly without server/CORS)
      if (liveSongs.length === 0 && hasNativeHttpBridge()) {
        liveSongs = await searchYouTubeNatively(effectiveTerm, genreFilter);
        if (liveSongs.length > 0) {
          sourceFlag = 'live';
        }
      }

      // 3. Last-resort CORS Audius fallback if YouTube wasn't reachable
      if (liveSongs.length === 0) {
        const audiusQ = [cleanQ, genreFilter].filter(Boolean).join(' ') || 'synthwave';
        const aRes = await fetch(
          `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(audiusQ)}&limit=12`
        );
        if (aRes.ok) {
          const aJson = (await aRes.json()) as {
            data?: Array<{
              id?: string;
              title?: string;
              duration?: number;
              genre?: string;
              user?: { name?: string };
              artwork?: { '480x480'?: string; '150x150'?: string };
            }>;
          };
          liveSongs = (aJson.data || [])
            .filter(
              (item) =>
                item.id &&
                item.title &&
                item.duration &&
                isIndividualSong(item.title, item.genre, item.duration)
            )
            .map((item) => ({
              id: `audius-${item.id}`,
              streamProvider: 'audius' as const,
              title: item.title!,
              artist: item.user?.name || 'Audius Artist',
              album: 'Audius Full Stream',
              duration: Math.round(item.duration!),
              source: 'stream' as const,
              artworkUrl: item.artwork?.['480x480'] || item.artwork?.['150x150'],
              streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(item.id!)}/stream`,
              genre: item.genre || genreFilter || 'Stream',
              addedAt: Date.now(),
            }));
        }
      }

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
      setResults(merged.length > 0 ? merged : CURATED_STREAM_BANK);
      if (sourceFlag === 'fallback' && liveSongs.length === 0) {
        setStatusNote('Showing curated offline sound bank tracks (individual songs only).');
      }
    } catch {
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
    void executeSearch(query, selectedGenre);
  };

  const handleGenreClick = (genre: string) => {
    const nextGenre = selectedGenre === genre ? '' : genre;
    setSelectedGenre(nextGenre);
    void executeSearch(query, nextGenre);
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
        const altTracks = await searchYouTubeNatively(
          `${track.artist} ${track.title} topic`,
          track.genre || '',
          track.youtubeId
        );
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
                      void executeSearch(item, selectedGenre);
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
                void executeSearch(term, '');
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
                  void executeSearch(term, selectedGenre);
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

      {/* 3-Column Stream Results Grid */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {results.map((track) => {
          const isCurrent = engine.currentTrack?.id === track.id;
          const isTrackPlaying = isCurrent && engine.isPlaying;
          const isRecovering = recoveringId === track.id;
          const viewsLabel = formatCompactViews(track.viewCount);

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

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#1A1C24] pt-3">
                <button
                  type="button"
                  onClick={() => handleAutoRecover(track)}
                  disabled={isRecovering}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-2.5 py-2 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isRecovering ? 'animate-spin text-[#E11D48]' : ''}`} />
                  <span>Auto-Recovery</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
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
                  onClick={() => (isCurrent ? onTogglePlay() : onPlayTrack(track))}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap cursor-pointer"
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
      </section>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import {
  Disc3,
  ListPlus,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { CURATED_STREAM_BANK, STREAM_GENRES } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type { AudioEngineSnapshot, Track } from '../types/audio';
import { formatDuration } from '../utils/lrcParser';
import { isIndividualSong } from '../utils/streamFilter';

interface StreamViewProps {
  engine: AudioEngineSnapshot;
  onPlayTrack: (track: Track) => void;
  onTogglePlay: () => void;
  onAddToQueue: (track: Track) => void;
  onSaveTrackToLibrary: (track: Track) => void;
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
  const [results, setResults] = useState<Track[]>(CURATED_STREAM_BANK);
  const [isLoading, setIsLoading] = useState(false);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string>('');

  useEffect(() => {
    localDb.saveRecentSearches(recentSearches);
  }, [recentSearches]);

  const executeSearch = async (searchText: string, genreFilter = selectedGenre) => {
    const cleanQ = searchText.trim();
    if (cleanQ) {
      setRecentSearches((prev) =>
        [cleanQ, ...prev.filter((item) => item.toLowerCase() !== cleanQ.toLowerCase())].slice(0, 8)
      );
    }

    setIsLoading(true);
    setStatusNote('');
    try {
      const params = new URLSearchParams();
      if (cleanQ) params.set('q', cleanQ);
      if (genreFilter) params.set('genre', genreFilter);

      const res = await fetch(`/api/stream/search?${params.toString()}`);
      let liveSongs: Track[] = [];
      let sourceFlag = 'live';

      if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
        const data = (await res.json()) as { results?: Track[]; source?: string };
        liveSongs = (data.results || []).filter((t) =>
          isIndividualSong(t.title, t.album, t.duration)
        );
        sourceFlag = data.source || 'live';
      } else {
        // Standalone APK / static fallback via CORS-enabled Audius full-length API
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
            .filter((item) => item.id && item.title && item.duration && isIndividualSong(item.title, item.genre, item.duration))
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

      // Filter local curated sound bank as complementary offline-ready results
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
      const res = await fetch(
        `/api/stream/recover?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(
          track.artist
        )}&genre=${encodeURIComponent(track.genre || '')}&excludeId=${encodeURIComponent(
          track.youtubeId || ''
        )}`
      );
      const data = (await res.json()) as {
        recovered?: boolean;
        mode?: string;
        youtubeId?: string;
        streamUrl?: string;
        duration?: number;
        artworkUrl?: string;
        recoveredFrom?: string;
      };

      const recoveredTrack: Track =
        data.mode === 'alternate-youtube' && data.youtubeId
          ? {
              ...track,
              youtubeId: data.youtubeId,
              streamUrl: undefined,
              streamProvider: 'youtube',
              duration: data.duration || track.duration,
              artworkUrl: data.artworkUrl || track.artworkUrl,
              recoveredFrom: data.recoveredFrom || 'Alternate YouTube Audio',
            }
          : data.mode === 'alternate-stream' && data.streamUrl
          ? {
              ...track,
              youtubeId: undefined,
              streamUrl: data.streamUrl,
              streamProvider: 'audius',
              duration: data.duration || track.duration,
              artworkUrl: data.artworkUrl || track.artworkUrl,
              recoveredFrom: data.recoveredFrom || 'Audius Full-Length Mirror',
            }
          : {
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

      setResults((prev) => prev.map((t) => (t.id === track.id ? recoveredTrack : t)));
      setStatusNote(`Auto-Recovery ready for "${track.title}" via ${recoveredTrack.recoveredFrom}.`);
      onPlayTrack(recoveredTrack);
    } catch {
      const fallbackTrack: Track = {
        ...track,
        youtubeId: undefined,
        streamUrl: undefined,
        streamProvider: 'synth',
        recoveredFrom: 'Local Synth Stem Fallback',
        synthProfile: track.synthProfile || {
          bpm: 114,
          rootFreq: 55,
          scale: [0, 3, 7, 10, 12],
          patternStyle: 'cyber',
          description: 'Offline auto-recovered synth stem',
        },
      };
      setResults((prev) => prev.map((t) => (t.id === track.id ? fallbackTrack : t)));
      onPlayTrack(fallbackTrack);
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
              Zero-signup full-length YouTube & free music search strictly filtered for individual songs
            </p>
          </div>
          {statusNote && (
            <p className="font-mono-tabular text-xs text-[#FF4D6D]">{statusNote}</p>
          )}
        </div>

        {/* Search Form */}
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8E929B]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search artist, track title, or mood..."
              aria-label="Search free music streams"
              className="w-full rounded-lg border border-[#262936] bg-[#07080B] py-2.5 pl-10 pr-4 text-sm text-[#F4F3F0] placeholder-[#6B7280] focus:border-[#E11D48] focus:outline-none"
            />
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

        {/* Recent Searches */}
        {recentSearches.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
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
                  <h2 className="font-display text-base font-bold text-[#F4F3F0] truncate">
                    {track.title}
                  </h2>
                  <p className="mt-0.5 text-xs text-[#8E929B] truncate">{track.artist}</p>
                  <div className="mt-1.5 flex items-center gap-2 font-mono-tabular text-[11px] text-[#6B7280]">
                    <span className="truncate">ID: {track.id}</span>
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

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Download,
  Film,
  FolderDown,
  Loader2,
  Music,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import type { Track } from '../types/audio';
import {
  DEFAULT_LOCAL_DOWNLOAD_FORMAT,
  DOWNLOAD_FORMAT_OPTIONS,
  estimateFormatSizeBytes,
  fetchStreamFormatSizes,
  formatByteSize,
  isStreamDownloadableTrack,
  type DownloadFormatId,
  type DownloadFormatOption,
} from '../utils/streamDownloads';
import { fetchYouTubePlaylistByUrlOrId } from '../utils/youtubePlaylist';

export type DownloadTarget =
  | { kind: 'track'; track: Track }
  | {
      kind: 'collection';
      title: string;
      artist: string;
      artworkUrl?: string;
      playlistId?: string;
      tracks: Track[];
      collectionType?: string;
    };

interface DownloadSheetModalProps {
  target: DownloadTarget | null;
  savedTracks: Track[];
  isBusy?: boolean;
  initialStep?: 'choice' | 'formats';
  onClose: () => void;
  onSaveToApp: (tracks: Track[]) => void;
  onRemoveFromApp: (trackIds: string[]) => void;
  onDownloadLocally: (tracks: Track[], formatId: DownloadFormatId) => void;
}

export const DownloadSheetModal: React.FC<DownloadSheetModalProps> = ({
  target,
  savedTracks,
  isBusy = false,
  initialStep = 'choice',
  onClose,
  onSaveToApp,
  onRemoveFromApp,
  onDownloadLocally,
}) => {
  const [step, setStep] = useState<'choice' | 'formats'>(initialStep);
  const [selectedFormat, setSelectedFormat] = useState<DownloadFormatId>(DEFAULT_LOCAL_DOWNLOAD_FORMAT);
  const [resolvedCollectionTracks, setResolvedCollectionTracks] = useState<Track[]>([]);
  const [resolvingCollection, setResolvingCollection] = useState(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [exactSizes, setExactSizes] = useState<Partial<Record<DownloadFormatId, number>>>({});
  const [loadingSizes, setLoadingSizes] = useState(false);

  // Sync step & resolve collection tracks when target changes
  useEffect(() => {
    if (!target) return;
    setStep(initialStep);
    setSelectedFormat(DEFAULT_LOCAL_DOWNLOAD_FORMAT);
    setExactSizes({});
    setCollectionError(null);

    if (target.kind === 'track') {
      setResolvedCollectionTracks([]);
      setResolvingCollection(false);
      return;
    }

    if (target.tracks.length > 0) {
      setResolvedCollectionTracks(target.tracks.filter(isStreamDownloadableTrack));
      setResolvingCollection(false);
      return;
    }

    if (!target.playlistId) {
      setResolvedCollectionTracks([]);
      setResolvingCollection(false);
      setCollectionError('No downloadable tracks found in this collection.');
      return;
    }

    let cancelled = false;
    setResolvingCollection(true);
    setResolvedCollectionTracks([]);
    void fetchYouTubePlaylistByUrlOrId(target.playlistId, target.title)
      .then((res) => {
        if (cancelled) return;
        const clean = res.tracks.filter(isStreamDownloadableTrack);
        setResolvedCollectionTracks(clean);
        if (clean.length === 0) {
          setCollectionError(res.error || 'No streamed tracks found in this collection.');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCollectionError('Could not load tracks for this collection.');
        }
      })
      .finally(() => {
        if (!cancelled) setResolvingCollection(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target, initialStep]);

  const targetTracks = useMemo<Track[]>(() => {
    if (!target) return [];
    if (target.kind === 'track') {
      return isStreamDownloadableTrack(target.track) ? [target.track] : [];
    }
    return resolvedCollectionTracks;
  }, [target, resolvedCollectionTracks]);

  const referenceTrack = targetTracks[0] || null;

  // Fetch exact byte sizes when entering 'formats' step
  useEffect(() => {
    if (!target || step !== 'formats' || !referenceTrack) return;
    let cancelled = false;
    setLoadingSizes(true);
    void fetchStreamFormatSizes(referenceTrack)
      .then((res) => {
        if (!cancelled && res.sizes) {
          setExactSizes(res.sizes);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSizes(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target, step, referenceTrack?.id]);

  // Escape key closes modal
  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target, onClose]);

  if (!target) return null;

  const savedIdSet = new Set(savedTracks.filter((t) => t.isAppDownload).map((t) => t.id));
  const savedTargetTracks = targetTracks.filter((t) => savedIdSet.has(t.id));
  const unsavedTargetTracks = targetTracks.filter((t) => !savedIdSet.has(t.id));
  const allSavedInApp = targetTracks.length > 0 && unsavedTargetTracks.length === 0;
  const hasAnyVideoCapableTrack = targetTracks.some((t) => Boolean(t.youtubeId));

  const headerTitle = target.kind === 'track' ? target.track.title : target.title;
  const headerArtist = target.kind === 'track' ? target.track.artist : target.artist;
  const headerArtwork = target.kind === 'track' ? target.track.artworkUrl : target.artworkUrl;
  const collectionCount = targetTracks.length;

  const computeDisplayedBytes = (option: DownloadFormatOption): number => {
    if (!referenceTrack) {
      return estimateFormatSizeBytes(210, option);
    }
    if (target.kind === 'track') {
      return estimateFormatSizeBytes(referenceTrack.duration, option, exactSizes);
    }
    const perTrackSum = targetTracks.reduce((sum, t, idx) => {
      if (idx === 0 && exactSizes[option.id]) {
        return sum + (exactSizes[option.id] || 0);
      }
      return sum + estimateFormatSizeBytes(t.duration, option);
    }, 0);
    return perTrackSum;
  };

  const musicOptions = DOWNLOAD_FORMAT_OPTIONS.filter((o) => o.category === 'music');
  const videoOptions = DOWNLOAD_FORMAT_OPTIONS.filter((o) => o.category === 'video');

  const selectedOption =
    DOWNLOAD_FORMAT_OPTIONS.find((o) => o.id === selectedFormat) ||
    DOWNLOAD_FORMAT_OPTIONS.find((o) => o.id === DEFAULT_LOCAL_DOWNLOAD_FORMAT)!;

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Download options"
    >
      <div
        className="w-full sm:max-w-lg bg-[#0D0E12] border-t sm:border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        {step === 'choice' ? (
          <>
            {/* Drag handle on mobile + Top bar */}
            <div className="px-5 pt-3 pb-4 border-b border-white/[0.07]">
              <div className="w-10 h-1 rounded-full bg-zinc-700 mx-auto mb-3 sm:hidden" />
              <div className="flex items-center gap-3.5">
                <div className="w-13 h-13 rounded-xl bg-zinc-900 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                  {headerArtwork ? (
                    <img
                      src={headerArtwork}
                      alt={headerTitle}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Music className="w-6 h-6 text-[#E11D48]" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#E11D48]">
                    {target.kind === 'collection'
                      ? target.collectionType || 'Collection Download'
                      : 'Stream Download'}
                  </p>
                  <h3 className="text-base font-bold text-white truncate">{headerTitle}</h3>
                  <p className="text-xs text-zinc-400 truncate mt-0.5">
                    {headerArtist}
                    {target.kind === 'collection' && collectionCount > 0 && (
                      <span className="tabular-nums"> · {collectionCount} tracks</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close download menu"
                  className="w-10 h-10 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] text-zinc-300 flex items-center justify-center transition-colors shrink-0"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>
            </div>

            {/* Two-mode body */}
            <div className="p-5 space-y-3 overflow-y-auto">
              {resolvingCollection ? (
                <div className="py-10 flex flex-col items-center justify-center gap-3 text-zinc-400">
                  <Loader2 className="w-6 h-6 text-[#E11D48] animate-spin" />
                  <p className="text-xs">Loading tracks in this collection…</p>
                </div>
              ) : collectionError || targetTracks.length === 0 ? (
                <div className="rounded-2xl bg-red-500/10 border border-red-500/25 px-4 py-4 text-xs text-red-300">
                  {collectionError || 'No streamed tracks available to download.'}
                </div>
              ) : (
                <>
                  {/* Mode 1: Save in App Downloads (Spotify-style offline) */}
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      if (allSavedInApp) return;
                      onSaveToApp(unsavedTargetTracks.length > 0 ? unsavedTargetTracks : targetTracks);
                      onClose();
                    }}
                    className={`w-full text-left rounded-2xl p-4 border transition-all min-h-[76px] flex items-center gap-3.5 ${
                      allSavedInApp
                        ? 'bg-emerald-500/[0.08] border-emerald-500/30 cursor-default'
                        : 'bg-[#14161D] hover:bg-[#191C25] border-white/10 hover:border-[#E11D48]/40 active:scale-[0.99]'
                    }`}
                  >
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                        allSavedInApp
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-[#E11D48]/15 text-[#E11D48]'
                      }`}
                    >
                      {allSavedInApp ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : (
                        <Smartphone className="w-5 h-5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">
                          {allSavedInApp
                            ? 'Saved in App Downloads'
                            : target.kind === 'collection' && savedTargetTracks.length > 0
                              ? `Save Remaining to App (${unsavedTargetTracks.length})`
                              : 'Save to App Downloads'}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                        Play 100% offline inside kaGO.PIaY. Stored in app data only — hidden from
                        device storage.
                      </p>
                    </div>
                    {!allSavedInApp && (
                      <ChevronRight className="w-4.5 h-4.5 text-zinc-500 shrink-0" />
                    )}
                  </button>

                  {savedTargetTracks.length > 0 && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        onRemoveFromApp(savedTargetTracks.map((t) => t.id));
                        onClose();
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.03] hover:bg-red-500/15 border border-white/[0.07] hover:border-red-500/30 text-xs font-medium text-zinc-400 hover:text-red-300 transition-colors min-h-[44px]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove Offline App Download
                      {target.kind === 'collection' && (
                        <span className="tabular-nums">({savedTargetTracks.length})</span>
                      )}
                    </button>
                  )}

                  {/* Mode 2: Download Locally -> opens "More formats" picker */}
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setStep('formats')}
                    className="w-full text-left rounded-2xl p-4 bg-[#14161D] hover:bg-[#191C25] border border-white/10 hover:border-white/25 transition-all min-h-[76px] flex items-center gap-3.5 active:scale-[0.99]"
                  >
                    <div className="w-11 h-11 rounded-xl bg-white/[0.06] text-white flex items-center justify-center shrink-0">
                      <FolderDown className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">Download Locally</span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                          MP3 · M4A · MP4
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                        Save audio or video files to your device Downloads folder with format
                        quality options.
                      </p>
                    </div>
                    <ChevronRight className="w-4.5 h-4.5 text-zinc-400 shrink-0" />
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {/* "More formats" Header */}
            <div className="px-4 py-3.5 border-b border-white/[0.07] flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setStep('choice')}
                aria-label="Back to download options"
                className="w-10 h-10 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] text-white flex items-center justify-center transition-colors shrink-0"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-white">More formats</h3>
                <p className="text-[11px] text-zinc-400 truncate">
                  {headerTitle}
                  {target.kind === 'collection' && collectionCount > 0 && (
                    <span className="tabular-nums"> · {collectionCount} tracks</span>
                  )}
                </p>
              </div>
              {loadingSizes && <Loader2 className="w-4 h-4 text-zinc-400 animate-spin shrink-0" />}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="w-10 h-10 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] text-zinc-300 flex items-center justify-center transition-colors shrink-0"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {/* Music + Video Format Rows */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
              {/* Music section */}
              <div>
                <p className="text-xs font-semibold text-zinc-400 px-1 mb-2">Music</p>
                <div className="space-y-1">
                  {musicOptions.map((opt) => {
                    const isSelected = selectedFormat === opt.id;
                    const bytes = computeDisplayedBytes(opt);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setSelectedFormat(opt.id)}
                        className={`w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-colors text-left min-h-[56px] ${
                          isSelected
                            ? 'bg-[#E11D48]/[0.12] border border-[#E11D48]/35'
                            : 'hover:bg-white/[0.04] border border-transparent'
                        }`}
                      >
                        <Music
                          className={`w-5 h-5 shrink-0 ${
                            isSelected ? 'text-[#E11D48]' : 'text-zinc-400'
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">{opt.title}</span>
                            {opt.badge && (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 bg-white/[0.07] px-1.5 py-0.5 rounded">
                                {opt.badge}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-400 leading-snug mt-0.5">
                            {opt.subtitle}
                          </p>
                        </div>
                        <span className="text-xs text-zinc-300 tabular-nums shrink-0 mr-1">
                          {formatByteSize(bytes)}
                        </span>
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                            isSelected
                              ? 'bg-[#E11D48] text-white'
                              : 'border-2 border-zinc-600'
                          }`}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Video section */}
              <div>
                <div className="flex items-center justify-between px-1 mb-2">
                  <p className="text-xs font-semibold text-zinc-400">Video</p>
                  {!hasAnyVideoCapableTrack && (
                    <span className="text-[11px] text-zinc-500">YouTube video streams only</span>
                  )}
                </div>
                <div className="space-y-1">
                  {videoOptions.map((opt) => {
                    const isSelected = selectedFormat === opt.id;
                    const disabled = !hasAnyVideoCapableTrack;
                    const bytes = computeDisplayedBytes(opt);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => setSelectedFormat(opt.id)}
                        className={`w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-colors text-left min-h-[56px] ${
                          disabled
                            ? 'opacity-40 cursor-not-allowed border border-transparent'
                            : isSelected
                              ? 'bg-[#E11D48]/[0.12] border border-[#E11D48]/35'
                              : 'hover:bg-white/[0.04] border border-transparent'
                        }`}
                      >
                        <Film
                          className={`w-5 h-5 shrink-0 ${
                            isSelected ? 'text-[#E11D48]' : 'text-zinc-400'
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">{opt.title}</span>
                            {opt.badge && (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 bg-white/[0.07] px-1.5 py-0.5 rounded">
                                {opt.badge}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-400 leading-snug mt-0.5">
                            {opt.subtitle}
                          </p>
                        </div>
                        <span className="text-xs text-zinc-300 tabular-nums shrink-0 mr-1">
                          {formatByteSize(bytes)}
                        </span>
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                            isSelected
                              ? 'bg-[#E11D48] text-white'
                              : 'border-2 border-zinc-600'
                          }`}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Sticky bottom Download button */}
            <div className="p-4 border-t border-white/[0.07] bg-[#0D0E12] shrink-0">
              <button
                type="button"
                disabled={isBusy || targetTracks.length === 0 || (!hasAnyVideoCapableTrack && selectedOption.category === 'video')}
                onClick={() => {
                  onDownloadLocally(targetTracks, selectedFormat);
                  onClose();
                }}
                className="w-full py-3.5 rounded-full bg-[#E11D48] hover:bg-[#be123c] disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors min-h-[48px]"
              >
                <Download className="w-4 h-4" />
                {target.kind === 'collection' && collectionCount > 1
                  ? `Download ${collectionCount} Files (${selectedOption.ext.toUpperCase()})`
                  : `Download (${selectedOption.title})`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

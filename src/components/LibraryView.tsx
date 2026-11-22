import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  CheckCircle2,
  CheckSquare,
  Disc3,
  Download,
  Folder,
  FolderDown,
  FolderOpen,
  Heart,
  ListMusic,
  ListPlus,
  ListStart,
  Loader2,
  MoreVertical,
  Music,
  Pause,
  Play,
  Plus,
  Radio,
  Smartphone,
  Trash2,
  User,
  X,
} from 'lucide-react';
import type { AudioEngineSnapshot, LibrarySubTab, Playlist, Track } from '../types/audio';
import { triggerHaptic } from '../utils/haptics';
import { formatDuration } from '../utils/lrcParser';
import { formatByteSize, isStreamDownloadableTrack } from '../utils/streamDownloads';

interface LibraryViewProps {
  tracks: Track[];
  playlists: Playlist[];
  favoriteIds: string[];
  engine: AudioEngineSnapshot;
  libraryFocusRequest?: {
    subTab: LibrarySubTab;
    groupName?: string | null;
    nonce: number;
  } | null;
  onPlayTrack: (track: Track) => void;
  onPlayCollection?: (tracks: Track[], startIndex: number) => void;
  onTogglePlay: () => void;
  onPlayNext?: (track: Track) => void;
  onPlayMultipleNext?: (tracks: Track[]) => void;
  onAddToQueue: (track: Track) => void;
  onAddMultipleToQueue?: (tracks: Track[]) => void;
  onToggleFavorite: (trackId: string) => void;
  onPickSong: () => void;
  onPickFolder: () => void;
  onOpenLiveStudio: () => void;
  onCreatePlaylist: (name: string, description: string) => void;
  onCreatePlaylistWithTracks?: (name: string, description: string, tracks: Track[]) => void;
  onImportYouTubePlaylist?: (
    urlOrId: string,
    customName?: string
  ) => Promise<{ ok: boolean; trackCount?: number; error?: string }>;
  onDeletePlaylist: (playlistId: string) => void;
  onDeletePlaylists?: (playlistIds: string[]) => void;
  onAddTrackToPlaylist: (playlistId: string, trackId: string) => void;
  onAddMultipleTracksToPlaylist?: (playlistId: string, trackIds: string[]) => void;
  onDeleteTrack: (trackId: string) => void;
  onDeleteTracks?: (trackIds: string[]) => void;
  onRequestDownloadTrack?: (track: Track) => void;
  onRequestDownloadTrackFormats?: (track: Track) => void;
  onRequestDownloadCollection?: (col: {
    title: string;
    artist: string;
    artworkUrl?: string;
    tracks: Track[];
    collectionType?: string;
  }) => void;
  onRemoveAppDownloads?: (trackIds: string[]) => void;
}

const SUB_TABS: Array<{ id: LibrarySubTab; label: string }> = [
  { id: 'all', label: 'All Songs' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'folders', label: 'Folders' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'favorites', label: 'Favorites' },
];

export const LibraryView: React.FC<LibraryViewProps> = ({
  tracks,
  playlists,
  favoriteIds,
  engine,
  libraryFocusRequest,
  onPlayTrack,
  onPlayCollection,
  onTogglePlay,
  onPlayNext,
  onPlayMultipleNext,
  onAddToQueue,
  onAddMultipleToQueue,
  onToggleFavorite,
  onPickSong,
  onPickFolder,
  onOpenLiveStudio,
  onCreatePlaylist,
  onCreatePlaylistWithTracks,
  onImportYouTubePlaylist,
  onDeletePlaylist,
  onDeletePlaylists,
  onAddTrackToPlaylist,
  onAddMultipleTracksToPlaylist,
  onDeleteTrack,
  onDeleteTracks,
  onRequestDownloadTrack,
  onRequestDownloadTrackFormats,
  onRequestDownloadCollection,
  onRemoveAppDownloads,
}) => {
  const [subTab, setSubTab] = useState<LibrarySubTab>('all');
  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [playlistDesc, setPlaylistDesc] = useState('');
  const [playlistError, setPlaylistError] = useState('');
  const [showImportYtModal, setShowImportYtModal] = useState(false);
  const [ytPlaylistUrl, setYtPlaylistUrl] = useState('');
  const [ytCustomName, setYtCustomName] = useState('');
  const [ytImportError, setYtImportError] = useState('');
  const [isImportingYt, setIsImportingYt] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [assigningTrackId, setAssigningTrackId] = useState<string | null>(null);
  const [openMenuTrackId, setOpenMenuTrackId] = useState<string | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [isPlaylistSelectMode, setIsPlaylistSelectMode] = useState(false);
  const [selectedPlaylistIds, setSelectedPlaylistIds] = useState<string[]>([]);
  const [showBulkPlaylistPicker, setShowBulkPlaylistPicker] = useState(false);
  const [bulkNewPlaylistName, setBulkNewPlaylistName] = useState('');
  const [bulkActionFeedback, setBulkActionFeedback] = useState('');

  useEffect(() => {
    if (!libraryFocusRequest) return;
    setSubTab(libraryFocusRequest.subTab);
    setSelectedGroup(libraryFocusRequest.groupName ?? null);
    setSelectedPlaylistId(null);
    setOpenMenuTrackId(null);
    setIsSelectMode(false);
    setSelectedTrackIds([]);
    setIsPlaylistSelectMode(false);
    setSelectedPlaylistIds([]);
    setShowBulkPlaylistPicker(false);
  }, [libraryFocusRequest]);

  useEffect(() => {
    if (!openMenuTrackId) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-song-menu-root="true"]')) return;
      setOpenMenuTrackId(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenuTrackId(null);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuTrackId]);

  useEffect(() => {
    if (!bulkActionFeedback) return;
    const timer = window.setTimeout(() => setBulkActionFeedback(''), 2800);
    return () => clearTimeout(timer);
  }, [bulkActionFeedback]);

  const selectedIdSet = useMemo(() => new Set(selectedTrackIds), [selectedTrackIds]);
  const selectedPlaylistIdSet = useMemo(
    () => new Set(selectedPlaylistIds),
    [selectedPlaylistIds]
  );

  const favoriteTracks = useMemo(
    () => tracks.filter((t) => favoriteIds.includes(t.id)),
    [tracks, favoriteIds]
  );

  const downloadedTracks = useMemo(
    () =>
      tracks
        .filter((t) => Boolean(t.isAppDownload))
        .sort((a, b) => (b.downloadedAt || b.addedAt) - (a.downloadedAt || a.addedAt)),
    [tracks]
  );

  const downloadedBytesTotal = useMemo(
    () => downloadedTracks.reduce((sum, t) => sum + (t.downloadSizeBytes || 0), 0),
    [downloadedTracks]
  );

  const folderGroups = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const t of tracks) {
      const key = t.folderPath || 'Imported Files';
      map.set(key, [...(map.get(key) || []), t]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [tracks]);

  const albumGroups = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const t of tracks) {
      const key = t.album || 'Single';
      map.set(key, [...(map.get(key) || []), t]);
    }
    return Array.from(map.entries());
  }, [tracks]);

  const artistGroups = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const t of tracks) {
      const key = t.artist || 'Unknown Artist';
      map.set(key, [...(map.get(key) || []), t]);
    }
    return Array.from(map.entries());
  }, [tracks]);

  const activePlaylist = useMemo(
    () => (selectedPlaylistId ? playlists.find((p) => p.id === selectedPlaylistId) || null : null),
    [playlists, selectedPlaylistId]
  );

  const handleCreatePlaylistSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = playlistName.trim();
    if (!clean) {
      setPlaylistError('Please enter a playlist name.');
      return;
    }
    onCreatePlaylist(clean, playlistDesc.trim());
    setPlaylistName('');
    setPlaylistDesc('');
    setPlaylistError('');
    setShowNewPlaylistModal(false);
  };

  const handleImportYtSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onImportYouTubePlaylist) return;
    const raw = ytPlaylistUrl.trim();
    if (!raw) {
      setYtImportError('Paste a YouTube playlist URL or ID first.');
      return;
    }
    setYtImportError('');
    setIsImportingYt(true);
    try {
      const res = await onImportYouTubePlaylist(raw, ytCustomName.trim() || undefined);
      if (!res.ok) {
        setYtImportError(res.error || 'Could not import YouTube playlist.');
        return;
      }
      setYtPlaylistUrl('');
      setYtCustomName('');
      setYtImportError('');
      setShowImportYtModal(false);
    } finally {
      setIsImportingYt(false);
    }
  };

  const toggleTrackSelection = (trackId: string) => {
    triggerHaptic('light');
    setSelectedTrackIds((prev) =>
      prev.includes(trackId) ? prev.filter((id) => id !== trackId) : [...prev, trackId]
    );
  };

  const togglePlaylistSelection = (playlistId: string) => {
    triggerHaptic('light');
    setSelectedPlaylistIds((prev) =>
      prev.includes(playlistId)
        ? prev.filter((id) => id !== playlistId)
        : [...prev, playlistId]
    );
  };

  const exitSelectMode = () => {
    setIsSelectMode(false);
    setSelectedTrackIds([]);
    setShowBulkPlaylistPicker(false);
    setBulkNewPlaylistName('');
  };

  const exitPlaylistSelectMode = () => {
    setIsPlaylistSelectMode(false);
    setSelectedPlaylistIds([]);
  };

  const handleDeleteIds = (ids: string[]) => {
    const cleanIds = ids.filter(Boolean);
    if (cleanIds.length === 0) return;
    triggerHaptic('medium');
    if (onDeleteTracks) {
      onDeleteTracks(cleanIds);
    } else {
      for (const id of cleanIds) {
        onDeleteTrack(id);
      }
    }
    setBulkActionFeedback(`Deleted ${cleanIds.length} ${cleanIds.length === 1 ? 'song' : 'songs'}.`);
  };

  const handleDeleteSelectedPlaylists = (ids: string[]) => {
    const cleanIds = ids.filter(Boolean);
    if (cleanIds.length === 0) return;
    triggerHaptic('medium');
    if (onDeletePlaylists) {
      onDeletePlaylists(cleanIds);
    } else {
      for (const id of cleanIds) {
        onDeletePlaylist(id);
      }
    }
    setBulkActionFeedback(
      `Deleted ${cleanIds.length} ${cleanIds.length === 1 ? 'playlist' : 'playlists'}.`
    );
  };

  const handleAddTracksBatchToQueue = (selectedTracks: Track[]) => {
    if (selectedTracks.length === 0) return;
    if (onAddMultipleToQueue) {
      onAddMultipleToQueue(selectedTracks);
    } else {
      for (const tr of selectedTracks) {
        onAddToQueue(tr);
      }
    }
    setBulkActionFeedback(
      `Added ${selectedTracks.length} ${selectedTracks.length === 1 ? 'track' : 'tracks'} to queue.`
    );
  };

  const handlePlayTracksBatchNext = (selectedTracks: Track[]) => {
    if (selectedTracks.length === 0) return;
    if (onPlayMultipleNext) {
      onPlayMultipleNext(selectedTracks);
    } else if (onPlayNext) {
      for (let i = selectedTracks.length - 1; i >= 0; i--) {
        onPlayNext(selectedTracks[i]);
      }
    }
    setBulkActionFeedback(
      selectedTracks.length === 1
        ? `"${selectedTracks[0].title}" will play next.`
        : `${selectedTracks.length} tracks will play next.`
    );
  };

  const handleAddTracksBatchToPlaylist = (playlistId: string, selectedTracks: Track[]) => {
    if (selectedTracks.length === 0) return;
    const ids = selectedTracks.map((t) => t.id);
    if (onAddMultipleTracksToPlaylist) {
      onAddMultipleTracksToPlaylist(playlistId, ids);
    } else {
      for (const id of ids) {
        onAddTrackToPlaylist(playlistId, id);
      }
    }
    const targetPl = playlists.find((p) => p.id === playlistId);
    setBulkActionFeedback(
      `Added ${ids.length} ${ids.length === 1 ? 'song' : 'songs'} to "${targetPl?.name || 'playlist'}".`
    );
  };

  const selectedTrackObjects = useMemo(() => {
    if (selectedTrackIds.length === 0) return [];
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return selectedTrackIds
      .map((id) => byId.get(id))
      .filter((t): t is Track => Boolean(t));
  }, [tracks, selectedTrackIds]);

  const renderTrackRows = (list: Track[]) => {
    if (list.length === 0) {
      return (
        <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-10 text-center">
          <p className="text-sm text-[#8E929B]">No tracks in this view yet.</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onPickSong}
              className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
            >
              <Music className="h-3.5 w-3.5" />
              <span>Pick Song</span>
            </button>
            <button
              type="button"
              onClick={onPickFolder}
              className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-4 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
            >
              <FolderOpen className="h-3.5 w-3.5 text-[#E11D48]" />
              <span>Upload Folder</span>
            </button>
          </div>
        </div>
      );
    }

    const playRowInList = (track: Track, listIdx: number) => {
      if (!onPlayCollection) {
        onPlayTrack(track);
        return;
      }
      onPlayCollection(list, listIdx);
    };

    const selectedTracksInList = list.filter((t) => selectedIdSet.has(t.id));
    const allInListSelected = list.length > 0 && selectedTracksInList.length === list.length;
    const selectionActive = isSelectMode || selectedTracksInList.length > 0;

    return (
      <div className="space-y-2.5">
        {/* Select Mode Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#1F2129] bg-[#0D0E12] px-3.5 py-2.5">
          {selectionActive ? (
            <>
              <div className="flex items-center gap-2.5">
                <span className="font-mono-tabular text-xs font-semibold text-[#FF4D6D]">
                  {selectedTracksInList.length} selected
                </span>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    if (allInListSelected) {
                      const inListIds = new Set(list.map((t) => t.id));
                      setSelectedTrackIds((prev) => prev.filter((id) => !inListIds.has(id)));
                    } else {
                      setSelectedTrackIds((prev) => {
                        const next = new Set(prev);
                        for (const t of list) next.add(t.id);
                        return Array.from(next);
                      });
                    }
                  }}
                  className="rounded-md border border-[#282B36] bg-[#14161D] px-2.5 py-1 text-[11px] font-semibold text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer"
                >
                  {allInListSelected ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  exitSelectMode();
                }}
                className="rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs font-semibold text-[#9CA3AF] hover:text-white cursor-pointer"
              >
                Done
              </button>
            </>
          ) : (
            <>
              <span className="font-mono-tabular text-xs text-[#8E929B]">
                {list.length} {list.length === 1 ? 'song' : 'songs'}
              </span>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setIsSelectMode(true);
                  setOpenMenuTrackId(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs font-semibold text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer whitespace-nowrap"
              >
                <CheckSquare className="h-3.5 w-3.5 text-[#E11D48]" />
                <span>Select Multiple</span>
              </button>
            </>
          )}
        </div>

        {/* Song List */}
        <div className="divide-y divide-[#1A1C24] rounded-xl border border-[#1F2129] bg-[#0D0E12]">
          {list.map((track, listIdx) => {
            const isCurrent = engine.currentTrack?.id === track.id;
            const isPlaying = isCurrent && engine.isPlaying;
            const isFav = favoriteIds.includes(track.id);
            const isSelected = selectedIdSet.has(track.id);
            const isMenuOpen = openMenuTrackId === track.id;

            return (
              <div
                key={track.id}
                onClick={
                  selectionActive
                    ? () => toggleTrackSelection(track.id)
                    : undefined
                }
                className={`relative flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 px-4 py-3 first:rounded-t-xl last:rounded-b-xl transition-colors ${
                  selectionActive ? 'cursor-pointer' : ''
                } ${
                  isSelected
                    ? 'bg-[#1D0B12]'
                    : isCurrent
                    ? 'bg-[#17090E]'
                    : 'hover:bg-[#13151C]'
                }`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {selectionActive && (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={`Select ${track.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleTrackSelection(track.id);
                      }}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors cursor-pointer ${
                        isSelected
                          ? 'border-[#E11D48] bg-[#E11D48] text-white'
                          : 'border-[#323644] bg-[#0A0B0F] text-transparent hover:border-[#E11D48]'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5 stroke-[2.75]" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      triggerHaptic('selection');
                      if (isCurrent) {
                        onTogglePlay();
                      } else {
                        playRowInList(track, listIdx);
                      }
                    }}
                    aria-label={isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
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
                    <div className="flex items-center gap-2">
                      <span
                        className={`truncate text-sm font-semibold ${
                          isCurrent ? 'text-[#FF4D6D]' : 'text-[#F4F3F0]'
                        }`}
                      >
                        {track.title}
                      </span>
                      {track.isAppDownload && (
                        <CheckCircle2
                          className="h-3.5 w-3.5 shrink-0 text-[#10B981]"
                          aria-label="Saved in App Downloads for offline playback"
                        />
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-[#8E929B]">
                      <span className="truncate">{track.artist}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{track.album}</span>
                      {track.isAppDownload && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0 font-mono-tabular text-[11px] text-[#10B981]">
                            Offline
                            {track.downloadSizeBytes
                              ? ` (${formatByteSize(track.downloadSizeBytes)})`
                              : ''}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div
                  className="flex items-center gap-1 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="mr-1.5 font-mono-tabular text-xs text-[#8E929B]">
                    {formatDuration(track.duration)}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      onToggleFavorite(track.id);
                    }}
                    aria-label={isFav ? `Unfavorite ${track.title}` : `Favorite ${track.title}`}
                    className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors cursor-pointer ${
                      isFav ? 'text-[#FF4D6D]' : 'text-[#8E929B] hover:text-white'
                    }`}
                  >
                    <Heart className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
                  </button>

                  {/* Three-dot Song Menu */}
                  <div className="relative" data-song-menu-root="true">
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        setOpenMenuTrackId((prev) => (prev === track.id ? null : track.id));
                      }}
                      aria-label={`More options for ${track.title}`}
                      aria-expanded={isMenuOpen}
                      aria-haspopup="menu"
                      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors cursor-pointer ${
                        isMenuOpen
                          ? 'bg-[#1D202A] text-white'
                          : 'text-[#8E929B] hover:bg-[#1C1E27] hover:text-white'
                      }`}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>

                    {isMenuOpen && (
                      <div
                        role="menu"
                        aria-label={`Actions for ${track.title}`}
                        className="kago-panel-enter absolute right-0 top-9 z-40 w-48 rounded-xl border border-[#282B36] bg-[#12141B] p-1.5 shadow-[0_14px_34px_rgba(0,0,0,0.88)]"
                      >
                        {onPlayNext && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              triggerHaptic('selection');
                              onPlayNext(track);
                              setOpenMenuTrackId(null);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:bg-[#1A1D26] cursor-pointer"
                          >
                            <ListStart className="h-3.5 w-3.5 text-[#E11D48]" />
                            <span>Play Next</span>
                          </button>
                        )}

                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            triggerHaptic('selection');
                            onAddToQueue(track);
                            setOpenMenuTrackId(null);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:bg-[#1A1D26] cursor-pointer"
                        >
                          <ListPlus className="h-3.5 w-3.5 text-[#E11D48]" />
                          <span>Add to Queue</span>
                        </button>

                        {playlists.length > 0 && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              triggerHaptic('light');
                              setAssigningTrackId((prev) => (prev === track.id ? null : track.id));
                              setOpenMenuTrackId(null);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:bg-[#1A1D26] cursor-pointer"
                          >
                            <Plus className="h-3.5 w-3.5 text-[#E11D48]" />
                            <span>Add to Playlist</span>
                          </button>
                        )}

                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            triggerHaptic('light');
                            setIsSelectMode(true);
                            setSelectedTrackIds((prev) =>
                              prev.includes(track.id) ? prev : [...prev, track.id]
                            );
                            setOpenMenuTrackId(null);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:bg-[#1A1D26] cursor-pointer"
                        >
                          <CheckSquare className="h-3.5 w-3.5 text-[#E11D48]" />
                          <span>Select Multiple</span>
                        </button>

                        {isStreamDownloadableTrack(track) &&
                          (track.isAppDownload ? (
                            <>
                              {onRequestDownloadTrackFormats && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    triggerHaptic('light');
                                    setOpenMenuTrackId(null);
                                    onRequestDownloadTrackFormats(track);
                                  }}
                                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:bg-[#1A1D26] cursor-pointer"
                                >
                                  <FolderDown className="h-3.5 w-3.5 text-[#E11D48]" />
                                  <span>Download Locally</span>
                                </button>
                              )}
                              {onRemoveAppDownloads && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    triggerHaptic('medium');
                                    setOpenMenuTrackId(null);
                                    onRemoveAppDownloads([track.id]);
                                  }}
                                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[#FBBF24] hover:bg-[#1A1D26] cursor-pointer"
                                >
                                  <Smartphone className="h-3.5 w-3.5" />
                                  <span>Remove Offline Copy</span>
                                </button>
                              )}
                            </>
                          ) : (
                            onRequestDownloadTrack && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  triggerHaptic('light');
                                  setOpenMenuTrackId(null);
                                  onRequestDownloadTrack(track);
                                }}
                                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[#F4F3F0] hover:bg-[#1A1D26] cursor-pointer"
                              >
                                <Download className="h-3.5 w-3.5 text-[#E11D48]" />
                                <span>Download</span>
                              </button>
                            )
                          ))}

                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            handleDeleteIds([track.id]);
                            setOpenMenuTrackId(null);
                          }}
                          className="mt-0.5 flex w-full items-center gap-2.5 rounded-lg border-t border-[#1E212B] px-3 py-2 text-left text-xs font-semibold text-[#FF4D6D] hover:bg-[#230E16] cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>Delete Song</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {assigningTrackId === track.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="kago-panel-enter mt-2 flex w-full flex-wrap items-center gap-2 border-t border-[#1D1F28] pt-2"
                  >
                    <span className="text-xs text-[#8E929B]">Add to playlist:</span>
                    {playlists.map((pl) => (
                      <button
                        key={pl.id}
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          onAddTrackToPlaylist(pl.id, track.id);
                          setAssigningTrackId(null);
                        }}
                        className="rounded border border-[#2B2E3B] bg-[#15171E] px-2.5 py-1 text-xs font-medium text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                      >
                        {pl.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Actions */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#F4F3F0]">Offline Music Library</h1>
            <p className="mt-1 font-mono-tabular text-xs text-[#8E929B]">
              {tracks.length} saved {tracks.length === 1 ? 'song' : 'songs'} · {playlists.length}{' '}
              {playlists.length === 1 ? 'playlist' : 'playlists'} · {favoriteTracks.length}{' '}
              {favoriteTracks.length === 1 ? 'favorite' : 'favorites'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onOpenLiveStudio();
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white shadow-[0_0_16px_rgba(225,29,72,0.45)] hover:bg-[#BE123C] transition-colors whitespace-nowrap cursor-pointer"
            >
              <Radio className="h-4 w-4" />
              <span>Shared Live Studio</span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onPickSong();
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-4 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors whitespace-nowrap cursor-pointer"
            >
              <Music className="h-4 w-4 text-[#E11D48]" />
              <span>Pick Song</span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onPickFolder();
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-4 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors whitespace-nowrap cursor-pointer"
            >
              <FolderOpen className="h-4 w-4 text-[#E11D48]" />
              <span>Pick Folder</span>
            </button>
          </div>
        </div>

        {/* 6 Sub-Tabs */}
        <div
          role="tablist"
          aria-label="Library sections"
          className="mt-5 flex flex-wrap items-center gap-1.5 border-t border-[#1C1E26] pt-4"
        >
          {SUB_TABS.map((tab) => {
            const active = subTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  triggerHaptic('light');
                  setSubTab(tab.id);
                  setSelectedGroup(null);
                  setSelectedPlaylistId(null);
                  setOpenMenuTrackId(null);
                  exitSelectMode();
                  exitPlaylistSelectMode();
                }}
                className={`rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'border-[#E11D48] bg-[#E11D48]/15 text-[#FF4D6D]'
                    : 'border-[#232631] bg-[#13151B] text-[#8E929B] hover:text-[#F4F3F0]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Tab Content */}
      <div
        key={`${subTab}-${selectedGroup || selectedPlaylistId || 'root'}`}
        className="kago-panel-enter"
      >
        {subTab === 'all' && renderTrackRows(tracks)}

        {subTab === 'downloads' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 shrink-0 text-[#10B981]" />
                  <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
                    App Offline Downloads
                  </h2>
                </div>
                <p className="mt-0.5 text-xs text-[#8E929B]">
                  Saved inside kaGO.PIaY app storage for 100% offline playback (hidden from device Downloads).
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono-tabular text-xs font-semibold text-[#10B981]">
                  {downloadedTracks.length} {downloadedTracks.length === 1 ? 'song' : 'songs'} ·{' '}
                  {formatByteSize(downloadedBytesTotal)}
                </span>
                {downloadedTracks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('selection');
                      if (onPlayCollection) {
                        onPlayCollection(downloadedTracks, 0);
                      } else {
                        onPlayTrack(downloadedTracks[0]);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    <span>Play All</span>
                  </button>
                )}
              </div>
            </div>

            {downloadedTracks.length === 0 ? (
              <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-10 text-center">
                <Download className="mx-auto h-8 w-8 text-[#E11D48]" />
                <p className="mt-3 text-sm font-semibold text-[#F4F3F0]">
                  No offline app downloads yet
                </p>
                <p className="mt-1 text-xs text-[#8E929B]">
                  Tap the Download button on any streamed song, album, playlist, or YouTube mix and choose Save to App Downloads.
                </p>
              </div>
            ) : (
              renderTrackRows(downloadedTracks)
            )}
          </div>
        )}

        {subTab === 'favorites' && renderTrackRows(favoriteTracks)}

        {subTab === 'playlists' && (
          <div className="space-y-4">
            {activePlaylist ? (
              (() => {
                const plTracks = tracks.filter((t) => activePlaylist.trackIds.includes(t.id));
                const downloadablePlTracks = plTracks.filter(isStreamDownloadableTrack);
                return (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h2 className="font-display text-lg font-bold text-[#F4F3F0]">
                          {activePlaylist.name}
                        </h2>
                        {activePlaylist.description && (
                          <p className="text-xs text-[#8E929B]">{activePlaylist.description}</p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {downloadablePlTracks.length > 0 && onRequestDownloadCollection && (
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('selection');
                              onRequestDownloadCollection({
                                title: activePlaylist.name,
                                artist: activePlaylist.description || 'Playlist',
                                tracks: downloadablePlTracks,
                                collectionType: 'Playlist Download',
                              });
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap"
                          >
                            <Download className="h-3.5 w-3.5 text-[#E11D48]" />
                            <span>Download Playlist</span>
                          </button>
                        )}
                        {plTracks.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('selection');
                              if (onPlayCollection) {
                                onPlayCollection(plTracks, 0);
                              } else {
                                onPlayTrack(plTracks[0]);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap"
                          >
                            <Play className="h-3.5 w-3.5 fill-current" />
                            <span>Play All</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('light');
                            setSelectedPlaylistId(null);
                            exitSelectMode();
                          }}
                          className="rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs text-[#D1D5DB] hover:border-[#E11D48] cursor-pointer whitespace-nowrap"
                        >
                          Back to all playlists
                        </button>
                      </div>
                    </div>
                    {renderTrackRows(plTracks)}
                  </div>
                );
              })()
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-3">
                    <h2 className="font-display text-lg font-bold text-[#F4F3F0]">Custom Playlists</h2>
                    {isPlaylistSelectMode && (
                      <span className="font-mono-tabular text-xs font-semibold text-[#FF4D6D]">
                        {selectedPlaylistIds.length} selected
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {playlists.length > 0 && (
                      isPlaylistSelectMode ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('light');
                              if (selectedPlaylistIds.length === playlists.length) {
                                setSelectedPlaylistIds([]);
                              } else {
                                setSelectedPlaylistIds(playlists.map((p) => p.id));
                              }
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-semibold text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer whitespace-nowrap"
                          >
                            <span>
                              {selectedPlaylistIds.length === playlists.length ? 'Deselect All' : 'Select All'}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('light');
                              exitPlaylistSelectMode();
                            }}
                            className="rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-2 text-xs font-semibold text-[#9CA3AF] hover:text-white cursor-pointer whitespace-nowrap"
                          >
                            Done
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('light');
                            setIsPlaylistSelectMode(true);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#D1D5DB] hover:border-[#E11D48] hover:text-white cursor-pointer whitespace-nowrap"
                        >
                          <CheckSquare className="h-3.5 w-3.5 text-[#E11D48]" />
                          <span>Select Multiple</span>
                        </button>
                      )
                    )}

                    {onImportYouTubePlaylist && !isPlaylistSelectMode && (
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          setYtImportError('');
                          setShowImportYtModal(true);
                        }}
                        className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap"
                      >
                        <Download className="h-3.5 w-3.5 text-[#E11D48]" />
                        <span>Import YouTube Playlist</span>
                      </button>
                    )}

                    {!isPlaylistSelectMode && (
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          setShowNewPlaylistModal(true);
                        }}
                        className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap"
                      >
                        <Plus className="h-4 w-4" />
                        <span>New Playlist</span>
                      </button>
                    )}
                  </div>
                </div>

                {playlists.length === 0 ? (
                  <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-10 text-center">
                    <ListMusic className="mx-auto h-8 w-8 text-[#E11D48]" />
                    <p className="mt-2 text-sm text-[#8E929B]">
                      No playlists created yet. Create an offline mix or import a YouTube playlist.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {playlists.map((pl) => {
                      const plTracks = tracks.filter((t) => pl.trackIds.includes(t.id));
                      const isPlSelected = selectedPlaylistIdSet.has(pl.id);
                      const plSelectionActive = isPlaylistSelectMode || selectedPlaylistIds.length > 0;
                      return (
                        <div
                          key={pl.id}
                          onClick={() => {
                            if (plSelectionActive) {
                              togglePlaylistSelection(pl.id);
                            } else {
                              triggerHaptic('light');
                              setSelectedPlaylistId(pl.id);
                              exitSelectMode();
                            }
                          }}
                          className={`flex flex-col justify-between rounded-xl border p-4 transition-colors cursor-pointer ${
                            isPlSelected
                              ? 'border-[#E11D48] bg-[#1D0B12]'
                              : 'border-[#1F2129] bg-[#0D0E12] hover:border-[#E11D48]/60'
                          }`}
                        >
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex min-w-0 items-start gap-2.5">
                                {plSelectionActive && (
                                  <button
                                    type="button"
                                    role="checkbox"
                                    aria-checked={isPlSelected}
                                    aria-label={`Select playlist ${pl.name}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      togglePlaylistSelection(pl.id);
                                    }}
                                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors cursor-pointer ${
                                      isPlSelected
                                        ? 'border-[#E11D48] bg-[#E11D48] text-white'
                                        : 'border-[#323644] bg-[#0A0B0F] text-transparent hover:border-[#E11D48]'
                                    }`}
                                  >
                                    <Check className="h-3.5 w-3.5 stroke-[2.75]" />
                                  </button>
                                )}
                                <div className="min-w-0">
                                  <h3 className="truncate font-display text-base font-bold text-[#F4F3F0]">
                                    {pl.name}
                                  </h3>
                                  <p className="mt-0.5 text-xs text-[#8E929B]">
                                    {pl.description || 'Custom offline playlist'}
                                  </p>
                                </div>
                              </div>
                              {!plSelectionActive && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    triggerHaptic('light');
                                    onDeletePlaylist(pl.id);
                                  }}
                                  aria-label={`Delete playlist ${pl.name}`}
                                  className="text-[#8E929B] hover:text-[#FF4D6D] cursor-pointer"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                            <p className="mt-3 font-mono-tabular text-xs text-[#FF4D6D]">
                              {plTracks.length} {plTracks.length === 1 ? 'track' : 'tracks'}
                            </p>
                          </div>

                          {plTracks.length > 0 && !plSelectionActive && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                triggerHaptic('selection');
                                if (onPlayCollection) {
                                  onPlayCollection(plTracks, 0);
                                } else {
                                  onPlayTrack(plTracks[0]);
                                }
                              }}
                              className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
                            >
                              <Play className="h-3.5 w-3.5 fill-current text-[#E11D48]" />
                              <span>Play Playlist</span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {(subTab === 'folders' || subTab === 'albums' || subTab === 'artists') && (
          <div className="space-y-4">
            {(() => {
              const groups =
                subTab === 'folders'
                  ? folderGroups
                  : subTab === 'albums'
                  ? albumGroups
                  : artistGroups;
              const activeTracks = selectedGroup
                ? groups.find(([name]) => name === selectedGroup)?.[1] || []
                : null;

              if (activeTracks) {
                return (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="font-display text-lg font-bold text-[#F4F3F0]">
                        {selectedGroup}
                      </h2>
                      <div className="flex items-center gap-2">
                        {activeTracks.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('selection');
                              if (onPlayCollection) {
                                onPlayCollection(activeTracks, 0);
                              } else {
                                onPlayTrack(activeTracks[0]);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap"
                          >
                            <Play className="h-3.5 w-3.5 fill-current" />
                            <span>Play All</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('light');
                            setSelectedGroup(null);
                            exitSelectMode();
                          }}
                          className="rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs text-[#D1D5DB] hover:border-[#E11D48] cursor-pointer whitespace-nowrap"
                        >
                          Back to all {subTab}
                        </button>
                      </div>
                    </div>
                    {renderTrackRows(activeTracks)}
                  </div>
                );
              }

              return (
                <div className="space-y-4">
                  {subTab === 'folders' && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="font-display text-lg font-bold text-[#F4F3F0]">
                        Imported Folders
                      </h2>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onPickFolder();
                        }}
                        className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        <span>Upload Folder</span>
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {groups.map(([groupName, groupTracks]) => (
                      <button
                        key={groupName}
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          setSelectedGroup(groupName);
                          exitSelectMode();
                        }}
                        className="kago-press-subtle flex items-center gap-3 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
                      >
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#252834] bg-[#14161E] text-[#E11D48]">
                          {subTab === 'folders' ? (
                            <Folder className="h-5 w-5" />
                          ) : subTab === 'albums' ? (
                            <Disc3 className="h-5 w-5" />
                          ) : (
                            <User className="h-5 w-5" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate font-display text-sm font-bold text-[#F4F3F0]">
                            {groupName}
                          </h3>
                          <p className="mt-0.5 font-mono-tabular text-xs text-[#8E929B]">
                            {groupTracks.length} {groupTracks.length === 1 ? 'track' : 'tracks'}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* New Playlist Modal */}
      {showNewPlaylistModal && (
        <div
          className="kago-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-playlist-title"
        >
          <div className="kago-sheet-slide w-full max-w-md rounded-xl border border-[#242732] bg-[#0D0E12] p-6">
            <div className="flex items-center justify-between">
              <h2 id="new-playlist-title" className="font-display text-lg font-bold text-[#F4F3F0]">
                New Offline Playlist
              </h2>
              <button
                type="button"
                onClick={() => setShowNewPlaylistModal(false)}
                aria-label="Close new playlist dialog"
                className="text-[#8E929B] hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreatePlaylistSubmit} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="playlist-name-input"
                  className="block text-xs font-semibold text-[#C7C9D1]"
                >
                  Playlist Name
                </label>
                <input
                  id="playlist-name-input"
                  type="text"
                  value={playlistName}
                  onChange={(e) => {
                    setPlaylistName(e.target.value);
                    setPlaylistError('');
                  }}
                  placeholder="Night Drive Stems"
                  className="mt-1.5 w-full rounded-lg border border-[#262936] bg-[#07080B] px-3 py-2 text-sm text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none"
                />
                {playlistError && (
                  <p className="mt-1 text-xs text-[#FF4D6D]">{playlistError}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="playlist-desc-input"
                  className="block text-xs font-semibold text-[#C7C9D1]"
                >
                  Description (optional)
                </label>
                <input
                  id="playlist-desc-input"
                  type="text"
                  value={playlistDesc}
                  onChange={(e) => setPlaylistDesc(e.target.value)}
                  placeholder="Heavy bass hardware cuts"
                  className="mt-1.5 w-full rounded-lg border border-[#262936] bg-[#07080B] px-3 py-2 text-sm text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewPlaylistModal(false)}
                  className="rounded-lg border border-[#282B36] bg-[#14161D] px-4 py-2 text-xs font-semibold text-[#D1D5DB] hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-[#E11D48] px-5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                >
                  Create Playlist
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import YouTube Playlist Modal */}
      {showImportYtModal && (
        <div
          className="kago-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-yt-playlist-title"
        >
          <div className="kago-sheet-slide w-full max-w-md rounded-xl border border-[#242732] bg-[#0D0E12] p-6">
            <div className="flex items-center justify-between">
              <h2
                id="import-yt-playlist-title"
                className="font-display text-lg font-bold text-[#F4F3F0]"
              >
                Import YouTube Playlist
              </h2>
              <button
                type="button"
                onClick={() => !isImportingYt && setShowImportYtModal(false)}
                aria-label="Close import YouTube playlist dialog"
                className="text-[#8E929B] hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-1.5 text-xs text-[#8E929B]">
              Paste a link or ID from a public or unlisted YouTube or YouTube Music playlist to add its songs here.
            </p>

            <form onSubmit={(e) => void handleImportYtSubmit(e)} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="yt-playlist-url-input"
                  className="block text-xs font-semibold text-[#C7C9D1]"
                >
                  YouTube Playlist Link or ID
                </label>
                <input
                  id="yt-playlist-url-input"
                  type="text"
                  value={ytPlaylistUrl}
                  onChange={(e) => {
                    setYtPlaylistUrl(e.target.value);
                    setYtImportError('');
                  }}
                  placeholder="https://www.youtube.com/playlist?list=PL..."
                  disabled={isImportingYt}
                  className="mt-1.5 w-full rounded-lg border border-[#262936] bg-[#07080B] px-3 py-2 text-sm text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none disabled:opacity-60"
                />
                {ytImportError && (
                  <p className="mt-1 text-xs text-[#FF4D6D]">{ytImportError}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="yt-playlist-name-input"
                  className="block text-xs font-semibold text-[#C7C9D1]"
                >
                  Custom Name (optional)
                </label>
                <input
                  id="yt-playlist-name-input"
                  type="text"
                  value={ytCustomName}
                  onChange={(e) => setYtCustomName(e.target.value)}
                  placeholder="Uses YouTube playlist title if blank"
                  disabled={isImportingYt}
                  className="mt-1.5 w-full rounded-lg border border-[#262936] bg-[#07080B] px-3 py-2 text-sm text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={isImportingYt}
                  onClick={() => setShowImportYtModal(false)}
                  className="rounded-lg border border-[#282B36] bg-[#14161D] px-4 py-2 text-xs font-semibold text-[#D1D5DB] hover:text-white cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isImportingYt}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer disabled:opacity-60"
                >
                  {isImportingYt ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Importing...</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-3.5 w-3.5" />
                      <span>Import Playlist</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Action Confirmation Toast & Floating Bulk Action Toolbar (Portaled to viewport) */}
      {typeof document !== 'undefined' &&
        createPortal(
          <>
            {bulkActionFeedback && (
              <div
                role="status"
                aria-live="polite"
                className={`kago-panel-enter fixed left-1/2 -translate-x-1/2 z-40 rounded-lg border border-[#E11D48]/50 bg-[#12141B]/95 px-4 py-2 text-xs font-semibold text-[#F4F3F0] shadow-[0_12px_30px_rgba(0,0,0,0.85)] backdrop-blur-md whitespace-nowrap ${
                  engine.currentTrack
                    ? 'bottom-[calc(10rem+env(safe-area-inset-bottom))] md:bottom-24'
                    : 'bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:bottom-6'
                }`}
              >
                {bulkActionFeedback}
              </div>
            )}

            {(selectedTrackObjects.length > 0 ||
              (subTab === 'playlists' && !activePlaylist && selectedPlaylistIds.length > 0)) && (
              <div
                role="region"
                aria-label="Bulk selection actions"
                data-testid="bulk-selection-toolbar"
                className={`kago-sheet-slide fixed left-3 right-3 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:min-w-[34rem] sm:max-w-[92vw] z-40 rounded-2xl border border-[#E11D48]/60 bg-[#11131A]/95 px-3.5 py-2.5 shadow-[0_22px_54px_rgba(0,0,0,0.92)] backdrop-blur-md ${
                  engine.currentTrack
                    ? 'bottom-[calc(9.75rem+env(safe-area-inset-bottom))] md:bottom-24'
                    : 'bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-6'
                }`}
              >
                {/* Upward Add-to-Playlist Picker Popover */}
                {showBulkPlaylistPicker && selectedTrackObjects.length > 0 && (
                  <div className="kago-panel-enter mb-2.5 rounded-xl border border-[#282B36] bg-[#0B0C11] p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-semibold text-[#F4F3F0]">
                        Add {selectedTrackObjects.length}{' '}
                        {selectedTrackObjects.length === 1 ? 'song' : 'songs'} to playlist
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowBulkPlaylistPicker(false)}
                        aria-label="Close playlist picker"
                        className="text-[#8E929B] hover:text-white cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {playlists.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2.5 max-h-28 overflow-y-auto">
                        {playlists.map((pl) => (
                          <button
                            key={pl.id}
                            type="button"
                            onClick={() => {
                              handleAddTracksBatchToPlaylist(pl.id, selectedTrackObjects);
                              exitSelectMode();
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B2E3B] bg-[#151822] px-3 py-1.5 text-xs font-medium text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap"
                          >
                            <ListMusic className="h-3 w-3 text-[#E11D48]" />
                            <span>{pl.name}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {onCreatePlaylistWithTracks && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const clean = bulkNewPlaylistName.trim();
                          if (!clean) return;
                          onCreatePlaylistWithTracks(
                            clean,
                            `Created from ${selectedTrackObjects.length} selected songs`,
                            selectedTrackObjects
                          );
                          setBulkActionFeedback(
                            `Created "${clean}" with ${selectedTrackObjects.length} songs.`
                          );
                          exitSelectMode();
                        }}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="text"
                          value={bulkNewPlaylistName}
                          onChange={(e) => setBulkNewPlaylistName(e.target.value)}
                          placeholder="New playlist name..."
                          aria-label="New playlist name"
                          className="flex-1 rounded-lg border border-[#262936] bg-[#07080B] px-3 py-1.5 text-xs text-[#F4F3F0] placeholder-[#6B7280] focus:border-[#E11D48] focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={!bulkNewPlaylistName.trim()}
                          className="rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-40 cursor-pointer whitespace-nowrap"
                        >
                          Create &amp; Add
                        </button>
                      </form>
                    )}
                  </div>
                )}

                {subTab === 'playlists' && !activePlaylist && selectedPlaylistIds.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono-tabular text-xs font-semibold text-[#FF4D6D] whitespace-nowrap">
                      {selectedPlaylistIds.length}{' '}
                      {selectedPlaylistIds.length === 1 ? 'playlist' : 'playlists'} selected
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {(onPlayMultipleNext || onPlayNext) && (
                        <button
                          type="button"
                          onClick={() => {
                            const chosenPlaylists = playlists.filter((p) =>
                              selectedPlaylistIdSet.has(p.id)
                            );
                            const plTrackIds = new Set(chosenPlaylists.flatMap((p) => p.trackIds));
                            const chosenTracks = tracks.filter((t) => plTrackIds.has(t.id));
                            if (chosenTracks.length > 0) {
                              handlePlayTracksBatchNext(chosenTracks);
                            }
                            exitPlaylistSelectMode();
                          }}
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#161922] px-3 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <ListStart className="h-3.5 w-3.5 text-[#E11D48]" />
                          <span>Play Next</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const chosenPlaylists = playlists.filter((p) =>
                            selectedPlaylistIdSet.has(p.id)
                          );
                          const plTrackIds = new Set(chosenPlaylists.flatMap((p) => p.trackIds));
                          const chosenTracks = tracks.filter((t) => plTrackIds.has(t.id));
                          if (chosenTracks.length > 0) {
                            handleAddTracksBatchToQueue(chosenTracks);
                          }
                          exitPlaylistSelectMode();
                        }}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#161922] px-3 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <ListPlus className="h-3.5 w-3.5 text-[#E11D48]" />
                        <span>Add to Queue</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleDeleteSelectedPlaylists(selectedPlaylistIds);
                          exitPlaylistSelectMode();
                        }}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Delete ({selectedPlaylistIds.length})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          exitPlaylistSelectMode();
                        }}
                        aria-label="Clear playlist selection"
                        className="flex min-h-[40px] w-10 items-center justify-center rounded-lg border border-[#282B36] bg-[#161922] text-[#9CA3AF] hover:text-white cursor-pointer shrink-0"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono-tabular text-xs font-semibold text-[#FF4D6D] whitespace-nowrap">
                      {selectedTrackObjects.length} selected
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {(onPlayMultipleNext || onPlayNext) && (
                        <button
                          type="button"
                          onClick={() => {
                            handlePlayTracksBatchNext(selectedTrackObjects);
                            exitSelectMode();
                          }}
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#161922] px-3 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <ListStart className="h-3.5 w-3.5 text-[#E11D48]" />
                          <span>Play Next</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          handleAddTracksBatchToQueue(selectedTrackObjects);
                          exitSelectMode();
                        }}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#161922] px-3 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <ListPlus className="h-3.5 w-3.5 text-[#E11D48]" />
                        <span>Add to Queue</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          setShowBulkPlaylistPicker((prev) => !prev);
                        }}
                        aria-expanded={showBulkPlaylistPicker}
                        className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 ${
                          showBulkPlaylistPicker
                            ? 'border-[#E11D48] bg-[#E11D48]/15 text-[#FF4D6D]'
                            : 'border-[#282B36] bg-[#161922] text-[#F4F3F0] hover:border-[#E11D48]'
                        }`}
                      >
                        <Plus className="h-3.5 w-3.5 text-[#E11D48]" />
                        <span>Add to Playlist</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          handleDeleteIds(selectedTrackObjects.map((t) => t.id));
                          exitSelectMode();
                        }}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Delete ({selectedTrackObjects.length})</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          exitSelectMode();
                        }}
                        aria-label="Clear selection"
                        className="flex min-h-[40px] w-10 items-center justify-center rounded-lg border border-[#282B36] bg-[#161922] text-[#9CA3AF] hover:text-white cursor-pointer shrink-0"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>,
          document.body
        )}
    </div>
  );
};

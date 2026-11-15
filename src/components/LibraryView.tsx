import React, { useMemo, useState } from 'react';
import {
  Disc3,
  Folder,
  FolderOpen,
  Heart,
  ListMusic,
  ListPlus,
  Music,
  Pause,
  Play,
  Plus,
  Radio,
  Trash2,
  User,
  X,
} from 'lucide-react';
import type { AudioEngineSnapshot, LibrarySubTab, Playlist, Track } from '../types/audio';
import { triggerHaptic } from '../utils/haptics';
import { formatDuration } from '../utils/lrcParser';

interface LibraryViewProps {
  tracks: Track[];
  playlists: Playlist[];
  favoriteIds: string[];
  engine: AudioEngineSnapshot;
  onPlayTrack: (track: Track) => void;
  onPlayCollection?: (tracks: Track[], startIndex: number) => void;
  onTogglePlay: () => void;
  onAddToQueue: (track: Track) => void;
  onToggleFavorite: (trackId: string) => void;
  onPickSong: () => void;
  onPickFolder: () => void;
  onOpenLiveStudio: () => void;
  onCreatePlaylist: (name: string, description: string) => void;
  onDeletePlaylist: (playlistId: string) => void;
  onAddTrackToPlaylist: (playlistId: string, trackId: string) => void;
  onDeleteTrack: (trackId: string) => void;
}

const SUB_TABS: Array<{ id: LibrarySubTab; label: string }> = [
  { id: 'all', label: 'All Songs' },
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
  onPlayTrack,
  onPlayCollection,
  onTogglePlay,
  onAddToQueue,
  onToggleFavorite,
  onPickSong,
  onPickFolder,
  onOpenLiveStudio,
  onCreatePlaylist,
  onDeletePlaylist,
  onAddTrackToPlaylist,
  onDeleteTrack,
}) => {
  const [subTab, setSubTab] = useState<LibrarySubTab>('all');
  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [playlistDesc, setPlaylistDesc] = useState('');
  const [playlistError, setPlaylistError] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [assigningTrackId, setAssigningTrackId] = useState<string | null>(null);

  const favoriteTracks = useMemo(
    () => tracks.filter((t) => favoriteIds.includes(t.id)),
    [tracks, favoriteIds]
  );

  const folderGroups = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const t of tracks) {
      const key = t.folderPath || (t.source === 'synth' ? 'Offline Stems' : 'Imported Files');
      map.set(key, [...(map.get(key) || []), t]);
    }
    return Array.from(map.entries());
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

  const renderTrackRows = (list: Track[]) => {
    if (list.length === 0) {
      return (
        <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-10 text-center">
          <p className="text-sm text-[#8E929B]">No tracks in this view yet.</p>
          <button
            type="button"
            onClick={onPickSong}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
          >
            <Music className="h-3.5 w-3.5" />
            <span>Pick Song</span>
          </button>
        </div>
      );
    }

    const playRowInList = (track: Track, listIdx: number) => {
      if (!onPlayCollection) {
        onPlayTrack(track);
        return;
      }
      if (track.source !== 'synth') {
        const userOnlyList = list.filter((t) => t.source !== 'synth');
        const userIdx = userOnlyList.findIndex((t) => t.id === track.id);
        if (userOnlyList.length > 0 && userIdx >= 0) {
          onPlayCollection(userOnlyList, userIdx);
          return;
        }
      }
      onPlayCollection(list, listIdx);
    };

    return (
      <div className="divide-y divide-[#1A1C24] rounded-xl border border-[#1F2129] bg-[#0D0E12] overflow-hidden">
        {list.map((track, listIdx) => {
          const isCurrent = engine.currentTrack?.id === track.id;
          const isPlaying = isCurrent && engine.isPlaying;
          const isFav = favoriteIds.includes(track.id);

          return (
            <div
              key={track.id}
              className={`flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 px-4 py-3 transition-colors ${
                isCurrent ? 'bg-[#17090E]' : 'hover:bg-[#13151C]'
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
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
                    {track.source === 'synth' && (
                      <span className="font-mono-tabular text-[10px] font-semibold uppercase text-[#FF4D6D]">
                        SYNTH
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-[#8E929B]">
                    <span className="truncate">{track.artist}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{track.album}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <span className="mr-2 font-mono-tabular text-xs text-[#8E929B]">
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

                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('selection');
                    onAddToQueue(track);
                  }}
                  aria-label={`Add ${track.title} to queue`}
                  title="Add to Queue"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[#8E929B] hover:bg-[#1C1E27] hover:text-white cursor-pointer"
                >
                  <ListPlus className="h-4 w-4" />
                </button>

                {playlists.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      setAssigningTrackId((prev) => (prev === track.id ? null : track.id));
                    }}
                    aria-label={`Add ${track.title} to playlist`}
                    title="Add to Playlist"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[#8E929B] hover:bg-[#1C1E27] hover:text-white cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}

                {track.source !== 'synth' && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      onDeleteTrack(track.id);
                    }}
                    aria-label={`Delete ${track.title}`}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[#8E929B] hover:text-[#FF4D6D] cursor-pointer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>

              {assigningTrackId === track.id && (
                <div className="kago-panel-enter mt-2 flex w-full flex-wrap items-center gap-2 border-t border-[#1D1F28] pt-2">
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
      <div key={`${subTab}-${selectedGroup || 'root'}`} className="kago-panel-enter">
      {subTab === 'all' && renderTrackRows(tracks)}
      {subTab === 'favorites' && renderTrackRows(favoriteTracks)}

      {subTab === 'playlists' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-[#F4F3F0]">Custom Playlists</h2>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setShowNewPlaylistModal(true);
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>New Playlist</span>
            </button>
          </div>

          {playlists.length === 0 ? (
            <div className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-10 text-center">
              <ListMusic className="mx-auto h-8 w-8 text-[#E11D48]" />
              <p className="mt-2 text-sm text-[#8E929B]">
                No playlists created yet. Build an offline mix stored in IndexedDB.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {playlists.map((pl) => {
                const plTracks = tracks.filter((t) => pl.trackIds.includes(t.id));
                return (
                  <div
                    key={pl.id}
                    className="flex flex-col justify-between rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-display text-base font-bold text-[#F4F3F0]">
                            {pl.name}
                          </h3>
                          <p className="mt-0.5 text-xs text-[#8E929B]">
                            {pl.description || 'Custom offline playlist'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('light');
                            onDeletePlaylist(pl.id);
                          }}
                          aria-label={`Delete playlist ${pl.name}`}
                          className="text-[#8E929B] hover:text-[#FF4D6D] cursor-pointer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <p className="mt-3 font-mono-tabular text-xs text-[#FF4D6D]">
                        {plTracks.length} {plTracks.length === 1 ? 'track' : 'tracks'}
                      </p>
                    </div>

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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {groups.map(([groupName, groupTracks]) => (
                  <button
                    key={groupName}
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      setSelectedGroup(groupName);
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
    </div>
  );
};

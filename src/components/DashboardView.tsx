import React, { useState } from 'react';
import {
  Disc,
  Disc3,
  FolderOpen,
  Mic2,
  Music,
  Pause,
  Play,
  Radio,
  Sliders,
  Video,
} from 'lucide-react';
import type { ActiveTab, AudioEngineSnapshot, DspSettings, Track } from '../types/audio';
import { triggerHaptic } from '../utils/haptics';
import { SpectrumVisualizer } from './SpectrumVisualizer';
import { VinylTurntable } from './VinylTurntable';
import { WatchVideoViewport } from './WatchVideoViewport';

interface DashboardViewProps {
  engine: AudioEngineSnapshot;
  dsp: DspSettings;
  storedTrackCount: number;
  recentTracks: Track[];
  isInAppPip: boolean;
  onToggleInAppPip: () => void;
  onQuickPlay: () => void;
  onTogglePlay: () => void;
  onPlayTrack: (track: Track) => void;
  onOpenDsp: () => void;
  onPickSong: () => void;
  onPickFolder: () => void;
  onNavigate: (tab: ActiveTab) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  engine,
  dsp,
  storedTrackCount,
  recentTracks,
  isInAppPip,
  onToggleInAppPip,
  onQuickPlay,
  onTogglePlay,
  onPlayTrack,
  onOpenDsp,
  onPickSong,
  onPickFolder,
  onNavigate,
}) => {
  const activeIsRunning = engine.isPlaying;
  const [deckMode, setDeckMode] = useState<'turntable' | 'video'>('turntable');

  return (
    <div className="space-y-6">
      {/* Hero Workstation Card */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-mono-tabular text-xs text-[#8E929B]">
              <span
                className={`h-2 w-2 rounded-full ${
                  activeIsRunning
                    ? 'bg-[#E11D48] shadow-[0_0_8px_#E11D48]'
                    : 'bg-[#4B5563]'
                }`}
              />
              <span>
                Active Channel {engine.activeChannel}
                {engine.currentTrack ? ` · ${engine.currentTrack.title}` : ' · Ready'}
                {engine.isCrossfading ? ' · Crossfading' : ''}
              </span>
            </div>
            <h1 className="mt-1.5 font-display text-2xl sm:text-4xl font-extrabold tracking-tight text-[#F4F3F0] text-balance">
              kaGO.PIaY Workstation
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium');
                if (engine.currentTrack) {
                  onTogglePlay();
                } else {
                  onQuickPlay();
                }
              }}
              className="inline-flex items-center gap-2.5 rounded-lg bg-[#E11D48] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(225,29,72,0.45)] hover:bg-[#BE123C] transition-colors whitespace-nowrap cursor-pointer"
            >
              {activeIsRunning ? (
                <>
                  <Pause className="h-4 w-4 fill-current" />
                  <span>Pause Engine</span>
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 fill-current" />
                  <span>Quick Play</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onOpenDsp();
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-4 py-2.5 text-sm font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors whitespace-nowrap cursor-pointer"
            >
              <Sliders className="h-4 w-4 text-[#E11D48]" />
              <span>Equalizer DSP</span>
            </button>
          </div>
        </div>

        {/* 60fps Live Frequency Spectrum Visualizer */}
        <div className="mt-5">
          <SpectrumVisualizer isPlaying={activeIsRunning} dsp={dsp} />
        </div>

        {/* 4 Quick-Action Cards Row */}
        <div className="mt-5 grid grid-cols-1 min-[340px]:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onPickSong();
            }}
            className="kago-press-subtle flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
          >
            <Music className="h-5 w-5 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0] truncate">Pick Song</div>
              <div className="text-xs text-[#8E929B] truncate">Local audio</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onPickFolder();
            }}
            className="kago-press-subtle flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
          >
            <FolderOpen className="h-5 w-5 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0] truncate">Pick Folder</div>
              <div className="text-xs text-[#8E929B] truncate">Scan folder</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onNavigate('stream');
            }}
            className="kago-press-subtle flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
          >
            <Radio className="h-5 w-5 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0] truncate">Free Stream</div>
              <div className="text-xs text-[#8E929B] truncate">Open tracks</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onNavigate('lyrics');
            }}
            className="kago-press-subtle flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
          >
            <Mic2 className="h-5 w-5 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0] truncate">Sync Lyrics</div>
              <div className="text-xs text-[#8E929B] truncate">LRC timing</div>
            </div>
          </button>
        </div>
      </section>

      {/* Turntable / Watch Video and Telemetry Split */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left (wider): Turntable + Watch Video Tab */}
        <div className="lg:col-span-7 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-5 flex flex-col justify-between gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E2028] pb-3">
            <div
              role="tablist"
              aria-label="Deck display mode"
              className="inline-flex items-center gap-1 rounded-lg border border-[#222530] bg-[#090A0E] p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={deckMode === 'turntable'}
                onClick={() => {
                  triggerHaptic('light');
                  setDeckMode('turntable');
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  deckMode === 'turntable'
                    ? 'bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                    : 'text-[#8E929B] hover:text-white'
                }`}
              >
                <Disc3 className="h-3.5 w-3.5" />
                <span>Turntable</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={deckMode === 'video'}
                onClick={() => {
                  triggerHaptic('light');
                  setDeckMode('video');
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  deckMode === 'video'
                    ? 'bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                    : 'text-[#8E929B] hover:text-white'
                }`}
              >
                <Video className="h-3.5 w-3.5" />
                <span>Watch Video</span>
                {engine.currentTrack?.youtubeId && (
                  <span className="h-1.5 w-1.5 rounded-full bg-[#FDA4AF]" />
                )}
              </button>
            </div>

            {engine.currentTrack?.youtubeId && deckMode === 'turntable' && (
              <span className="font-mono-tabular text-[11px] text-[#8E929B]">
                Background audio active
              </span>
            )}
          </div>

          <div className="flex-1 flex flex-col justify-center">
            {deckMode === 'turntable' ? (
              <div className="kago-panel-enter">
                <VinylTurntable
                  track={engine.currentTrack}
                  isPlaying={activeIsRunning}
                  onTogglePlay={() => {
                    triggerHaptic('light');
                    if (engine.currentTrack) {
                      onTogglePlay();
                    } else {
                      onQuickPlay();
                    }
                  }}
                />
              </div>
            ) : (
              <WatchVideoViewport
                track={engine.currentTrack}
                isPlaying={activeIsRunning}
                currentTime={engine.currentTime}
                zIndex={30}
                isInAppPip={isInAppPip}
                onToggleInAppPip={onToggleInAppPip}
                onOpenStream={() => onNavigate('stream')}
              />
            )}
          </div>
        </div>

        {/* Right: Audio Engine Status */}
        <div className="lg:col-span-5 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-[#1E2028] pb-3.5">
              <h2 className="font-display text-base font-bold text-[#F4F3F0]">
                Audio Engine Status
              </h2>
              <span className="font-mono-tabular text-xs font-semibold text-[#FF4D6D]">
                {activeIsRunning ? 'RUNNING' : 'IDLE'}
              </span>
            </div>

            <dl className="mt-3 divide-y divide-[#1A1C24] text-sm">
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#8E929B]">Synced Channels</dt>
                <dd className="font-mono-tabular font-semibold text-[#F4F3F0]">
                  {engine.syncedChannels} Channels (A / B)
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#8E929B]">Active Channel</dt>
                <dd className="font-mono-tabular font-semibold text-[#FF4D6D]">
                  Channel {engine.activeChannel}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#8E929B]">Crossfade Duration</dt>
                <dd className="font-mono-tabular font-semibold text-[#F4F3F0]">
                  {dsp.crossfadeSeconds <= 0 ? 'Off (0s)' : `${dsp.crossfadeSeconds.toFixed(1)}s`}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#8E929B]">Sample Rate</dt>
                <dd className="font-mono-tabular font-semibold text-[#F4F3F0]">
                  {engine.sampleRate} Hz
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#8E929B]">Active EQ Preset</dt>
                <dd className="font-mono-tabular font-semibold text-[#F4F3F0]">{dsp.preset}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#8E929B]">80 Hz Bass Boost</dt>
                <dd
                  className={`font-mono-tabular font-semibold ${
                    dsp.bassBoostEnabled ? 'text-[#FF4D6D]' : 'text-[#8E929B]'
                  }`}
                >
                  {dsp.bassBoostEnabled ? `Active (+${dsp.bassBoostDb} dB)` : 'Bypass'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#8E929B]">Stored Tracks</dt>
                <dd className="font-mono-tabular font-semibold text-[#F4F3F0]">
                  {storedTrackCount}
                </dd>
              </div>
            </dl>
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onOpenDsp();
            }}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-[#2A2D39] bg-[#14161D] py-2.5 text-sm font-semibold text-[#F4F3F0] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
          >
            <Sliders className="h-4 w-4 text-[#E11D48]" />
            <span>Adjust Equalizer &amp; Filter Sliders</span>
          </button>
        </div>
      </section>

      {/* Quick Library Tracks */}
      <section>
        <div className="mb-3.5 flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-[#F4F3F0]">
              Your Offline &amp; Saved Music
            </h2>
            <p className="text-xs text-[#8E929B]">
              {recentTracks.length > 0
                ? 'Jump back into your imported songs, folders, or saved playlists'
                : 'Import your own songs or folders, or explore live music in the Stream tab'}
            </p>
          </div>
          {recentTracks.length > 0 && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onNavigate('library');
              }}
              className="text-xs font-semibold text-[#FF4D6D] hover:underline cursor-pointer whitespace-nowrap"
            >
              Open Library
            </button>
          )}
        </div>

        {recentTracks.length === 0 ? (
          <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#252834] bg-[#14161E] text-[#E11D48]">
                <Music className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-display text-sm font-bold text-[#F4F3F0]">
                  Library is ready for your songs
                </h3>
                <p className="mt-0.5 text-xs text-[#8E929B]">
                  No preloaded sample tracks. Upload a music folder, pick songs, or stream online.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onPickFolder();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer whitespace-nowrap"
              >
                <FolderOpen className="h-3.5 w-3.5 text-[#E11D48]" />
                <span>Upload Folder</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onNavigate('stream');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer whitespace-nowrap"
              >
                <Radio className="h-3.5 w-3.5" />
                <span>Explore Stream</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {recentTracks.slice(0, 4).map((track) => {
              const isCurrent = engine.currentTrack?.id === track.id;
              const isTrackPlaying = isCurrent && engine.isPlaying;

              return (
                <div
                  key={track.id}
                  className={`flex flex-col justify-between rounded-xl border p-4 transition-colors ${
                    isCurrent
                      ? 'border-[#E11D48] bg-[#13090E]'
                      : 'border-[#1F2129] bg-[#0D0E12] hover:border-[#323646]'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono-tabular text-xs text-[#8E929B]">
                        {track.folderPath || track.album || 'Saved Track'}
                      </span>
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
                        aria-label={isTrackPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors cursor-pointer ${
                          isTrackPlaying
                            ? 'bg-[#E11D48] text-white shadow-[0_0_14px_rgba(225,29,72,0.55)]'
                            : 'border border-[#2A2D39] bg-[#161820] text-[#F4F3F0] hover:border-[#E11D48]'
                        }`}
                      >
                        {isTrackPlaying ? (
                          <Pause className="h-4 w-4 fill-current" />
                        ) : (
                          <Play className="h-4 w-4 fill-current ml-0.5" />
                        )}
                      </button>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      {track.artworkUrl ? (
                        <img
                          src={track.artworkUrl}
                          alt={track.title}
                          referrerPolicy="no-referrer"
                          className="h-11 w-11 shrink-0 rounded-md object-cover border border-[#252834]"
                        />
                      ) : (
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#161820]">
                          <Disc className="h-5 w-5 text-[#E11D48]" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <h3 className="font-display text-sm font-bold text-[#F4F3F0] truncate">
                          {track.title}
                        </h3>
                        <p className="text-xs text-[#8E929B] truncate">{track.artist}</p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

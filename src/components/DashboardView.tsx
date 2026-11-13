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
import { PROCEDURAL_STEMS } from '../data/presetsAndStems';
import type { ActiveTab, AudioEngineSnapshot, DspSettings, Track } from '../types/audio';
import { SpectrumVisualizer } from './SpectrumVisualizer';
import { VinylTurntable } from './VinylTurntable';
import { WatchVideoViewport } from './WatchVideoViewport';

interface DashboardViewProps {
  engine: AudioEngineSnapshot;
  dsp: DspSettings;
  storedTrackCount: number;
  isInAppPip: boolean;
  onToggleInAppPip: () => void;
  onQuickPlay: () => void;
  onTogglePlay: () => void;
  onPlayTrack: (track: Track) => void;
  onOpenDsp: () => void;
  onPickSong: () => void;
  onNavigate: (tab: ActiveTab) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  engine,
  dsp,
  storedTrackCount,
  isInAppPip,
  onToggleInAppPip,
  onQuickPlay,
  onTogglePlay,
  onPlayTrack,
  onOpenDsp,
  onPickSong,
  onNavigate,
}) => {
  const activeIsRunning = engine.isPlaying;
  const [deckMode, setDeckMode] = useState<'turntable' | 'video'>('turntable');

  return (
    <div className="space-y-6">
      {/* Hero Workstation Card */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
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
              onClick={engine.currentTrack ? onTogglePlay : onQuickPlay}
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
              onClick={onOpenDsp}
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
        <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={onPickSong}
            className="flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
          >
            <Music className="h-5 w-5 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0] truncate">Pick Song</div>
              <div className="text-xs text-[#8E929B] truncate">Local audio</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('scanner')}
            className="flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
          >
            <FolderOpen className="h-5 w-5 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0] truncate">Pick Folder</div>
              <div className="text-xs text-[#8E929B] truncate">Scan folder</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('stream')}
            className="flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
          >
            <Radio className="h-5 w-5 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0] truncate">Free Stream</div>
              <div className="text-xs text-[#8E929B] truncate">Open tracks</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('lyrics')}
            className="flex items-center gap-3 rounded-lg border border-[#222530] bg-[#13151C] px-3.5 py-3 text-left hover:border-[#E11D48]/60 transition-colors cursor-pointer"
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
        <div className="lg:col-span-7 rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5 flex flex-col justify-between gap-4">
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
                onClick={() => setDeckMode('turntable')}
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
                onClick={() => setDeckMode('video')}
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
              <VinylTurntable
                track={engine.currentTrack}
                isPlaying={activeIsRunning}
                onTogglePlay={engine.currentTrack ? onTogglePlay : onQuickPlay}
              />
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
                  {dsp.crossfadeSeconds.toFixed(1)}s
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
            onClick={onOpenDsp}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-[#2A2D39] bg-[#14161D] py-2.5 text-sm font-semibold text-[#F4F3F0] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
          >
            <Sliders className="h-4 w-4 text-[#E11D48]" />
            <span>Adjust Equalizer &amp; Filter Sliders</span>
          </button>
        </div>
      </section>

      {/* Built-In Offline Synthesizer Stems */}
      <section>
        <div className="mb-3.5 flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-[#F4F3F0]">
              Built-In Offline Synthesizer Stems
            </h2>
            <p className="text-xs text-[#8E929B]">
              Procedural kick, snare, bassline, and pad synthesis generated live with zero network dependency
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PROCEDURAL_STEMS.map((stem) => {
            const isCurrent = engine.currentTrack?.id === stem.id;
            const isStemPlaying = isCurrent && engine.isPlaying;

            return (
              <div
                key={stem.id}
                className={`flex flex-col justify-between rounded-xl border p-4 transition-colors ${
                  isCurrent
                    ? 'border-[#E11D48] bg-[#13090E]'
                    : 'border-[#1F2129] bg-[#0D0E12] hover:border-[#323646]'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-mono-tabular text-xs text-[#8E929B]">
                      <span>{stem.bpm} BPM</span>
                      <span aria-hidden="true">·</span>
                      <span>{stem.rootFreq} Hz</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => (isCurrent ? onTogglePlay() : onPlayTrack(stem))}
                      aria-label={isStemPlaying ? `Pause ${stem.title}` : `Play ${stem.title}`}
                      className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors cursor-pointer ${
                        isStemPlaying
                          ? 'bg-[#E11D48] text-white shadow-[0_0_14px_rgba(225,29,72,0.55)]'
                          : 'border border-[#2A2D39] bg-[#161820] text-[#F4F3F0] hover:border-[#E11D48]'
                      }`}
                    >
                      {isStemPlaying ? (
                        <Pause className="h-4 w-4 fill-current" />
                      ) : (
                        <Play className="h-4 w-4 fill-current ml-0.5" />
                      )}
                    </button>
                  </div>

                  <div className="mt-3 flex items-center gap-3">
                    {stem.artworkUrl ? (
                      <img
                        src={stem.artworkUrl}
                        alt={stem.title}
                        referrerPolicy="no-referrer"
                        className="h-11 w-11 rounded-md object-cover border border-[#252834]"
                      />
                    ) : (
                      <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#161820]">
                        <Disc className="h-5 w-5 text-[#E11D48]" />
                      </div>
                    )}
                    <h3 className="font-display text-base font-bold text-[#F4F3F0] truncate">
                      {stem.title}
                    </h3>
                  </div>

                  <p className="mt-3 text-xs leading-relaxed text-[#8E929B]">
                    {stem.synthProfile?.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};

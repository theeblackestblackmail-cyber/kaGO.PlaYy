import React from 'react';
import {
  ArrowLeftRight,
  ChevronRight,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Mic2,
  Moon,
  Music,
  Palette,
  Radio,
  Sliders,
  Sun,
  Volume2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { EQ_PRESETS, EQ_PRESET_ORDER } from '../data/presetsAndStems';
import type { ActiveTab, DspSettings, EqBands, EqPresetName } from '../types/audio';
import type { ThemeMode, ThemePreferences } from '../utils/themeManager';
import { triggerHaptic } from '../utils/haptics';
import { AccentColorPicker } from './AccentColorPicker';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsViewProps {
  dsp: DspSettings;
  storedTrackCount: number;
  isOnline: boolean;
  autoplayRadioEnabled: boolean;
  themePrefs: ThemePreferences;
  onChangeThemeMode: (mode: ThemeMode) => void;
  onChangeAccentColor: (accentHex: string, accentAlpha: number) => void;
  onResetAccentColor: () => void;
  onToggleAutoplayRadio: () => void;
  onOpenDsp: () => void;
  onUpdateDsp: (next: DspSettings) => void;
  onPickSong: () => void;
  onPickFolder: () => void;
  onNavigate: (tab: ActiveTab) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  dsp,
  storedTrackCount,
  isOnline,
  autoplayRadioEnabled,
  themePrefs,
  onChangeThemeMode,
  onChangeAccentColor,
  onResetAccentColor,
  onToggleAutoplayRadio,
  onOpenDsp,
  onUpdateDsp,
  onPickSong,
  onPickFolder,
  onNavigate,
}) => {
  const handlePresetQuick = (name: EqPresetName) => {
    triggerHaptic('selection');
    onUpdateDsp({
      ...dsp,
      preset: name,
      bands: [...EQ_PRESETS[name]] as EqBands,
    });
  };

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Header */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#F4F3F0]">Settings</h1>
            <p className="mt-1 text-xs text-[#8E929B]">
              Accent color wheel, Dark &amp; Light mode, Equalizer DSP rack, and library tools
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PWAInstallButton />
          </div>
        </div>
      </section>

      {/* Appearance & Theme: Dark/Light Mode + Accent Color Wheel */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#2A2D39] bg-[#15171F] text-[#E11D48]">
              <Palette className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
                Appearance &amp; Accent Color
              </h2>
              <p className="text-xs text-[#8E929B]">
                Switch between Dark / Light mode or customize your accent color with the wheel
              </p>
            </div>
          </div>

          {/* Dark / Light Mode Segmented Toggle */}
          <div
            role="group"
            aria-label="Theme mode"
            className="inline-flex items-center gap-1 self-start sm:self-auto rounded-lg border border-[#222530] bg-[#090A0E] p-1"
          >
            <button
              type="button"
              aria-pressed={themePrefs.mode === 'dark'}
              onClick={() => {
                triggerHaptic('light');
                onChangeThemeMode('dark');
              }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                themePrefs.mode === 'dark'
                  ? 'bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                  : 'text-[#8E929B] hover:text-[#F4F3F0]'
              }`}
            >
              <Moon className="h-3.5 w-3.5" />
              <span>Dark</span>
            </button>
            <button
              type="button"
              aria-pressed={themePrefs.mode === 'light'}
              onClick={() => {
                triggerHaptic('light');
                onChangeThemeMode('light');
              }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                themePrefs.mode === 'light'
                  ? 'bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                  : 'text-[#8E929B] hover:text-[#F4F3F0]'
              }`}
            >
              <Sun className="h-3.5 w-3.5" />
              <span>Light</span>
            </button>
          </div>
        </div>

        <AccentColorPicker
          accentHex={themePrefs.accentHex}
          accentAlpha={themePrefs.accentAlpha}
          onChange={onChangeAccentColor}
          onReset={onResetAccentColor}
        />
      </section>

      {/* Equalizer & Audio DSP Card */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#2A2D39] bg-[#15171F] text-[#E11D48]">
              <Sliders className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
                Equalizer &amp; Hardware DSP
              </h2>
              <p className="font-mono-tabular text-xs text-[#8E929B] truncate">
                Preset: {dsp.preset} · Bass Boost:{' '}
                {dsp.bassBoostEnabled ? `+${dsp.bassBoostDb} dB` : 'Bypass'} · Crossfade:{' '}
                {dsp.crossfadeSeconds <= 0 ? 'Off' : `${dsp.crossfadeSeconds.toFixed(1)}s`}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onOpenDsp();
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2.5 text-xs font-semibold text-white shadow-[0_0_16px_rgba(225,29,72,0.45)] hover:bg-[#BE123C] transition-colors whitespace-nowrap cursor-pointer"
          >
            <Sliders className="h-4 w-4" />
            <span>Open Equalizer Settings</span>
          </button>
        </div>

        {/* Quick EQ Preset Chips */}
        <div>
          <div className="mb-2 text-xs font-semibold text-[#C7C9D1]">Quick EQ Preset</div>
          <div className="grid grid-cols-2 min-[360px]:grid-cols-3 sm:grid-cols-6 gap-2">
            {EQ_PRESET_ORDER.slice(0, 6).map((presetName) => {
              const active = dsp.preset === presetName;
              return (
                <button
                  key={presetName}
                  type="button"
                  onClick={() => handlePresetQuick(presetName)}
                  className={`rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap truncate cursor-pointer ${
                    active
                      ? 'border-[#E11D48] bg-[#E11D48]/15 text-[#FF4D6D]'
                      : 'border-[#232631] bg-[#13151B] text-[#B4B7C2] hover:border-[#3A3F50] hover:text-white'
                  }`}
                >
                  {presetName}
                </button>
              );
            })}
          </div>
        </div>

        {/* Quick 80 Hz Bass Boost Toggle */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#1E2028] bg-[#07080B] px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <Volume2 className="h-4 w-4 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0]">80 Hz Bass Boost</div>
              <div className="text-xs text-[#8E929B]">
                Hardware low-shelf punch (+{dsp.bassBoostDb} dB)
              </div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={dsp.bassBoostEnabled}
            onClick={() => {
              triggerHaptic('selection');
              onUpdateDsp({ ...dsp, bassBoostEnabled: !dsp.bassBoostEnabled });
            }}
            className={`shrink-0 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              dsp.bassBoostEnabled
                ? 'border-[#E11D48] bg-[#E11D48] text-white'
                : 'border-[#2A2D39] bg-[#14161D] text-[#8E929B] hover:text-white'
            }`}
          >
            {dsp.bassBoostEnabled ? 'Active' : 'Off'}
          </button>
        </div>
      </section>

      {/* Playback, Crossfade & Autoplay Radio */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6 space-y-3">
        <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
          Streaming &amp; Playback
        </h2>

        {/* User-Configurable Crossfade Duration */}
        <div className="rounded-xl border border-[#1E2028] bg-[#07080B] px-4 py-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <ArrowLeftRight className="h-4 w-4 shrink-0 text-[#E11D48]" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#F4F3F0]">Track Crossfade</div>
                <div className="text-xs text-[#8E929B]">
                  Seamlessly fade from one song into the next when switching tracks
                </div>
              </div>
            </div>
            <span
              data-testid="settings-crossfade-value"
              className="shrink-0 font-mono-tabular text-sm font-bold text-[#FF4D6D]"
            >
              {dsp.crossfadeSeconds <= 0 ? 'Off (0s)' : `${dsp.crossfadeSeconds.toFixed(1)}s`}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="font-mono-tabular text-xs text-[#8E929B] shrink-0">0s</span>
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={Math.min(10, dsp.crossfadeSeconds)}
              aria-label="Track Crossfade Duration in seconds"
              onChange={(e) => {
                triggerHaptic('light', 45);
                onUpdateDsp({
                  ...dsp,
                  crossfadeSeconds: Number(e.target.value),
                });
              }}
              className="hardware-slider w-full"
            />
            <span className="font-mono-tabular text-xs text-[#F4F3F0] shrink-0">10s</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {[
              { label: 'Off', value: 0 },
              { label: '1s', value: 1 },
              { label: '2s', value: 2 },
              { label: '3s', value: 3 },
              { label: '5s', value: 5 },
            ].map((preset) => {
              const active = Math.abs(dsp.crossfadeSeconds - preset.value) < 0.05;
              return (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    triggerHaptic('selection');
                    onUpdateDsp({
                      ...dsp,
                      crossfadeSeconds: preset.value,
                    });
                  }}
                  className={`rounded-lg border px-3 py-1.5 font-mono-tabular text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'border-[#E11D48] bg-[#E11D48] text-white'
                      : 'border-[#232631] bg-[#13151B] text-[#B4B7C2] hover:border-[#E11D48] hover:text-white'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#1E2028] bg-[#07080B] px-4 py-3.5">
          <div className="flex items-center gap-3 min-w-0">
            <Radio className="h-4 w-4 shrink-0 text-[#E11D48]" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F4F3F0]">
                Autoplay Related Songs (Auto Radio)
              </div>
              <div className="text-xs text-[#8E929B]">
                Automatically queue similar tracks when streaming songs, just like Spotify
              </div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoplayRadioEnabled}
            onClick={() => {
              triggerHaptic('selection');
              onToggleAutoplayRadio();
            }}
            className={`shrink-0 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              autoplayRadioEnabled
                ? 'border-[#E11D48] bg-[#E11D48] text-white'
                : 'border-[#2A2D39] bg-[#14161D] text-[#8E929B] hover:text-white'
            }`}
          >
            {autoplayRadioEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </section>

      {/* Storage, Folder Import & Lyrics Tools */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6 space-y-3">
        <h2 className="font-display text-base sm:text-lg font-bold text-[#F4F3F0]">
          Library, Folders &amp; Lyrics
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onPickFolder();
            }}
            className="kago-press-subtle flex items-center justify-between gap-3 rounded-xl border border-[#222530] bg-[#13151C] px-4 py-3.5 text-left hover:border-[#E11D48] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <FolderOpen className="h-5 w-5 shrink-0 text-[#E11D48]" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#F4F3F0]">Pick Music Folder</div>
                <div className="text-xs text-[#8E929B]">Import an entire folder of songs</div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-[#8E929B]" />
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onPickSong();
            }}
            className="kago-press-subtle flex items-center justify-between gap-3 rounded-xl border border-[#222530] bg-[#13151C] px-4 py-3.5 text-left hover:border-[#E11D48] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Music className="h-5 w-5 shrink-0 text-[#E11D48]" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#F4F3F0]">Pick Individual Song(s)</div>
                <div className="text-xs text-[#8E929B]">Select audio files from device</div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-[#8E929B]" />
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onNavigate('scanner');
            }}
            className="kago-press-subtle flex items-center justify-between gap-3 rounded-xl border border-[#222530] bg-[#13151C] px-4 py-3.5 text-left hover:border-[#E11D48] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <FolderSearch className="h-5 w-5 shrink-0 text-[#E11D48]" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#F4F3F0]">Folder Scanner &amp; Sanitizer</div>
                <div className="text-xs text-[#8E929B]">Recursive tag reader &amp; filename test</div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-[#8E929B]" />
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onNavigate('lyrics');
            }}
            className="kago-press-subtle flex items-center justify-between gap-3 rounded-xl border border-[#222530] bg-[#13151C] px-4 py-3.5 text-left hover:border-[#E11D48] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Mic2 className="h-5 w-5 shrink-0 text-[#E11D48]" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#F4F3F0]">Sync Lyrics Studio</div>
                <div className="text-xs text-[#8E929B]">Import .lrc files &amp; calibrate timing</div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-[#8E929B]" />
          </button>
        </div>
      </section>

      {/* Device & Cache Info */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-4 sm:p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="flex items-center justify-between rounded-lg border border-[#1E2028] bg-[#07080B] px-3.5 py-2.5">
            <span className="inline-flex items-center gap-2 text-[#8E929B]">
              <HardDrive className="h-4 w-4 text-[#E11D48]" />
              Offline Library Cache
            </span>
            <span className="font-mono-tabular font-semibold text-[#F4F3F0]">
              {storedTrackCount} tracks
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-[#1E2028] bg-[#07080B] px-3.5 py-2.5">
            <span className="inline-flex items-center gap-2 text-[#8E929B]">
              {isOnline ? (
                <Wifi className="h-4 w-4 text-[#E11D48]" />
              ) : (
                <WifiOff className="h-4 w-4 text-[#E11D48]" />
              )}
              Network Mode
            </span>
            <span className="font-mono-tabular font-semibold text-[#F4F3F0]">
              {isOnline ? 'Online + Offline Ready' : 'Offline Engine'}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
};

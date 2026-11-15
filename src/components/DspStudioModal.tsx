import React from 'react';
import { ArrowLeft, RotateCcw, Sliders, X } from 'lucide-react';
import { EQ_FREQUENCIES, EQ_PRESETS, EQ_PRESET_ORDER } from '../data/presetsAndStems';
import type { DspSettings, EqBands, EqPresetName } from '../types/audio';
import { triggerHaptic } from '../utils/haptics';

interface DspStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  dsp: DspSettings;
  onUpdateDsp: (next: DspSettings) => void;
  onResetFlat: () => void;
}

export const DspStudioModal: React.FC<DspStudioModalProps> = ({
  isOpen,
  onClose,
  dsp,
  onUpdateDsp,
  onResetFlat,
}) => {
  if (!isOpen) return null;

  const handlePreset = (name: EqPresetName) => {
    triggerHaptic('selection');
    onUpdateDsp({
      ...dsp,
      preset: name,
      bands: [...EQ_PRESETS[name]] as EqBands,
    });
  };

  const handleBandChange = (index: number, value: number) => {
    triggerHaptic('light', 45);
    const nextBands = [...dsp.bands] as EqBands;
    nextBands[index] = value;
    onUpdateDsp({
      ...dsp,
      preset: 'Custom',
      bands: nextBands,
    });
  };

  return (
    <div
      className="kago-modal-backdrop fixed inset-0 z-[70] flex flex-col sm:items-center sm:justify-center bg-black/90 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dsp-studio-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          triggerHaptic('light');
          onClose();
        }
      }}
    >
      <div className="kago-sheet-slide flex h-[100dvh] w-full flex-col bg-[#0D0E12] sm:h-auto sm:max-h-[90dvh] sm:max-w-3xl sm:rounded-xl sm:border sm:border-[#242732] overflow-hidden shadow-2xl">
        {/* Sticky Top Bar with Top-Left Back Button */}
        <div className="shrink-0 flex items-center justify-between gap-2 border-b border-[#1E2028] bg-[#090A0E] px-3 py-3 sm:px-6 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-4">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              aria-label="Back from Equalizer Settings"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[#2A2D39] bg-[#14161D] px-3 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
            >
              <ArrowLeft className="h-4 w-4 text-[#E11D48]" />
              <span>Back</span>
            </button>

            <div className="hidden min-[420px]:flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#2A2D39] bg-[#15171F] text-[#E11D48]">
              <Sliders className="h-4 w-4" />
            </div>

            <div className="min-w-0">
              <h2
                id="dsp-studio-heading"
                className="truncate font-display text-base sm:text-lg font-bold text-[#F4F3F0]"
              >
                Equalizer &amp; DSP
              </h2>
              <p className="hidden sm:block truncate text-xs text-[#8E929B]">
                5-Band Parametric Rack · 80 Hz Low-Shelf · Dual-Channel Crossfader
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium');
                onResetFlat();
              }}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-[#2A2D39] bg-[#14161D] px-2.5 sm:px-3 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5 text-[#E11D48]" />
              <span className="hidden min-[360px]:inline">Reset Flat</span>
              <span className="min-[360px]:hidden">Reset</span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              aria-label="Close Hardware DSP Studio"
              className="hidden sm:flex h-10 w-10 items-center justify-center rounded-lg border border-[#2A2D39] bg-[#14161D] text-[#8E929B] hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {/* 12 Presets Grid */}
          <div>
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[#C7C9D1]">Hardware EQ Presets</span>
              <span className="font-mono-tabular text-xs text-[#FF4D6D] truncate">
                Active: {dsp.preset}
              </span>
            </div>
            <div className="grid grid-cols-2 min-[360px]:grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {EQ_PRESET_ORDER.map((presetName) => {
                const active = dsp.preset === presetName;
                return (
                  <button
                    key={presetName}
                    type="button"
                    onClick={() => handlePreset(presetName)}
                    className={`rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap truncate cursor-pointer ${
                      active
                        ? 'border-[#E11D48] bg-[#E11D48]/15 text-[#FF4D6D] shadow-[0_0_12px_rgba(225,29,72,0.25)]'
                        : 'border-[#232631] bg-[#13151B] text-[#B4B7C2] hover:border-[#3A3F50] hover:text-white'
                    }`}
                  >
                    {presetName}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 5 Vertical EQ Faders */}
          <div className="mt-5 rounded-xl border border-[#1E2028] bg-[#07080B] p-3.5 sm:p-5">
            <div className="mb-3.5 flex items-center justify-between text-xs text-[#8E929B]">
              <span className="font-semibold text-[#F4F3F0]">5-Band Graphic Equalizer</span>
              <span className="font-mono-tabular">-12 dB to +12 dB</span>
            </div>

            <div className="grid grid-cols-5 gap-1.5 sm:gap-4">
              {EQ_FREQUENCIES.map((freq, idx) => {
                const db = dsp.bands[idx] ?? 0;
                return (
                  <div key={freq.hz} className="flex flex-col items-center">
                    <span
                      className={`mb-1.5 font-mono-tabular text-[11px] sm:text-xs font-semibold whitespace-nowrap ${
                        db > 0 ? 'text-[#FF4D6D]' : db < 0 ? 'text-[#9CA3AF]' : 'text-[#F4F3F0]'
                      }`}
                    >
                      {db > 0 ? `+${db}` : db} dB
                    </span>
                    <div className="relative flex h-28 min-[400px]:h-32 sm:h-36 items-center justify-center">
                      <input
                        type="range"
                        min={-12}
                        max={12}
                        step={1}
                        value={db}
                        aria-label={`${freq.label} equalizer band`}
                        onChange={(e) => handleBandChange(idx, Number(e.target.value))}
                        className="eq-vertical-fader"
                      />
                    </div>
                    <span className="mt-1.5 font-mono-tabular text-[11px] sm:text-xs font-medium text-[#8E929B]">
                      {freq.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 80 Hz Low-Shelf Bass Boost + Channel Crossfader */}
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3.5 sm:gap-4">
            {/* 80 Hz Bass Boost */}
            <div className="rounded-xl border border-[#1E2028] bg-[#090A0E] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-[#F4F3F0]">80 Hz Low-Shelf Bass Boost</h3>
                  <p className="font-mono-tabular text-xs text-[#8E929B]">
                    Gain: +{dsp.bassBoostDb} dB
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('selection');
                    onUpdateDsp({ ...dsp, bassBoostEnabled: !dsp.bassBoostEnabled });
                  }}
                  aria-pressed={dsp.bassBoostEnabled}
                  className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    dsp.bassBoostEnabled
                      ? 'border-[#E11D48] bg-[#E11D48] text-white shadow-[0_0_14px_rgba(225,29,72,0.45)]'
                      : 'border-[#2A2D39] bg-[#14161D] text-[#8E929B] hover:text-white'
                  }`}
                >
                  {dsp.bassBoostEnabled ? 'Active' : 'Bypass'}
                </button>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <span className="font-mono-tabular text-xs text-[#8E929B] whitespace-nowrap shrink-0">
                  0 dB
                </span>
                <input
                  type="range"
                  min={0}
                  max={14}
                  step={1}
                  value={dsp.bassBoostDb}
                  aria-label="80 Hz Low-Shelf Bass Boost Gain"
                  onChange={(e) => {
                    triggerHaptic('light', 45);
                    onUpdateDsp({
                      ...dsp,
                      bassBoostDb: Number(e.target.value),
                      bassBoostEnabled: true,
                    });
                  }}
                  className="hardware-slider w-full"
                />
                <span className="font-mono-tabular text-xs text-[#F4F3F0] whitespace-nowrap shrink-0">
                  +14 dB
                </span>
              </div>
            </div>

            {/* Channel Crossfader Duration */}
            <div className="rounded-xl border border-[#1E2028] bg-[#090A0E] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-[#F4F3F0]">
                    Channel Crossfader Duration
                  </h3>
                  <p className="text-xs text-[#8E929B]">
                    Dual-deck overlap (0s instant cut to 12s)
                  </p>
                </div>
                <span className="shrink-0 font-mono-tabular text-sm font-bold text-[#FF4D6D]">
                  {dsp.crossfadeSeconds.toFixed(1)}s
                </span>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <span className="font-mono-tabular text-xs text-[#8E929B]">0s</span>
                <input
                  type="range"
                  min={0}
                  max={12}
                  step={0.5}
                  value={dsp.crossfadeSeconds}
                  aria-label="Channel Crossfader Duration in seconds"
                  onChange={(e) => {
                    triggerHaptic('light', 45);
                    onUpdateDsp({
                      ...dsp,
                      crossfadeSeconds: Number(e.target.value),
                    });
                  }}
                  className="hardware-slider w-full"
                />
                <span className="font-mono-tabular text-xs text-[#F4F3F0]">12s</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

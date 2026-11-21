import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Disc3, Eye, Layers, Palette, Waves, X } from 'lucide-react';
import { audioEngine } from '../audio/AudioEngine';
import type { DspSettings, Track } from '../types/audio';
import { triggerHaptic } from '../utils/haptics';
import {
  computeBandEnergy,
  computeSeedSignature,
  getVisualizerPalette,
  loadVisualizerMode,
  loadVisualizerPalette,
  sampleSpectrumBands,
  saveVisualizerMode,
  saveVisualizerPalette,
  subscribeVisualizerMode,
  subscribeVisualizerPalette,
  VISUALIZER_PALETTES,
  VISUALIZER_PALETTE_ORDER,
  type VisualizerBackdrop,
  type VisualizerMode,
  type VisualizerPaletteId,
} from '../utils/visualizerUtils';

interface AudioVisualizerOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  track: Track | null;
  isPlaying: boolean;
  currentTime: number;
  dsp: DspSettings;
  activeSubTab: 'turntable' | 'video' | 'lyrics' | 'queue';
  paletteId?: VisualizerPaletteId;
  onChangePalette?: (id: VisualizerPaletteId) => void;
}

const BACKDROP_STORAGE_KEY = 'kago-visualizer-overlay-backdrop';

function readStoredBackdrop(): VisualizerBackdrop {
  try {
    const val = localStorage.getItem(BACKDROP_STORAGE_KEY);
    if (val === 'ambient' || val === 'focus') return val;
  } catch {
    // Ignore storage failures
  }
  return 'ambient';
}

export const AudioVisualizerOverlay: React.FC<AudioVisualizerOverlayProps> = ({
  isOpen,
  onClose,
  track,
  isPlaying,
  currentTime,
  dsp,
  activeSubTab,
  paletteId,
  onChangePalette,
}) => {
  const [mode, setMode] = useState<VisualizerMode>(loadVisualizerMode);
  const [backdrop, setBackdrop] = useState<VisualizerBackdrop>(readStoredBackdrop);
  const [storedPalette, setStoredPalette] = useState<VisualizerPaletteId>(loadVisualizerPalette);

  const activePaletteId = paletteId ?? storedPalette;
  const activePalette = getVisualizerPalette(activePaletteId);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const bandCount = 56;
  const barsRef = useRef<number[]>(new Array(bandCount).fill(0.02));
  const peaksRef = useRef<number[]>(new Array(bandCount).fill(0.03));

  const trackSeed = useMemo(
    () => computeSeedSignature(track?.id, track?.title),
    [track?.id, track?.title]
  );

  useEffect(() => {
    return subscribeVisualizerPalette(setStoredPalette);
  }, []);

  useEffect(() => {
    return subscribeVisualizerMode(setMode);
  }, []);

  const handleSelectMode = (nextMode: VisualizerMode) => {
    triggerHaptic('selection');
    setMode(nextMode);
    saveVisualizerMode(nextMode);
  };

  const handleCycleOrSelectPalette = (nextId: VisualizerPaletteId) => {
    triggerHaptic('selection');
    setStoredPalette(nextId);
    saveVisualizerPalette(nextId);
    onChangePalette?.(nextId);
  };

  useEffect(() => {
    try {
      localStorage.setItem(BACKDROP_STORAGE_KEY, backdrop);
    } catch {
      // Ignore storage errors
    }
  }, [backdrop]);

  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const freqBuffer = new Uint8Array(64);
    const waveBuffer = new Uint8Array(128);
    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const palette = getVisualizerPalette(activePaletteId);

    const renderFrame = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(260, Math.floor(rect.width));
      const height = Math.max(180, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const rootEl = document.documentElement;
      const isLightMode = rootEl.classList.contains('light');

      const hasFreqAnalyser = audioEngine.getFrequencyData(freqBuffer);
      const hasLiveSignal = hasFreqAnalyser && freqBuffer.some((v) => v > 4);
      const hasWaveAnalyser = audioEngine.getTimeDomainData(waveBuffer);
      const nowSec = performance.now() / 1000;

      const targets = sampleSpectrumBands({
        bandCount,
        isPlaying,
        hasLiveSignal,
        freqBuffer,
        dsp,
        nowSec,
        currentTime: currentTimeRef.current,
        trackSeed,
      });

      const attackRate = reducedMotion ? 0.24 : 0.48;
      const decayRate = reducedMotion ? 0.91 : 0.85;
      const peakDrop = reducedMotion ? 0.004 : 0.0085;

      for (let i = 0; i < bandCount; i++) {
        const prev = barsRef.current[i] ?? 0.02;
        const target = targets[i] ?? 0.02;
        const nextVal = target > prev ? prev + (target - prev) * attackRate : prev * decayRate;
        barsRef.current[i] = Math.max(0.02, Math.min(1, nextVal));

        if (barsRef.current[i] >= (peaksRef.current[i] ?? 0)) {
          peaksRef.current[i] = barsRef.current[i];
        } else {
          peaksRef.current[i] = Math.max(0.03, (peaksRef.current[i] ?? 0.03) - peakDrop);
        }
      }

      const energy = computeBandEnergy(barsRef.current);
      const isVideoAmbient = activeSubTab === 'video' && backdrop === 'ambient';

      // Subtle studio horizon glow driven by low-end bass energy + active palette aura
      const glowRadius = Math.max(width, height) * (0.34 + energy.bass * 0.2);
      const glowCenterY = isVideoAmbient ? height * 0.84 : height * 0.62;
      const aura = ctx.createRadialGradient(
        width / 2,
        glowCenterY,
        12,
        width / 2,
        glowCenterY,
        glowRadius
      );
      aura.addColorStop(0, `rgba(${palette.auraRgb}, ${(0.08 + energy.bass * 0.24).toFixed(3)})`);
      aura.addColorStop(0.55, `rgba(${palette.auraRgb}, ${(0.03 + energy.mid * 0.08).toFixed(3)})`);
      aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, width, height);

      if (backdrop === 'focus') {
        ctx.strokeStyle = isLightMode ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        for (let g = 1; g <= 4; g++) {
          const gy = Math.round((height / 5) * g) + 0.5;
          ctx.beginPath();
          ctx.moveTo(16, gy);
          ctx.lineTo(width - 16, gy);
          ctx.stroke();
        }
      }

      const horizontalPad = Math.max(14, Math.min(36, width * 0.04));
      const drawWidth = Math.max(120, width - horizontalPad * 2);
      const peakCapFill = isPlaying
        ? isLightMode
          ? palette.peakColorLight
          : palette.peakColor
        : isLightMode
        ? '#94A3B8'
        : '#4B5563';

      if (mode === 'bars') {
        const maxBarHeight = isVideoAmbient
          ? Math.max(64, height * 0.34)
          : backdrop === 'focus'
          ? Math.max(120, height * 0.56)
          : Math.max(96, height * 0.42);
        const baselineY = height - 16;
        const gap = width < 420 ? 2.5 : 4;
        const barW = Math.max(2, (drawWidth - gap * (bandCount - 1)) / bandCount);

        for (let i = 0; i < bandCount; i++) {
          const val = barsRef.current[i];
          const peak = peaksRef.current[i];
          const barH = Math.max(3, val * maxBarHeight);
          const x = horizontalPad + i * (barW + gap);
          const y = baselineY - barH;
          const stops = palette.getStops(i / Math.max(1, bandCount - 1), isLightMode);

          const grad = ctx.createLinearGradient(x, baselineY, x, y);
          grad.addColorStop(0, stops.base);
          grad.addColorStop(0.58, stops.mid);
          grad.addColorStop(1, stops.tip);
          ctx.fillStyle = grad;

          const radius = Math.min(barW / 2, 3);
          ctx.beginPath();
          ctx.roundRect(x, y, barW, barH, [radius, radius, 1, 1]);
          ctx.fill();

          const reflH = Math.min(12, barH * 0.14);
          ctx.fillStyle = palette.reflectionRgba;
          ctx.fillRect(x, baselineY + 2, barW, reflH);

          const peakY = Math.max(14, baselineY - peak * maxBarHeight - 4);
          ctx.fillStyle = peakCapFill;
          ctx.fillRect(x, peakY, barW, 2);
        }
      } else if (mode === 'mirror') {
        const centerY = isVideoAmbient ? height * 0.78 : height * 0.54;
        const maxHalfH = isVideoAmbient
          ? Math.max(36, height * 0.17)
          : backdrop === 'focus'
          ? Math.max(76, height * 0.31)
          : Math.max(64, height * 0.25);
        const gap = width < 420 ? 2.5 : 4;
        const barW = Math.max(2, (drawWidth - gap * (bandCount - 1)) / bandCount);

        ctx.strokeStyle = palette.horizonStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(horizontalPad, centerY + 0.5);
        ctx.lineTo(width - horizontalPad, centerY + 0.5);
        ctx.stroke();

        for (let i = 0; i < bandCount; i++) {
          const mirrorIdx = Math.abs(i - (bandCount - 1) / 2) / ((bandCount - 1) / 2);
          const sampledIdx = Math.min(bandCount - 1, Math.floor(mirrorIdx * (bandCount - 1)));
          const val = barsRef.current[sampledIdx];
          const peak = peaksRef.current[sampledIdx];
          const halfH = Math.max(2, val * maxHalfH);
          const x = horizontalPad + i * (barW + gap);
          const stops = palette.getStops(mirrorIdx, isLightMode);

          const upGrad = ctx.createLinearGradient(x, centerY, x, centerY - halfH);
          upGrad.addColorStop(0, stops.mid);
          upGrad.addColorStop(1, stops.tip);
          ctx.fillStyle = upGrad;
          ctx.fillRect(x, centerY - halfH, barW, halfH);

          const downGrad = ctx.createLinearGradient(x, centerY, x, centerY + halfH * 0.86);
          downGrad.addColorStop(0, stops.base);
          downGrad.addColorStop(1, palette.reflectionRgba);
          ctx.fillStyle = downGrad;
          ctx.fillRect(x, centerY + 1, barW, halfH * 0.86);

          const peakOffset = peak * maxHalfH + 3;
          ctx.fillStyle = peakCapFill;
          ctx.fillRect(x, centerY - peakOffset, barW, 2);
        }

        if (isPlaying) {
          ctx.beginPath();
          ctx.lineWidth = 1.75;
          ctx.strokeStyle = isLightMode ? 'rgba(15, 23, 42, 0.72)' : 'rgba(244, 243, 240, 0.82)';
          const waveSteps = 64;
          for (let s = 0; s < waveSteps; s++) {
            const x = horizontalPad + (s / (waveSteps - 1)) * drawWidth;
            let amp = 0;
            if (hasLiveSignal && hasWaveAnalyser) {
              const sampleIdx = Math.min(waveBuffer.length - 1, Math.floor((s / waveSteps) * waveBuffer.length));
              amp = (waveBuffer[sampleIdx] - 128) / 128;
            } else {
              amp =
                Math.sin(nowSec * 9.5 + s * 0.32) *
                (0.25 + energy.bass * 0.45) *
                Math.cos(s * 0.14 - nowSec * 3.1);
            }
            const y = centerY + amp * (maxHalfH * 0.55);
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      } else {
        const cx = width / 2;
        const cy = isVideoAmbient ? height * 0.72 : height * 0.53;
        const minDim = Math.min(width, isVideoAmbient ? height * 0.55 : height);
        const baseRadius = Math.max(46, Math.min(138, minDim * 0.23)) + energy.bass * 8;
        const maxSpokeLen = Math.max(26, Math.min(84, minDim * 0.16));

        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius - 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${palette.auraRgb}, ${(0.25 + energy.overall * 0.45).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        const spokeCount = 64;
        for (let i = 0; i < spokeCount; i++) {
          const angle = (i / spokeCount) * Math.PI * 2 - Math.PI / 2;
          const halfPos = i < spokeCount / 2 ? i : spokeCount - 1 - i;
          const halfNorm = halfPos / Math.max(1, spokeCount / 2 - 1);
          const barIdx = Math.min(
            bandCount - 1,
            Math.floor((halfPos / (spokeCount / 2)) * bandCount)
          );
          const val = barsRef.current[barIdx];
          const peak = peaksRef.current[barIdx];
          const stops = palette.getStops(halfNorm, isLightMode);

          const len = Math.max(4, val * maxSpokeLen);
          const x1 = cx + Math.cos(angle) * baseRadius;
          const y1 = cy + Math.sin(angle) * baseRadius;
          const x2 = cx + Math.cos(angle) * (baseRadius + len);
          const y2 = cy + Math.sin(angle) * (baseRadius + len);

          ctx.strokeStyle = val > 0.62 ? stops.tip : stops.mid;
          ctx.lineWidth = width < 420 ? 2.5 : 3.2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          const peakR = baseRadius + peak * maxSpokeLen + 5;
          ctx.fillStyle = peakCapFill;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(angle) * peakR, cy + Math.sin(angle) * peakR, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const stillSettling =
        isPlaying ||
        barsRef.current.some((v) => v > 0.03) ||
        peaksRef.current.some((p) => p > 0.04);

      if (stillSettling) {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isOpen, isPlaying, dsp, mode, backdrop, activeSubTab, trackSeed, activePaletteId]);

  if (!isOpen) return null;

  const isFocus = backdrop === 'focus';

  return (
    <div
      role="region"
      aria-label="Real-Time Audio Visualizer Overlay"
      data-testid="audio-visualizer-overlay"
      className={`kago-panel-enter absolute inset-0 z-30 flex flex-col justify-between overflow-hidden transition-colors duration-200 ${
        isFocus
          ? 'pointer-events-auto bg-[#050508]/92 backdrop-blur-md'
          : 'pointer-events-none bg-gradient-to-b from-black/10 via-black/20 to-black/70'
      }`}
    >
      {/* Reactive Canvas Layer */}
      <canvas
        ref={canvasRef}
        data-testid="visualizer-overlay-canvas"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* Top Overlay Control Strip (Interactive HUD) */}
      <div
        className={`relative z-10 flex flex-wrap items-center justify-between gap-2 px-3.5 py-3 sm:px-6 ${
          activeSubTab === 'video' && backdrop === 'ambient' ? 'mt-auto pb-2' : ''
        }`}
      >
        {/* Left: Compact Track & Palette Readout (Studio Focus or Desktop) */}
        <div
          className={`pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-[#222530] bg-[#0D0E12]/90 px-2.5 py-1.5 backdrop-blur-md ${
            isFocus ? 'max-w-[65%] sm:max-w-xs' : 'hidden sm:flex sm:max-w-[240px]'
          }`}
        >
          <AudioLines className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-[#F4F3F0]">
              {track?.title || 'Spectrum Overlay'}
            </p>
            <p className="truncate font-mono-tabular text-[11px] text-[#8E929B]">
              {activePalette.name} · {dsp.preset}
            </p>
          </div>
        </div>

        {/* Right: Mode Switcher + Palette Switcher + Backdrop Depth + Off */}
        <div className="pointer-events-auto ml-auto flex flex-wrap items-center gap-1.5">
          {/* Palette Quick Selector */}
          <div
            role="group"
            aria-label="Visualizer color palette"
            className="flex items-center gap-1 rounded-lg border border-[#222530] bg-[#0D0E12]/90 p-1 backdrop-blur-md"
          >
            <span className="hidden sm:inline-flex items-center pl-1.5 pr-0.5 text-[#8E929B]">
              <Palette className="h-3.5 w-3.5" />
            </span>
            {VISUALIZER_PALETTE_ORDER.map((id) => {
              const p = VISUALIZER_PALETTES[id];
              const selected = activePaletteId === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`overlay-palette-${id}`}
                  aria-label={`Use ${p.name} visualizer palette`}
                  aria-pressed={selected}
                  title={p.name}
                  onClick={() => handleCycleOrSelectPalette(id)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    selected
                      ? 'bg-[#1A1C24] text-[#F4F3F0] ring-1 ring-[#E11D48]'
                      : 'text-[#8E929B] hover:text-white'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex h-3 w-3 shrink-0 rounded-full border border-white/25"
                    style={{
                      background: `linear-gradient(135deg, ${p.previewBars[0]}, ${p.previewBars[2]}, ${p.previewBars[4]})`,
                    }}
                  />
                  <span className="hidden md:inline">{p.name}</span>
                </button>
              );
            })}
          </div>

          <div
            role="group"
            aria-label="Visualizer display mode"
            className="flex items-center gap-1 rounded-lg border border-[#222530] bg-[#0D0E12]/90 p-1 backdrop-blur-md"
          >
            {(
              [
                { id: 'bars', label: 'Bars', icon: AudioLines },
                { id: 'mirror', label: 'Mirror', icon: Waves },
                { id: 'radial', label: 'Radial', icon: Disc3 },
              ] as const
            ).map((opt) => {
              const Icon = opt.icon;
              const selected = mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-testid={`visualizer-mode-${opt.id}`}
                  aria-pressed={selected}
                  onClick={() => handleSelectMode(opt.id)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    selected
                      ? 'bg-[#E11D48] text-white shadow-[0_0_12px_rgba(225,29,72,0.4)]'
                      : 'text-[#8E929B] hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            data-testid="visualizer-backdrop-toggle"
            aria-pressed={isFocus}
            onClick={() => {
              triggerHaptic('light');
              setBackdrop((prev) => (prev === 'ambient' ? 'focus' : 'ambient'));
            }}
            title={isFocus ? 'Switch to translucent pass-through overlay' : 'Switch to Studio Focus backdrop'}
            className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold backdrop-blur-md transition-colors whitespace-nowrap cursor-pointer ${
              isFocus
                ? 'border-[#E11D48] bg-[#E11D48]/15 text-[#FF4D6D]'
                : 'border-[#222530] bg-[#0D0E12]/90 text-[#D1D5DB] hover:border-[#E11D48] hover:text-white'
            }`}
          >
            {isFocus ? <Eye className="h-3.5 w-3.5" /> : <Layers className="h-3.5 w-3.5" />}
            <span>{isFocus ? 'Focus' : 'Overlay'}</span>
          </button>

          <button
            type="button"
            data-testid="visualizer-overlay-close"
            aria-label="Turn off audio visualizer overlay"
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#222530] bg-[#0D0E12]/90 text-[#8E929B] backdrop-blur-md hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Subtle Bottom Helper Readout in Studio Focus Mode */}
      {isFocus && (
        <div className="relative z-10 pointer-events-none flex items-center justify-between px-4 pb-3 sm:px-6 text-[11px] font-mono-tabular text-[#8E929B]">
          <span>20 Hz – 20 kHz Real-Time Analyzer · {activePalette.name}</span>
          <span>{isPlaying ? 'Live Signal Active' : 'Playback Paused'}</span>
        </div>
      )}
    </div>
  );
};

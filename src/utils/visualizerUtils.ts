import type { DspSettings } from '../types/audio';

export type VisualizerMode = 'bars' | 'mirror' | 'radial';
export type VisualizerBackdrop = 'ambient' | 'focus';
export type VisualizerPaletteId = 'neon-pulse' | 'monochrome-noir' | 'vibrant-synth';

export interface VisualizerBarStops {
  base: string;
  mid: string;
  tip: string;
}

export interface VisualizerPaletteConfig {
  id: VisualizerPaletteId;
  name: string;
  description: string;
  previewBars: [string, string, string, string, string];
  auraRgb: string;
  horizonStroke: string;
  peakColor: string;
  peakColorLight: string;
  reflectionRgba: string;
  getStops: (normIndex: number, isLightMode: boolean) => VisualizerBarStops;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return [225, 29, 72];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function lerpHex(hexA: string, hexB: string, t: number): string {
  const f = clamp01(t);
  const [r1, g1, b1] = parseHexRgb(hexA);
  const [r2, g2, b2] = parseHexRgb(hexB);
  const r = Math.round(r1 + (r2 - r1) * f);
  const g = Math.round(g1 + (g2 - g1) * f);
  const b = Math.round(b1 + (b2 - b1) * f);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function multiLerpHex(stops: string[], t: number): string {
  if (stops.length === 0) return '#E11D48';
  if (stops.length === 1) return stops[0];
  const f = clamp01(t) * (stops.length - 1);
  const idx = Math.floor(f);
  const next = Math.min(stops.length - 1, idx + 1);
  return lerpHex(stops[idx], stops[next], f - idx);
}

export const DEFAULT_VISUALIZER_PALETTE: VisualizerPaletteId = 'neon-pulse';
export const VISUALIZER_PALETTE_STORAGE_KEY = 'kago-visualizer-palette';
export const VISUALIZER_MODE_STORAGE_KEY = 'kago-visualizer-overlay-mode';
const PALETTE_EVENT = 'kago-visualizer-palette-change';
const MODE_EVENT = 'kago-visualizer-mode-change';

export const VISUALIZER_PALETTES: Record<VisualizerPaletteId, VisualizerPaletteConfig> = {
  'neon-pulse': {
    id: 'neon-pulse',
    name: 'Neon Pulse',
    description: 'Electric crimson pulsing into luminous cyan peaks',
    previewBars: ['#BE123C', '#FF2E63', '#A855F7', '#06B6D4', '#67E8F9'],
    auraRgb: '255, 46, 99',
    horizonStroke: 'rgba(56, 189, 248, 0.48)',
    peakColor: '#67E8F9',
    peakColorLight: '#0284C7',
    reflectionRgba: 'rgba(56, 189, 248, 0.22)',
    getStops: (normIndex, isLightMode) => ({
      base: multiLerpHex(
        isLightMode ? ['#9F1239', '#BE123C', '#0369A1'] : ['#881337', '#BE123C', '#1D4ED8'],
        normIndex
      ),
      mid: multiLerpHex(
        isLightMode ? ['#E11D48', '#EC4899', '#0284C7'] : ['#FF2E63', '#E879F9', '#06B6D4'],
        normIndex
      ),
      tip: multiLerpHex(
        isLightMode ? ['#F43F5E', '#A855F7', '#06B6D4'] : ['#FB7185', '#38BDF8', '#67E8F9'],
        normIndex
      ),
    }),
  },
  'monochrome-noir': {
    id: 'monochrome-noir',
    name: 'Monochrome Noir',
    description: 'Brushed titanium, obsidian slate, and crisp platinum caps',
    previewBars: ['#27272A', '#52525B', '#71717A', '#D4D4D8', '#FAFAFA'],
    auraRgb: '212, 212, 216',
    horizonStroke: 'rgba(228, 228, 231, 0.36)',
    peakColor: '#FFFFFF',
    peakColorLight: '#09090B',
    reflectionRgba: 'rgba(212, 212, 216, 0.16)',
    getStops: (normIndex, isLightMode) =>
      isLightMode
        ? {
            base: lerpHex('#94A3B8', '#64748B', normIndex),
            mid: lerpHex('#475569', '#334155', normIndex),
            tip: lerpHex('#1E293B', '#09090B', normIndex),
          }
        : {
            base: lerpHex('#1F2026', '#2E3038', normIndex),
            mid: lerpHex('#52525B', '#8E929B', normIndex),
            tip: lerpHex('#D4D4D8', '#FAFAFA', normIndex),
          },
  },
  'vibrant-synth': {
    id: 'vibrant-synth',
    name: 'Vibrant Synth',
    description: 'Ultraviolet bass sweeping through hot magenta to solar gold',
    previewBars: ['#6D28D9', '#A855F7', '#EC4899', '#F59E0B', '#FDE047'],
    auraRgb: '236, 72, 153',
    horizonStroke: 'rgba(245, 158, 11, 0.45)',
    peakColor: '#FDE68A',
    peakColorLight: '#D97706',
    reflectionRgba: 'rgba(236, 72, 153, 0.22)',
    getStops: (normIndex, isLightMode) => ({
      base: multiLerpHex(
        isLightMode ? ['#4338CA', '#9D174D', '#B45309'] : ['#3B0764', '#831843', '#9A3412'],
        normIndex
      ),
      mid: multiLerpHex(
        isLightMode ? ['#6D28D9', '#DB2777', '#D97706'] : ['#7C3AED', '#EC4899', '#F59E0B'],
        normIndex
      ),
      tip: multiLerpHex(
        isLightMode ? ['#8B5CF6', '#F43F5E', '#EA580C'] : ['#C084FC', '#FB7185', '#FDE047'],
        normIndex
      ),
    }),
  },
};

export const VISUALIZER_PALETTE_ORDER: VisualizerPaletteId[] = [
  'neon-pulse',
  'monochrome-noir',
  'vibrant-synth',
];

export function isVisualizerPaletteId(val: unknown): val is VisualizerPaletteId {
  return val === 'neon-pulse' || val === 'monochrome-noir' || val === 'vibrant-synth';
}

export function getVisualizerPalette(id: VisualizerPaletteId): VisualizerPaletteConfig {
  return VISUALIZER_PALETTES[id] ?? VISUALIZER_PALETTES[DEFAULT_VISUALIZER_PALETTE];
}

export function loadVisualizerPalette(): VisualizerPaletteId {
  try {
    const val = localStorage.getItem(VISUALIZER_PALETTE_STORAGE_KEY);
    if (isVisualizerPaletteId(val)) return val;
  } catch {
    // Ignore storage failures
  }
  return DEFAULT_VISUALIZER_PALETTE;
}

export function saveVisualizerPalette(id: VisualizerPaletteId): void {
  try {
    localStorage.setItem(VISUALIZER_PALETTE_STORAGE_KEY, id);
  } catch {
    // Ignore storage failures
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<VisualizerPaletteId>(PALETTE_EVENT, { detail: id }));
  }
}

export function subscribeVisualizerPalette(
  listener: (id: VisualizerPaletteId) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const onCustom = (e: Event) => {
    const detail = (e as CustomEvent<VisualizerPaletteId>).detail;
    if (isVisualizerPaletteId(detail)) listener(detail);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === VISUALIZER_PALETTE_STORAGE_KEY && isVisualizerPaletteId(e.newValue)) {
      listener(e.newValue);
    }
  };
  window.addEventListener(PALETTE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PALETTE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export function loadVisualizerMode(): VisualizerMode {
  try {
    const val = localStorage.getItem(VISUALIZER_MODE_STORAGE_KEY);
    if (val === 'bars' || val === 'mirror' || val === 'radial') return val;
  } catch {
    // Ignore storage failures
  }
  return 'bars';
}

export function saveVisualizerMode(mode: VisualizerMode): void {
  try {
    localStorage.setItem(VISUALIZER_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<VisualizerMode>(MODE_EVENT, { detail: mode }));
  }
}

export function subscribeVisualizerMode(listener: (mode: VisualizerMode) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onCustom = (e: Event) => {
    const detail = (e as CustomEvent<VisualizerMode>).detail;
    if (detail === 'bars' || detail === 'mirror' || detail === 'radial') listener(detail);
  };
  window.addEventListener(MODE_EVENT, onCustom);
  return () => window.removeEventListener(MODE_EVENT, onCustom);
}

export interface SpectrumBandInput {
  bandCount: number;
  isPlaying: boolean;
  hasLiveSignal: boolean;
  freqBuffer: Uint8Array;
  dsp: DspSettings;
  nowSec: number;
  currentTime?: number;
  trackSeed?: number;
}

export interface BandEnergySummary {
  bass: number;
  mid: number;
  treble: number;
  overall: number;
}

export function computeSeedSignature(trackId?: string, title?: string): number {
  const input = `${trackId || ''}|${title || ''}`;
  if (!input || input === '|') return 1.0;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 0.75 + ((hash >>> 0) % 500) / 1000;
}

export function sampleSpectrumBands({
  bandCount,
  isPlaying,
  hasLiveSignal,
  freqBuffer,
  dsp,
  nowSec,
  currentTime = 0,
  trackSeed = 1.0,
}: SpectrumBandInput): number[] {
  const count = Math.max(8, bandCount);
  const targets = new Array<number>(count);

  if (!isPlaying) {
    targets.fill(0.02);
    return targets;
  }

  if (hasLiveSignal && freqBuffer.length > 0) {
    const usableBins = Math.min(freqBuffer.length, 56);
    for (let i = 0; i < count; i++) {
      // Quasi-logarithmic mapping gives bass & lower-mid crisp definition while keeping high-end active
      const normIdx = i / Math.max(1, count - 1);
      const curved = Math.pow(normIdx, 1.25);
      const exactBin = curved * (usableBins - 1);
      const b0 = Math.floor(exactBin);
      const b1 = Math.min(usableBins - 1, b0 + 1);
      const frac = exactBin - b0;
      const v0 = freqBuffer[b0] ?? 0;
      const v1 = freqBuffer[b1] ?? v0;
      const raw = (v0 * (1 - frac) + v1 * frac) / 255;
      // Slight high-frequency air compensation so treble bins remain articulate
      const trebleLift = 1 + normIdx * 0.18;
      targets[i] = Math.max(0.03, Math.min(1, raw * 1.08 * trebleLift));
    }
    return targets;
  }

  // Fallback harmonic/DSP synthesis for cross-origin streams (e.g., YouTube IFrame)
  const phaseTime = nowSec + (currentTime % 60) * 0.05;
  for (let i = 0; i < count; i++) {
    const norm = i / Math.max(1, count - 1);
    const bandFloat = norm * 4;
    const b0 = Math.floor(bandFloat);
    const b1 = Math.min(4, b0 + 1);
    const frac = bandFloat - b0;
    const eqDb = (dsp.bands[b0] ?? 0) * (1 - frac) + (dsp.bands[b1] ?? 0) * frac;
    const boostDb = norm < 0.24 && dsp.bassBoostEnabled ? dsp.bassBoostDb * 0.52 : 0;
    const eqScale = Math.max(0.42, Math.min(1.52, 1 + (eqDb + boostDb) / 22));
    const bassRollOff = 0.9 - norm * 0.34;
    const pulse =
      0.32 +
      0.24 * Math.sin(phaseTime * (5.6 * trackSeed) - i * 0.24) +
      0.17 * Math.cos(phaseTime * (10.4 * trackSeed) + i * 0.63) +
      0.13 * Math.sin(phaseTime * 2.8 + i * 0.14);

    targets[i] = Math.max(0.06, Math.min(0.97, pulse * bassRollOff * eqScale));
  }

  return targets;
}

export function computeBandEnergy(bands: number[]): BandEnergySummary {
  if (bands.length === 0) {
    return { bass: 0, mid: 0, treble: 0, overall: 0 };
  }
  const n = bands.length;
  const bassEnd = Math.max(1, Math.floor(n * 0.22));
  const midEnd = Math.max(bassEnd + 1, Math.floor(n * 0.65));

  let bassSum = 0;
  let midSum = 0;
  let trebleSum = 0;
  let allSum = 0;

  for (let i = 0; i < n; i++) {
    const val = bands[i] ?? 0;
    allSum += val;
    if (i < bassEnd) bassSum += val;
    else if (i < midEnd) midSum += val;
    else trebleSum += val;
  }

  return {
    bass: bassSum / bassEnd,
    mid: midSum / Math.max(1, midEnd - bassEnd),
    treble: trebleSum / Math.max(1, n - midEnd),
    overall: allSum / n,
  };
}

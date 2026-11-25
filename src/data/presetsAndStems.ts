import type { DspSettings, EqBands, EqPresetName, Track } from '../types/audio';

export const EQ_FREQUENCIES = [
  { hz: 60, label: '60 Hz', type: 'lowshelf' as const },
  { hz: 230, label: '230 Hz', type: 'peaking' as const },
  { hz: 910, label: '910 Hz', type: 'peaking' as const },
  { hz: 3600, label: '3.6 kHz', type: 'peaking' as const },
  { hz: 14000, label: '14 kHz', type: 'highshelf' as const },
];

export const EQ_PRESETS: Record<EqPresetName, EqBands> = {
  Flat: [0, 0, 0, 0, 0],
  Bass: [6, 4, 0, 0, 0],
  'Heavy Bass': [10, 7, 1, -1, 0],
  Rock: [5, 2, -2, 4, 6],
  Pop: [-1, 2, 5, 3, -1],
  Classical: [4, 2, -1, 3, 5],
  Jazz: [3, 1, 3, 2, 4],
  Electronic: [6, 3, 0, 4, 6],
  'Hip-Hop': [7, 4, 0, 2, 3],
  'Vocal Boost': [-3, -1, 5, 6, 2],
  Acoustic: [3, 2, 2, 4, 3],
  'Treble Boost': [0, 0, 1, 5, 8],
};

export const EQ_PRESET_ORDER: EqPresetName[] = [
  'Flat',
  'Bass',
  'Heavy Bass',
  'Rock',
  'Pop',
  'Classical',
  'Jazz',
  'Electronic',
  'Hip-Hop',
  'Vocal Boost',
  'Acoustic',
  'Treble Boost',
];

export const DEFAULT_DSP_SETTINGS: DspSettings = {
  preset: 'Flat',
  bands: [0, 0, 0, 0, 0],
  bassBoostEnabled: false,
  bassBoostDb: 4,
  crossfadeSeconds: 2.5,
};

export const PROCEDURAL_STEMS: Track[] = [];

export const STREAM_GENRES = [
  'Afrobeats',
  'Hip-Hop',
  'Lo-Fi',
  'Synthwave',
  'Pop',
  'EDM',
  'Rock',
  'R&B',
] as const;

export const CURATED_STREAM_BANK: Track[] = [];

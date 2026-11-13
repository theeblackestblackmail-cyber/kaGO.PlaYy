export type ActiveTab = 'dashboard' | 'stream' | 'library' | 'scanner' | 'lyrics';

export type LibrarySubTab = 'all' | 'folders' | 'playlists' | 'albums' | 'artists' | 'favorites';

export type EqPresetName =
  | 'Flat'
  | 'Bass'
  | 'Heavy Bass'
  | 'Rock'
  | 'Pop'
  | 'Classical'
  | 'Jazz'
  | 'Electronic'
  | 'Hip-Hop'
  | 'Vocal Boost'
  | 'Acoustic'
  | 'Treble Boost';

export type EqBands = [number, number, number, number, number]; // 60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz

export interface DspSettings {
  preset: EqPresetName | 'Custom';
  bands: EqBands;
  bassBoostEnabled: boolean;
  bassBoostDb: number; // 0 to 14
  crossfadeSeconds: number; // 0 to 12
}

export type TrackSource = 'synth' | 'local' | 'stream';

export interface SynthProfile {
  bpm: number;
  rootFreq: number;
  scale: number[];
  patternStyle: 'cyber' | 'neon' | 'midnight' | 'tokyo';
  description: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // seconds
  source: TrackSource;
  artworkUrl?: string;
  streamUrl?: string;
  youtubeId?: string;
  streamProvider?: 'youtube' | 'audius' | 'synth';
  folderPath?: string;
  trackNumber?: number;
  genre?: string;
  bpm?: number;
  rootFreq?: number;
  synthProfile?: SynthProfile;
  isFavorite?: boolean;
  addedAt: number;
  lrcLyrics?: string;
  recoveredFrom?: string;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  trackIds: string[];
  createdAt: number;
}

export interface LyricLine {
  time: number; // seconds
  text: string;
}

export interface StoredLyrics {
  trackId: string;
  rawLrc: string;
  offsetSeconds: number;
  updatedAt: number;
}

export interface AudioEngineSnapshot {
  activeChannel: 'A' | 'B';
  syncedChannels: number;
  isPlaying: boolean;
  isCrossfading: boolean;
  currentTime: number;
  duration: number;
  sampleRate: number;
  currentTrack: Track | null;
}

export interface StudioUser {
  id: string;
  name: string;
  joinedAt: number;
}

export interface StudioQueueItem {
  id: string;
  track: Track;
  addedBy: string;
  addedAt: number;
  upvotes: number;
  voterIds: string[];
}

export interface StudioChatMessage {
  id: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  type: 'chat' | 'system';
}

export interface StudioPlaybackState {
  track: Track;
  startedAt: number;
  isPlaying: boolean;
  triggeredBy: string;
}

export interface StudioRoomState {
  userCount: number;
  users: StudioUser[];
  queue: StudioQueueItem[];
  nowPlaying: StudioPlaybackState | null;
  messages: StudioChatMessage[];
}

import type {
  ActiveTab,
  DspSettings,
  EqPresetName,
  LibrarySubTab,
  Track,
} from '../types/audio';
import { DOWNLOAD_FORMAT_MAP, type DownloadFormatId } from './streamDownloads';

export interface AiIdentifiedCandidate {
  title: string;
  artist: string;
  reason?: string;
  confidence?: string;
}

export type AiAssistantAction =
  | {
      type: 'play_song';
      query: string;
      title?: string;
      artist?: string;
      mode: 'ask_confirm' | 'play_now' | 'play_next' | 'add_to_queue';
    }
  | {
      type: 'identify_song_candidates';
      candidates: AiIdentifiedCandidate[];
    }
  | {
      type: 'create_playlist';
      name: string;
      description: string;
      trackQueries: string[];
      autoPlay?: boolean;
    }
  | {
      type: 'control_playback';
      command:
        | 'play'
        | 'pause'
        | 'toggle'
        | 'next'
        | 'previous'
        | 'seek_relative'
        | 'toggle_shuffle'
        | 'toggle_autoplay_radio'
        | 'open_fullscreen'
        | 'open_lyrics'
        | 'open_dsp'
        | 'open_live_studio'
        | 'pick_song'
        | 'pick_folder';
      valueSeconds?: number;
    }
  | {
      type: 'update_dsp';
      eqPreset?: EqPresetName;
      bassBoostEnabled?: boolean;
      bassBoostDb?: number;
      crossfadeSeconds?: number;
    }
  | {
      type: 'navigate_tab';
      tab: ActiveTab;
      librarySubTab?: LibrarySubTab;
      searchQuery?: string;
    }
  | {
      type: 'download_current_track';
      destination: 'app' | 'device';
      formatId?: DownloadFormatId;
    }
  | {
      type: 'toggle_favorite_current';
      favorite: boolean;
    }
  | {
      type: 'play_library_match';
      query: string;
      mode: 'play_now' | 'queue';
    };

export interface AiAssistantSource {
  title: string;
  uri: string;
}

export interface AiAssistantHistoryItem {
  role: 'user' | 'model';
  text: string;
}

export interface AiAssistantContextPayload {
  currentTrack?: {
    id: string;
    title: string;
    artist: string;
    album: string;
    source: Track['source'];
    duration: number;
    currentTime: number;
    genre?: string;
  } | null;
  isPlaying: boolean;
  isFullscreenOpen: boolean;
  activeTab: ActiveTab;
  dsp: Pick<DspSettings, 'preset' | 'bassBoostEnabled' | 'bassBoostDb' | 'crossfadeSeconds'>;
  playlistNames: string[];
  libraryTracksCount: number;
}

export interface AiAssistantResponse {
  reply: string;
  transcript?: string;
  actions: AiAssistantAction[];
  sources: AiAssistantSource[];
}

const ALLOWED_AUDIO_MIME_PREFIXES = [
  'audio/webm',
  'audio/mp4',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/flac',
];

const VALID_EQ_PRESETS = new Set<EqPresetName>([
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
]);

const VALID_TABS = new Set<ActiveTab>([
  'dashboard',
  'stream',
  'library',
  'settings',
  'search',
  'scanner',
  'lyrics',
]);

const VALID_LIBRARY_SUBTABS = new Set<LibrarySubTab>([
  'all',
  'downloads',
  'folders',
  'playlists',
  'albums',
  'artists',
  'favorites',
]);

const VALID_PLAYBACK_COMMANDS = new Set<
  Extract<AiAssistantAction, { type: 'control_playback' }>['command']
>([
  'play',
  'pause',
  'toggle',
  'next',
  'previous',
  'seek_relative',
  'toggle_shuffle',
  'toggle_autoplay_radio',
  'open_fullscreen',
  'open_lyrics',
  'open_dsp',
  'open_live_studio',
  'pick_song',
  'pick_folder',
]);

export function normalizeAudioMimeType(rawMime: string): string {
  const base = (rawMime || '').split(';')[0].trim().toLowerCase();
  if (!base) return 'audio/webm';
  return base;
}

export function isAllowedAudioMimeType(rawMime: string): boolean {
  const normalized = normalizeAudioMimeType(rawMime);
  return ALLOWED_AUDIO_MIME_PREFIXES.includes(normalized);
}

export function sanitizeHttpUrl(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildAiTrackSearchQuery(candidate: { title?: string; artist?: string; query?: string }): string {
  const q = (candidate.query || '').trim();
  if (q) return q;
  const artist = (candidate.artist || '').trim();
  const title = (candidate.title || '').trim();
  return [artist, title].filter(Boolean).join(' - ').trim();
}

export function formatRecordingTimer(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function pickSupportedRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // Try next codec
    }
  }
  return '';
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = res.indexOf(',');
      resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
    };
    reader.onerror = () => reject(new Error('Failed to encode audio recording.'));
    reader.readAsDataURL(blob);
  });
}

function asTrimmedString(val: unknown, maxLen = 240): string {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

export function parseFunctionCallsToActions(
  functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }> | null
): AiAssistantAction[] {
  if (!Array.isArray(functionCalls) || functionCalls.length === 0) return [];
  const actions: AiAssistantAction[] = [];

  for (const call of functionCalls) {
    const name = asTrimmedString(call?.name, 80);
    const args = (call?.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;

    if (name === 'play_song') {
      const title = asTrimmedString(args.title, 160);
      const artist = asTrimmedString(args.artist, 120);
      const query = asTrimmedString(args.query, 200) || buildAiTrackSearchQuery({ title, artist });
      if (!query) continue;
      const rawMode = asTrimmedString(args.mode, 32);
      const mode: 'ask_confirm' | 'play_now' | 'play_next' | 'add_to_queue' =
        rawMode === 'play_now' || rawMode === 'play_next' || rawMode === 'add_to_queue'
          ? rawMode
          : 'ask_confirm';
      actions.push({
        type: 'play_song',
        query,
        title: title || undefined,
        artist: artist || undefined,
        mode,
      });
      continue;
    }

    if (name === 'identify_song_candidates') {
      const rawList = Array.isArray(args.candidates) ? args.candidates : [];
      const candidates: AiIdentifiedCandidate[] = [];
      for (const entry of rawList.slice(0, 5)) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const title = asTrimmedString(item.title, 160);
        const artist = asTrimmedString(item.artist, 120);
        if (!title) continue;
        candidates.push({
          title,
          artist: artist || 'Unknown Artist',
          reason: asTrimmedString(item.reason, 220) || undefined,
          confidence: asTrimmedString(item.confidence, 32) || undefined,
        });
      }
      if (candidates.length > 0) {
        actions.push({ type: 'identify_song_candidates', candidates });
      }
      continue;
    }

    if (name === 'create_playlist') {
      const plName = asTrimmedString(args.name, 80) || 'AI Curated Mix';
      const description = asTrimmedString(args.description, 220);
      const rawQueries = Array.isArray(args.trackQueries) ? args.trackQueries : [];
      const trackQueries = rawQueries
        .map((q) => asTrimmedString(q, 160))
        .filter(Boolean)
        .slice(0, 15);
      if (trackQueries.length === 0) continue;
      actions.push({
        type: 'create_playlist',
        name: plName,
        description,
        trackQueries,
        autoPlay: Boolean(args.autoPlay),
      });
      continue;
    }

    if (name === 'control_playback') {
      const command = asTrimmedString(args.command, 40) as Extract<
        AiAssistantAction,
        { type: 'control_playback' }
      >['command'];
      if (!VALID_PLAYBACK_COMMANDS.has(command)) continue;
      const valueSeconds =
        typeof args.valueSeconds === 'number' && Number.isFinite(args.valueSeconds)
          ? Math.max(-600, Math.min(600, Math.round(args.valueSeconds)))
          : undefined;
      actions.push({ type: 'control_playback', command, valueSeconds });
      continue;
    }

    if (name === 'update_dsp') {
      const rawPreset = asTrimmedString(args.eqPreset, 40) as EqPresetName;
      const eqPreset = VALID_EQ_PRESETS.has(rawPreset) ? rawPreset : undefined;
      const bassBoostEnabled =
        typeof args.bassBoostEnabled === 'boolean' ? args.bassBoostEnabled : undefined;
      const bassBoostDb =
        typeof args.bassBoostDb === 'number' && Number.isFinite(args.bassBoostDb)
          ? Math.max(0, Math.min(14, Math.round(args.bassBoostDb)))
          : undefined;
      const crossfadeSeconds =
        typeof args.crossfadeSeconds === 'number' && Number.isFinite(args.crossfadeSeconds)
          ? Math.max(0, Math.min(12, Math.round(args.crossfadeSeconds * 2) / 2))
          : undefined;

      if (
        eqPreset !== undefined ||
        bassBoostEnabled !== undefined ||
        bassBoostDb !== undefined ||
        crossfadeSeconds !== undefined
      ) {
        actions.push({
          type: 'update_dsp',
          eqPreset,
          bassBoostEnabled,
          bassBoostDb,
          crossfadeSeconds,
        });
      }
      continue;
    }

    if (name === 'navigate_tab') {
      const tab = asTrimmedString(args.tab, 32) as ActiveTab;
      if (!VALID_TABS.has(tab)) continue;
      const rawSub = asTrimmedString(args.librarySubTab, 32) as LibrarySubTab;
      const librarySubTab = VALID_LIBRARY_SUBTABS.has(rawSub) ? rawSub : undefined;
      const searchQuery = asTrimmedString(args.searchQuery, 140) || undefined;
      actions.push({ type: 'navigate_tab', tab, librarySubTab, searchQuery });
      continue;
    }

    if (name === 'download_current_track') {
      const rawDest = asTrimmedString(args.destination, 20);
      const destination: 'app' | 'device' = rawDest === 'device' ? 'device' : 'app';
      const rawFmt = asTrimmedString(args.formatId, 24) as DownloadFormatId;
      const formatId = rawFmt && rawFmt in DOWNLOAD_FORMAT_MAP ? rawFmt : undefined;
      actions.push({ type: 'download_current_track', destination, formatId });
      continue;
    }

    if (name === 'toggle_favorite_current') {
      const favorite = typeof args.favorite === 'boolean' ? args.favorite : true;
      actions.push({ type: 'toggle_favorite_current', favorite });
      continue;
    }

    if (name === 'play_library_match') {
      const query = asTrimmedString(args.query, 140);
      if (!query) continue;
      const mode = asTrimmedString(args.mode, 20) === 'queue' ? 'queue' : 'play_now';
      actions.push({ type: 'play_library_match', query, mode });
      continue;
    }
  }

  return actions;
}

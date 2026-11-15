import type { TrackSource } from '../types/audio';

export type WatchdogAction =
  | 'none'
  | 'resume_context'
  | 'nudge_resume'
  | 'reload_audio_at_position'
  | 'recover_stream';

export interface PlaybackPauseCheckInput {
  isPlaying: boolean;
  userPausedAt: number;
  nowMs: number;
  visibilityState: string;
  backgroundTransitionUntil: number;
  isIframeFocused?: boolean;
  wasAudioEnded?: boolean;
}

/**
 * Determines whether a PAUSED event from YouTube IFrame or HTML5 <audio> is an
 * involuntary OS/WebView/YouTube interruption (background lock, audio focus duck,
 * "Continue watching?" timeout, WebView surface swap) vs an intentional user pause.
 */
export function shouldAutoResumePlaybackPause(input: PlaybackPauseCheckInput): boolean {
  if (!input.isPlaying || input.wasAudioEnded) {
    return false;
  }
  if (input.userPausedAt > 0 && input.nowMs - input.userPausedAt < 3000) {
    return false;
  }
  if (input.visibilityState !== 'visible' || input.nowMs < input.backgroundTransitionUntil) {
    return true;
  }
  // If foregrounded and user did NOT click inside the YouTube iframe itself, treat unexpected pauses
  // (e.g. "Continue watching?" / transient Bluetooth or notification focus loss) as involuntary.
  return !input.isIframeFocused;
}

/**
 * Detects whether an HTTP audio stream fired `ended` prematurely due to a dropped TCP/chunked response
 * well before the song's real duration.
 */
export function isPrematureStreamEnded(params: {
  source?: TrackSource;
  currentTime: number;
  expectedDuration: number;
  isOnline: boolean;
  retriesUsed: number;
  maxRetries?: number;
}): boolean {
  const maxRetries = params.maxRetries ?? 2;
  if (params.source !== 'stream' || !params.isOnline) {
    return false;
  }
  if (params.retriesUsed >= maxRetries) {
    return false;
  }
  if (!Number.isFinite(params.expectedDuration) || params.expectedDuration <= 30) {
    return false;
  }
  if (!Number.isFinite(params.currentTime) || params.currentTime < 3) {
    return false;
  }
  // Ending > 12 seconds early on a streaming track indicates a truncated upstream connection
  return params.currentTime < params.expectedDuration - 12;
}

export interface WatchdogEvalInput {
  isPlaying: boolean;
  isCrossfading: boolean;
  userPausedAt: number;
  nowMs: number;
  audioContextState?: string;
  source: TrackSource;
  isYouTube: boolean;
  ytPlayerState?: number;
  isIframeFocused?: boolean;
  audioPaused?: boolean;
  audioEnded?: boolean;
  audioReadyState?: number;
  currentTime: number;
  lastProgressAtMs: number;
  isOnline: boolean;
  nudgeCount: number;
  recoverCount: number;
  lastNudgeAtMs: number;
  lastRecoverAtMs: number;
}

export const STALL_NUDGE_MS = 7000;
export const STALL_RECOVER_MS = 15000;
export const NUDGE_COOLDOWN_MS = 5000;
export const RECOVER_COOLDOWN_MS = 10000;

/**
 * Pure watchdog evaluator run periodically while playback is active to catch and heal
 * mid-song stalls, suspended AudioContexts, spurious element pauses, or stream drops.
 */
export function evaluatePlaybackWatchdog(input: WatchdogEvalInput): WatchdogAction {
  if (!input.isPlaying) {
    return 'none';
  }
  if (input.userPausedAt > 0 && input.nowMs - input.userPausedAt < 3000) {
    return 'none';
  }

  // 1. Always wake suspended/interrupted Web Audio contexts immediately
  if (
    !input.isYouTube &&
    input.audioContextState &&
    input.audioContextState !== 'running'
  ) {
    return 'resume_context';
  }

  // 2. Catch unexpected PAUSED(2) / CUED(5) / UNSTARTED(-1) states on YouTube mid-song
  if (input.isYouTube && typeof input.ytPlayerState === 'number') {
    const unexpectedYtStop =
      input.ytPlayerState === 2 || input.ytPlayerState === 5 || input.ytPlayerState === -1;
    if (
      unexpectedYtStop &&
      !input.isIframeFocused &&
      input.nowMs - input.lastNudgeAtMs >= NUDGE_COOLDOWN_MS
    ) {
      return 'nudge_resume';
    }
  }

  // 3. Catch unexpected pause on HTML5 <audio> mid-song
  if (
    !input.isYouTube &&
    input.source !== 'synth' &&
    input.audioPaused &&
    !input.audioEnded &&
    input.nowMs - input.lastNudgeAtMs >= NUDGE_COOLDOWN_MS
  ) {
    return 'nudge_resume';
  }

  if (input.isCrossfading || input.lastProgressAtMs <= 0) {
    return 'none';
  }

  const stalledMs = Math.max(0, input.nowMs - input.lastProgressAtMs);

  // 4. Escalate severe mid-song stall (>= 15s without advancing)
  if (stalledMs >= STALL_RECOVER_MS) {
    if (
      input.source === 'stream' &&
      input.isOnline &&
      input.recoverCount < 2 &&
      input.nowMs - input.lastRecoverAtMs >= RECOVER_COOLDOWN_MS
    ) {
      return 'recover_stream';
    }
    if (
      !input.isYouTube &&
      input.source === 'local' &&
      input.recoverCount < 2 &&
      input.nowMs - input.lastRecoverAtMs >= RECOVER_COOLDOWN_MS
    ) {
      return 'reload_audio_at_position';
    }
  }

  // 5. Gentle nudge for moderate stall (>= 7s without advancing)
  if (
    stalledMs >= STALL_NUDGE_MS &&
    input.nudgeCount < 2 &&
    input.nowMs - input.lastNudgeAtMs >= NUDGE_COOLDOWN_MS
  ) {
    if (
      !input.isYouTube &&
      input.source === 'stream' &&
      typeof input.audioReadyState === 'number' &&
      input.audioReadyState < 2 &&
      input.isOnline
    ) {
      return 'reload_audio_at_position';
    }
    return 'nudge_resume';
  }

  return 'none';
}

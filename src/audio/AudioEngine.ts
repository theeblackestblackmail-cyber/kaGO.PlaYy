import { DEFAULT_DSP_SETTINGS, EQ_FREQUENCIES } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type { AudioEngineSnapshot, DspSettings, Track } from '../types/audio';
import {
  hasNativeHttpBridge,
  isNativeAndroidApp,
  nativeFetchText,
  subscribeNativeKeepalive,
} from '../utils/nativeMediaBridge';
import {
  clampCrossfadeSeconds,
  computeMasterOutputGain,
  extractYouTubeSearchResults,
  rankYouTubeSearchResults,
  selectActiveYouTubeViewport,
} from '../utils/streamFilter';
import {
  evaluatePlaybackWatchdog,
  isPrematureStreamEnded,
  shouldAutoResumePlaybackPause,
} from '../utils/playbackStability';
import {
  computePreloadEvictions,
  evaluateNetworkStability,
  PRELOAD_SETTLE_DELAY_MS,
  PROACTIVE_PRELOAD_COUNT,
  selectUpcomingPreloadTracks,
} from '../utils/proactiveBuffer';

type Listener = (snapshot: AudioEngineSnapshot) => void;
type TrackEndListener = () => void;

interface NetworkConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  addEventListener?: (type: string, listener: () => void) => void;
}

interface PreloadEntry {
  trackId: string;
  status: 'pending' | 'ready' | 'failed';
  controller: AbortController;
  blob?: Blob;
  audioEl?: HTMLAudioElement;
  resolvedStreamUrl?: string;
  resolvedYoutubeId?: string;
  updatedAt: number;
}

interface YtPlayerInstance {
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  setVolume: (volume: number) => void;
  unMute?: () => void;
  isMuted?: () => boolean;
  getVolume?: () => number;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
}

interface YtNamespace {
  Player: new (
    elementId: string,
    options: {
      height?: string | number;
      width?: string | number;
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YtPlayerInstance }) => void;
        onStateChange?: (event: { data: number; target: YtPlayerInstance }) => void;
        onError?: (event: { data: number; target: YtPlayerInstance }) => void;
      };
    }
  ) => YtPlayerInstance;
  PlayerState?: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
  };
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface ChannelStrip {
  id: 'A' | 'B';
  gainNode: GainNode;
  audioEl: HTMLAudioElement;
  mediaSource: MediaElementAudioSourceNode;
  objectUrl: string | null;
  fadeTimer: number | null;
}

class DualChannelAudioEngine {
  private ctx: AudioContext | null = null;
  private eqFilters: BiquadFilterNode[] = [];
  private bassBoostFilter: BiquadFilterNode | null = null;
  private masterGainNode: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private channelA: ChannelStrip | null = null;
  private channelB: ChannelStrip | null = null;

  private dspSettings: DspSettings = localDb.loadDspSettings();
  private activeChannel: 'A' | 'B' = 'A';
  private isPlaying = false;
  private isCrossfading = false;
  private isBuffering = false;
  private streamErrorCount = 0;
  private currentTrack: Track | null = null;
  private currentTime = 0;
  private duration = 0;

  private ytActive = false;
  private ytPlayer: YtPlayerInstance | null = null;
  private ytReady = false;
  private ytLoadPromise: Promise<YtPlayerInstance | null> | null = null;
  private ytTickTimer: number | null = null;
  private ytVolumeTimer: number | null = null;
  private ytStartupTimer: number | null = null;
  private ytRecoveryAttempts = 0;
  private playSeq = 0;
  private ytViewports = new Map<
    HTMLElement,
    { zIndex: number; order: number; observer: ResizeObserver | null }
  >();
  private ytViewportSeq = 0;
  private ytWasHostVisible = false;
  private ytSettleTimers: number[] = [];
  private ytPositionMonitorTimer: number | null = null;
  private ytCompositorNudgeRaf1: number | null = null;
  private ytCompositorNudgeRaf2: number | null = null;
  private ytSyncListenerBound = false;
  private backgroundTransitionUntil = 0;
  private userPausedAt = 0;
  private bgKeepaliveTimer: number | null = null;
  private bgListenersBound = false;
  private watchdogTrackId: string | null = null;
  private watchdogPos = 0;
  private watchdogLastMovedAt = 0;
  private watchdogNudgeCount = 0;
  private watchdogRecoverCount = 0;
  private watchdogLastNudgeAt = 0;
  private watchdogLastRecoverAt = 0;
  private prematureEndRetries = 0;
  private audioReloadInFlight = false;
  private lastCompositorNudgeAt = 0;
  private upcomingQueue: Track[] = [];
  private preloadPool = new Map<string, PreloadEntry>();
  private preloadTimer: number | null = null;
  private preloadInFlight = false;
  private trackStartedAtMs = 0;
  private lastOnlineAtMs = 0;
  private preloadRetryCooldown = new Map<string, number>();

  private listeners = new Set<Listener>();
  private endListeners = new Set<TrackEndListener>();

  constructor() {
    this.bindBackgroundListeners();
  }

  private bindBackgroundListeners() {
    if (this.bgListenersBound || typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }
    this.bgListenersBound = true;

    const triggerKeepalive = () => {
      if (!this.isPlaying) return;
      this.handleBackgroundTransition();
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (this.ytActive && this.ytViewports.size > 0) {
          this.syncYouTubeHostGeometry(true);
          this.scheduleYouTubeGeometrySettle();
        }
      } else if (this.isPlaying) {
        this.handleBackgroundTransition();
      }
    });
    window.addEventListener('pagehide', triggerKeepalive);
    window.addEventListener('blur', triggerKeepalive);
    window.addEventListener('online', () => {
      this.lastOnlineAtMs = Date.now();
      this.preloadRetryCooldown.clear();
      if (this.isPlaying) {
        this.scheduleProactivePreload(PRELOAD_SETTLE_DELAY_MS);
      }
      if (!this.isPlaying || !this.currentTrack) return;
      if (this.currentTrack.source === 'stream') {
        this.watchdogNudgeCount = 0;
        this.watchdogLastNudgeAt = 0;
        this.watchdogLastRecoverAt = 0;
        this.ensurePlaybackAliveNow();
        window.setTimeout(() => this.runPlaybackWatchdogTick(), 600);
      }
    });

    const netConn = (navigator as Navigator & { connection?: NetworkConnectionLike }).connection;
    netConn?.addEventListener?.('change', () => {
      if (this.isPlaying) {
        this.scheduleProactivePreload(600);
      }
    });
    subscribeNativeKeepalive(() => triggerKeepalive());
  }

  private isRecentlyUserPaused(): boolean {
    return this.userPausedAt > 0 && Date.now() - this.userPausedAt < 3000;
  }

  private isYtIframeFocused(): boolean {
    if (typeof document === 'undefined') return false;
    if (document.visibilityState !== 'visible') return false;
    if (Date.now() - this.lastCompositorNudgeAt < 1200) return false;
    return document.activeElement?.id === 'kago-yt-frame';
  }

  private resetWatchdog(trackId: string | null) {
    const now = Date.now();
    this.watchdogTrackId = trackId;
    this.watchdogPos = 0;
    this.watchdogLastMovedAt = now;
    this.watchdogNudgeCount = 0;
    this.watchdogRecoverCount = 0;
    this.watchdogLastNudgeAt = 0;
    this.watchdogLastRecoverAt = 0;
    this.prematureEndRetries = 0;
    this.audioReloadInFlight = false;
  }

  private noteProgress(pos: number, force = false) {
    if (!Number.isFinite(pos) || pos < 0) return;
    const curId = this.currentTrack?.id ?? null;
    if (curId !== this.watchdogTrackId) {
      this.resetWatchdog(curId);
    }
    if (force || Math.abs(pos - this.watchdogPos) >= 0.25) {
      this.watchdogPos = pos;
      this.watchdogLastMovedAt = Date.now();
      this.watchdogNudgeCount = 0;
    }
  }

  private handleBackgroundTransition() {
    if (!this.isPlaying) return;
    if (this.isRecentlyUserPaused()) return;

    this.backgroundTransitionUntil = Date.now() + 8000;
    this.ensurePlaybackAliveNow();
    for (const delay of [40, 120, 280, 550, 950]) {
      window.setTimeout(() => this.ensurePlaybackAliveNow(), delay);
    }
    this.startBgKeepalive();
  }

  private ensurePlaybackAliveNow() {
    if (!this.isPlaying || !this.currentTrack) return;
    if (this.isRecentlyUserPaused()) return;

    if (this.ctx && this.ctx.state !== 'running') {
      void this.ctx.resume().catch(() => {});
    }

    if (this.ytActive && this.ytPlayer && this.ytReady) {
      try {
        const state = this.ytPlayer.getPlayerState();
        const statePaused = window.YT?.PlayerState?.PAUSED ?? 2;
        if ((state === statePaused || state === 5 || state === -1) && !this.isYtIframeFocused()) {
          this.ytPlayer.playVideo();
        }
      } catch {
        // Ignore transient YouTube API errors
      }
      this.startYtTicker();
      return;
    }

    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (active && active.audioEl.src && active.audioEl.paused && !active.audioEl.ended) {
      void active.audioEl.play().catch(() => {});
    }
  }

  private async reloadActiveAudioAtPosition(resumeSeconds: number) {
    if (this.audioReloadInFlight) return;
    const track = this.currentTrack;
    const seq = this.playSeq;
    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (!track || !active || this.ytActive || !this.isPlaying || this.isRecentlyUserPaused()) {
      return;
    }

    this.audioReloadInFlight = true;
    const safeSeek = Math.max(0, Math.floor(resumeSeconds));
    try {
      const ctx = this.ensureContext();
      if (ctx.state !== 'running') {
        await ctx.resume().catch(() => {});
      }

      const attachAndResume = async (srcUrl: string): Promise<boolean> => {
        if (seq !== this.playSeq || !this.isPlaying) return false;
        return new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            active.audioEl.removeEventListener('loadedmetadata', onMeta);
            active.audioEl.removeEventListener('error', onErr);
            window.clearTimeout(timer);
            resolve(ok);
          };
          const onMeta = () => {
            if (safeSeek > 0 && Number.isFinite(active.audioEl.duration) && safeSeek < active.audioEl.duration - 1) {
              try {
                active.audioEl.currentTime = safeSeek;
              } catch {
                // Ignore seek bounds error
              }
            }
            active.audioEl.volume = 1.0;
            active.audioEl.muted = false;
            void active.audioEl
              .play()
              .then(() => finish(true))
              .catch(() => finish(false));
          };
          const onErr = () => finish(false);
          const timer = window.setTimeout(() => finish(false), 7500);

          active.audioEl.addEventListener('loadedmetadata', onMeta, { once: true });
          active.audioEl.addEventListener('error', onErr, { once: true });
          active.audioEl.src = srcUrl;
          active.audioEl.load();
        });
      };

      if (track.source === 'local' || track.isAppDownload) {
        const blob = await localDb.getAudioBlob(track.id);
        if (seq !== this.playSeq || !this.isPlaying) return;
        if (blob) {
          if (active.objectUrl) {
            URL.revokeObjectURL(active.objectUrl);
          }
          const url = URL.createObjectURL(blob);
          active.objectUrl = url;
          const ok = await attachAndResume(url);
          if (ok) {
            this.isBuffering = false;
            this.noteProgress(safeSeek, true);
            this.emit();
            return;
          }
        }
      }

      if (track.streamUrl) {
        const isCurrentlyProxied = active.audioEl.src.includes('/api/stream/proxy');
        const directUrl = track.streamUrl;
        const proxiedUrl =
          track.streamUrl.startsWith('http') && !track.streamUrl.startsWith(window.location.origin)
            ? `/api/stream/proxy?url=${encodeURIComponent(track.streamUrl)}`
            : track.streamUrl;

        const candidates = isCurrentlyProxied ? [proxiedUrl, directUrl] : [directUrl, proxiedUrl];
        for (const candidate of candidates) {
          const ok = await attachAndResume(candidate);
          if (ok) {
            this.isBuffering = false;
            this.noteProgress(safeSeek, true);
            this.emit();
            return;
          }
        }
      }

      if (seq === this.playSeq && track.source === 'stream') {
        await this.recoverActiveYouTubeTrack(track, seq, safeSeek, true);
      }
    } finally {
      this.audioReloadInFlight = false;
    }
  }

  private runPlaybackWatchdogTick() {
    if (!this.isPlaying || !this.currentTrack) return;
    const nowMs = Date.now();
    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;

    let ytState: number | undefined;
    if (this.ytActive && this.ytPlayer && this.ytReady) {
      try {
        ytState = this.ytPlayer.getPlayerState();
      } catch {
        ytState = undefined;
      }
    }

    const action = evaluatePlaybackWatchdog({
      isPlaying: this.isPlaying,
      isCrossfading: this.isCrossfading,
      userPausedAt: this.userPausedAt,
      nowMs,
      audioContextState: this.ctx?.state,
      source: this.currentTrack.source,
      isYouTube: this.ytActive,
      ytPlayerState: ytState,
      isIframeFocused: this.isYtIframeFocused(),
      audioPaused: active?.audioEl.paused,
      audioEnded: active?.audioEl.ended,
      audioReadyState: active?.audioEl.readyState,
      currentTime: this.currentTime,
      lastProgressAtMs: this.watchdogLastMovedAt,
      isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
      nudgeCount: this.watchdogNudgeCount,
      recoverCount: this.watchdogRecoverCount,
      lastNudgeAtMs: this.watchdogLastNudgeAt,
      lastRecoverAtMs: this.watchdogLastRecoverAt,
    });

    if (action === 'none') return;

    if (action === 'resume_context') {
      if (this.ctx && this.ctx.state !== 'running') {
        void this.ctx.resume().catch(() => {});
      }
      return;
    }

    if (action === 'nudge_resume') {
      this.watchdogNudgeCount += 1;
      this.watchdogLastNudgeAt = nowMs;
      if (this.ytActive && this.ytPlayer && this.ytReady) {
        try {
          if (nowMs - this.watchdogLastMovedAt >= 6500 && this.currentTime > 1) {
            this.ytPlayer.seekTo(Math.max(0, this.currentTime), true);
          }
          this.ytPlayer.unMute?.();
          this.ytPlayer.playVideo();
        } catch {
          // Ignore transient YouTube API errors
        }
      } else if (active && active.audioEl.src && !active.audioEl.ended) {
        void active.audioEl.play().catch(() => {});
      }
      return;
    }

    if (action === 'reload_audio_at_position') {
      this.watchdogRecoverCount += 1;
      this.watchdogLastRecoverAt = nowMs;
      void this.reloadActiveAudioAtPosition(this.currentTime);
      return;
    }

    if (action === 'recover_stream') {
      this.watchdogRecoverCount += 1;
      this.watchdogLastRecoverAt = nowMs;
      if (this.ytActive) {
        void this.recoverActiveYouTubeTrack(
          this.currentTrack,
          this.playSeq,
          Math.max(0, Math.floor(this.currentTime)),
          this.watchdogRecoverCount > 1
        );
      } else {
        void this.reloadActiveAudioAtPosition(this.currentTime);
      }
    }
  }

  private startBgKeepalive() {
    if (this.bgKeepaliveTimer !== null || typeof window === 'undefined') return;
    this.bgKeepaliveTimer = window.setInterval(() => {
      if (!this.isPlaying) {
        this.stopBgKeepalive();
        return;
      }
      this.runPlaybackWatchdogTick();
      const inBackground =
        (typeof document !== 'undefined' && document.visibilityState !== 'visible') ||
        isNativeAndroidApp();
      if (inBackground) {
        this.ensurePlaybackAliveNow();
      }
    }, 750);
  }

  private stopBgKeepalive() {
    if (this.bgKeepaliveTimer !== null) {
      clearInterval(this.bgKeepaliveTimer);
      this.bgKeepaliveTimer = null;
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  onTrackEnd(fn: TrackEndListener): () => void {
    this.endListeners.add(fn);
    return () => {
      this.endListeners.delete(fn);
    };
  }

  getSnapshot(): AudioEngineSnapshot {
    return {
      activeChannel: this.activeChannel,
      syncedChannels: 2,
      isPlaying: this.isPlaying,
      isCrossfading: this.isCrossfading,
      isBuffering: this.isBuffering,
      streamErrorCount: this.streamErrorCount,
      currentTime: this.currentTime,
      duration: this.duration,
      sampleRate: this.ctx?.sampleRate || 48000,
      currentTrack: this.currentTrack,
    };
  }

  getDspSettings(): DspSettings {
    return this.dspSettings;
  }

  getFrequencyData(target: Uint8Array): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(target as Uint8Array<ArrayBuffer>);
    return true;
  }

  getTimeDomainData(target: Uint8Array): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteTimeDomainData(target as Uint8Array<ArrayBuffer>);
    return true;
  }

  getAnalyserBinCount(): number {
    return this.analyser ? this.analyser.frequencyBinCount : 64;
  }

  setUpcomingQueue(queue: Track[]): void {
    this.upcomingQueue = queue;
    this.reconcilePreloadEvictions();
    if (this.isPlaying || this.currentTrack) {
      this.scheduleProactivePreload(650);
    }
  }

  getPreloadSnapshot(): Array<{ trackId: string; status: PreloadEntry['status'] }> {
    return Array.from(this.preloadPool.values()).map((entry) => ({
      trackId: entry.trackId,
      status: entry.status,
    }));
  }

  private getNetworkStability() {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const conn = (nav as (Navigator & { connection?: NetworkConnectionLike }) | undefined)?.connection;
    return evaluateNetworkStability({
      isOnline: nav ? nav.onLine : true,
      saveData: conn?.saveData,
      effectiveType: conn?.effectiveType,
      downlinkMbps: conn?.downlink,
      rttMs: conn?.rtt,
      isStreamingTrack: this.currentTrack?.source === 'stream',
      isBuffering: this.isBuffering,
      streamErrorCount: this.streamErrorCount,
      nowMs: Date.now(),
      trackStartedAtMs: this.trackStartedAtMs,
      lastOnlineAtMs: this.lastOnlineAtMs,
    });
  }

  private evictPreloadEntry(trackId: string) {
    const entry = this.preloadPool.get(trackId);
    if (!entry) return;
    entry.controller.abort();
    if (entry.audioEl) {
      try {
        entry.audioEl.pause();
        entry.audioEl.removeAttribute('src');
        entry.audioEl.load();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.preloadPool.delete(trackId);
  }

  private reconcilePreloadEvictions(): Track[] {
    const targets = selectUpcomingPreloadTracks(
      this.upcomingQueue,
      this.currentTrack?.id,
      PROACTIVE_PRELOAD_COUNT
    );
    const { toEvict } = computePreloadEvictions(this.preloadPool.keys(), targets);
    for (const staleId of toEvict) {
      this.evictPreloadEntry(staleId);
    }
    return targets;
  }

  private scheduleProactivePreload(delayMs = 500) {
    if (typeof window === 'undefined') return;
    if (this.preloadTimer !== null) {
      window.clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
    this.preloadTimer = window.setTimeout(() => {
      this.preloadTimer = null;
      void this.runProactivePreload();
    }, delayMs);
  }

  private async warmLocalTrackPreload(track: Track, entry: PreloadEntry): Promise<void> {
    if (entry.controller.signal.aborted) return;
    try {
      const blob = await localDb.getAudioBlob(track.id);
      if (entry.controller.signal.aborted) return;
      if (blob) {
        entry.blob = blob;
        entry.status = 'ready';
        entry.updatedAt = Date.now();
        return;
      }
      entry.status = 'failed';
    } catch {
      entry.status = 'failed';
    }
  }

  private async verifyYouTubeOrResolveAlternate(
    track: Track,
    signal: AbortSignal
  ): Promise<{ youtubeId?: string; streamUrl?: string }> {
    const videoId = track.youtubeId;
    if (!videoId) return {};

    // Check lightweight oEmbed availability so broken/private videos are replaced before playback starts
    let embedOk = false;
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`;
      if (hasNativeHttpBridge()) {
        const res = await nativeFetchText(oembedUrl, 4500);
        embedOk = Boolean(res?.ok);
      } else {
        const res = await fetch(oembedUrl, {
          signal: AbortSignal.any
            ? AbortSignal.any([signal, AbortSignal.timeout(4500)])
            : signal,
        });
        embedOk = res.ok;
      }
    } catch {
      // Transient timeout shouldn't discard valid ID immediately; assume OK unless 401/403/404
      embedOk = !signal.aborted;
    }

    if (signal.aborted) return {};
    if (embedOk) {
      return { youtubeId: videoId };
    }

    // Proactively resolve working mirror ahead of time if primary YouTube video is unembeddable
    try {
      const recoverRes = await fetch(
        `/api/stream/recover?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(
          track.artist
        )}&genre=${encodeURIComponent(track.genre || '')}&excludeId=${encodeURIComponent(videoId)}`,
        { signal }
      );
      if (recoverRes.ok && (recoverRes.headers.get('content-type') || '').includes('application/json')) {
        const data = (await recoverRes.json()) as {
          mode?: string;
          youtubeId?: string;
          streamUrl?: string;
        };
        if (data.mode === 'alternate-youtube' && data.youtubeId) {
          return { youtubeId: data.youtubeId };
        }
        if (data.mode === 'alternate-stream' && data.streamUrl) {
          return { streamUrl: data.streamUrl };
        }
      }
    } catch {
      // Ignore network errors during background preload
    }

    return { youtubeId: videoId };
  }

  private async warmDirectAudioStream(track: Track, entry: PreloadEntry): Promise<void> {
    if (!track.streamUrl || entry.controller.signal.aborted) return;
    const proxied =
      track.streamUrl.startsWith('http') &&
      typeof window !== 'undefined' &&
      !track.streamUrl.startsWith(window.location.origin)
        ? `/api/stream/proxy?url=${encodeURIComponent(track.streamUrl)}`
        : track.streamUrl;

    const candidates = proxied !== track.streamUrl ? [proxied, track.streamUrl] : [track.streamUrl];

    for (const candidateUrl of candidates) {
      if (entry.controller.signal.aborted) return;
      try {
        const res = await fetch(candidateUrl, {
          method: 'GET',
          headers: { Range: 'bytes=0-524287' },
          signal: entry.controller.signal,
        });
        if (!res.ok && res.status !== 206) continue;
        // Consume initial 512KB chunk so browser & proxy warm edge caches completely
        await res.arrayBuffer().catch(() => {});
        if (entry.controller.signal.aborted) return;

        entry.resolvedStreamUrl = candidateUrl;
        if (typeof Audio !== 'undefined') {
          const preloader = new Audio();
          preloader.preload = 'auto';
          preloader.muted = true;
          preloader.crossOrigin = 'anonymous';
          preloader.src = candidateUrl;
          preloader.load();
          entry.audioEl = preloader;
        }
        entry.status = 'ready';
        entry.updatedAt = Date.now();
        return;
      } catch {
        if (entry.controller.signal.aborted) return;
      }
    }

    entry.status = 'failed';
  }

  private async runProactivePreload(): Promise<void> {
    if (this.preloadInFlight) return;
    this.preloadInFlight = true;
    try {
      const targets = this.reconcilePreloadEvictions();
      if (targets.length === 0) return;

      const now = Date.now();
      // 1. Always pre-warm local and downloaded offline tracks from IndexedDB regardless of network status
      for (const track of targets) {
        if (track.source !== 'local' && !track.isAppDownload) continue;
        const existing = this.preloadPool.get(track.id);
        if (existing && (existing.status === 'ready' || existing.status === 'pending')) continue;
        const entry: PreloadEntry = {
          trackId: track.id,
          status: 'pending',
          controller: new AbortController(),
          updatedAt: now,
        };
        this.preloadPool.set(track.id, entry);
        await this.warmLocalTrackPreload(track, entry);
      }

      // 2. Check network stability before proactively buffering upcoming streamed tracks
      const streamTargets = targets.filter((t) => {
        if (t.source !== 'stream' || t.isAppDownload) return false;
        const cooldownUntil = this.preloadRetryCooldown.get(t.id) || 0;
        if (now < cooldownUntil) return false;
        const existing = this.preloadPool.get(t.id);
        return !existing || (existing.status !== 'ready' && existing.status !== 'pending');
      });

      if (streamTargets.length === 0) return;

      const stability = this.getNetworkStability();
      if (!stability.isStable) {
        if (this.isPlaying && stability.retryDelayMs > 0) {
          this.scheduleProactivePreload(stability.retryDelayMs);
        }
        return;
      }

      const workQueue = [...streamTargets];
      const workerCount = Math.min(stability.maxConcurrent, workQueue.length);

      const processTrack = async (track: Track) => {
        const entry: PreloadEntry = {
          trackId: track.id,
          status: 'pending',
          controller: new AbortController(),
          updatedAt: Date.now(),
        };
        this.preloadPool.set(track.id, entry);

        try {
          if (track.artworkUrl && typeof fetch !== 'undefined') {
            void fetch(track.artworkUrl, {
              mode: 'no-cors',
              signal: entry.controller.signal,
            }).catch(() => {});
          }

          if (track.streamUrl) {
            await this.warmDirectAudioStream(track, entry);
          } else if (track.youtubeId) {
            const resolved = await this.verifyYouTubeOrResolveAlternate(
              track,
              entry.controller.signal
            );
            if (entry.controller.signal.aborted) return;
            if (resolved.streamUrl) {
              entry.resolvedStreamUrl = resolved.streamUrl;
              entry.status = 'ready';
            } else if (resolved.youtubeId) {
              entry.resolvedYoutubeId = resolved.youtubeId;
              entry.status = 'ready';
            } else {
              entry.status = 'failed';
            }
          } else {
            entry.status = 'ready';
          }
          entry.updatedAt = Date.now();
          if (entry.status === 'failed') {
            this.preloadRetryCooldown.set(track.id, Date.now() + 25000);
          }
        } catch {
          entry.status = 'failed';
          this.preloadRetryCooldown.set(track.id, Date.now() + 25000);
        }
      };

      const workers = Array.from({ length: workerCount }, async () => {
        while (workQueue.length > 0) {
          if (!this.getNetworkStability().isStable) break;
          const nextTrack = workQueue.shift();
          if (!nextTrack) break;
          // Ensure target is still in upcoming 3-track pool before starting
          const stillTargeted = selectUpcomingPreloadTracks(
            this.upcomingQueue,
            this.currentTrack?.id,
            PROACTIVE_PRELOAD_COUNT
          ).some((t) => t.id === nextTrack.id);
          if (!stillTargeted) continue;
          await processTrack(nextTrack);
        }
      });

      await Promise.all(workers);
    } finally {
      this.preloadInFlight = false;
    }
  }

  private emit() {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private ensureContext(): AudioContext {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return this.ctx;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    this.ctx = ctx;

    // 5-band hardware EQ chain
    const eqNodes = EQ_FREQUENCIES.map((band, idx) => {
      const f = ctx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.hz;
      f.Q.value = band.type === 'peaking' ? 1.1 : 0.7;
      f.gain.value = this.dspSettings.bands[idx] || 0;
      return f;
    });
    this.eqFilters = eqNodes;

    // 80 Hz Low-Shelf Bass Boost
    const bassBoost = ctx.createBiquadFilter();
    bassBoost.type = 'lowshelf';
    bassBoost.frequency.value = 80;
    bassBoost.gain.value = this.dspSettings.bassBoostEnabled ? this.dspSettings.bassBoostDb : 0;
    this.bassBoostFilter = bassBoost;

    // Unthrottled Master Headroom Gain (full device speaker utilization without clipping)
    const masterGain = ctx.createGain();
    masterGain.gain.value = computeMasterOutputGain(this.dspSettings);
    this.masterGainNode = masterGain;

    // Transparent Brickwall Peak Guard only near 0 dBFS (never squashes normal playback loudness)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -0.3;
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0.001;
    comp.release.value = 0.08;
    this.compressor = comp;

    // 60fps Analyser
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.78;
    this.analyser = analyser;

    // Wire EQ -> Bass Boost -> Master Gain -> Peak Guard -> Analyser -> Destination
    for (let i = 0; i < eqNodes.length - 1; i++) {
      eqNodes[i].connect(eqNodes[i + 1]);
    }
    eqNodes[eqNodes.length - 1].connect(bassBoost);
    bassBoost.connect(masterGain);
    masterGain.connect(comp);
    comp.connect(analyser);
    analyser.connect(ctx.destination);

    this.channelA = this.createChannelStrip('A', ctx, eqNodes[0]);
    this.channelB = this.createChannelStrip('B', ctx, eqNodes[0]);
    this.channelA.gainNode.gain.value = 1;
    this.channelB.gainNode.gain.value = 0;

    // Auto-heal AudioContext suspensions / OS audio-focus interruptions mid-song
    ctx.addEventListener('statechange', () => {
      if (
        this.isPlaying &&
        !this.isRecentlyUserPaused() &&
        !this.ytActive &&
        ctx.state !== 'running'
      ) {
        void ctx.resume().catch(() => {});
      }
    });

    return ctx;
  }

  private createChannelStrip(id: 'A' | 'B', ctx: AudioContext, destination: AudioNode): ChannelStrip {
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(destination);

    const audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.preload = 'auto';
    audioEl.volume = 1.0;
    audioEl.muted = false;
    const mediaSource = ctx.createMediaElementSource(audioEl);
    mediaSource.connect(gainNode);

    const strip: ChannelStrip = {
      id,
      gainNode,
      audioEl,
      mediaSource,
      objectUrl: null,
      fadeTimer: null,
    };

    audioEl.addEventListener('loadedmetadata', () => {
      if (this.activeChannel === id && !this.ytActive && this.currentTrack?.source !== 'synth') {
        if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          this.duration = audioEl.duration;
          this.emit();
        }
      }
    });

    audioEl.addEventListener('timeupdate', () => {
      if (this.activeChannel === id && !this.ytActive && this.currentTrack?.source !== 'synth') {
        this.isBuffering = false;
        this.currentTime = audioEl.currentTime || 0;
        this.noteProgress(this.currentTime);
        if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          this.duration = audioEl.duration;
        }
        this.emit();
      }
    });

    audioEl.addEventListener('waiting', () => {
      if (this.activeChannel === id && !this.ytActive && this.currentTrack?.source === 'stream') {
        this.isBuffering = true;
        this.emit();
      }
    });

    audioEl.addEventListener('stalled', () => {
      if (this.activeChannel === id && !this.ytActive && this.currentTrack?.source === 'stream') {
        this.isBuffering = true;
        this.emit();
      }
    });

    audioEl.addEventListener('playing', () => {
      if (this.activeChannel === id && !this.ytActive) {
        this.isBuffering = false;
        this.noteProgress(audioEl.currentTime || this.currentTime, true);
        this.emit();
      }
    });

    audioEl.addEventListener('pause', () => {
      if (
        this.activeChannel === id &&
        !this.ytActive &&
        this.isPlaying &&
        !audioEl.ended &&
        !this.audioReloadInFlight &&
        !this.isRecentlyUserPaused()
      ) {
        // Recover immediately from transient OS/task-switch focus pauses
        this.ensurePlaybackAliveNow();
        window.setTimeout(() => this.ensurePlaybackAliveNow(), 60);
        window.setTimeout(() => this.ensurePlaybackAliveNow(), 200);
      }
    });

    audioEl.addEventListener('error', () => {
      if (this.activeChannel === id && !this.ytActive && this.currentTrack) {
        if (this.currentTrack.source === 'stream') {
          this.isBuffering = true;
          this.streamErrorCount += 1;
          this.emit();
        }
        if (
          this.isPlaying &&
          !this.isRecentlyUserPaused() &&
          this.watchdogRecoverCount < 2
        ) {
          this.watchdogRecoverCount += 1;
          this.watchdogLastRecoverAt = Date.now();
          const resumePos = Math.max(0, audioEl.currentTime || this.currentTime);
          window.setTimeout(() => {
            void this.reloadActiveAudioAtPosition(resumePos);
          }, 700);
        }
      }
    });

    audioEl.addEventListener('ended', () => {
      if (this.activeChannel === id && !this.ytActive) {
        const online = typeof navigator === 'undefined' ? true : navigator.onLine;
        const curPos = audioEl.currentTime || this.currentTime;
        if (
          isPrematureStreamEnded({
            source: this.currentTrack?.source,
            currentTime: curPos,
            expectedDuration: this.duration,
            isOnline: online,
            retriesUsed: this.prematureEndRetries,
          })
        ) {
          this.prematureEndRetries += 1;
          this.isBuffering = true;
          this.emit();
          void this.reloadActiveAudioAtPosition(curPos);
          return;
        }
        this.isBuffering = false;
        this.isPlaying = false;
        this.emit();
        for (const fn of this.endListeners) fn();
      }
    });

    return strip;
  }

  private stopStrip(strip: ChannelStrip | null) {
    if (!strip) return;
    if (strip.fadeTimer !== null) {
      clearTimeout(strip.fadeTimer);
      strip.fadeTimer = null;
    }
    try {
      strip.audioEl.pause();
      strip.audioEl.removeAttribute('src');
      strip.audioEl.load();
    } catch {
      // Ignore
    }
    if (strip.objectUrl) {
      URL.revokeObjectURL(strip.objectUrl);
      strip.objectUrl = null;
    }
  }

  private stopYtTicker() {
    if (this.ytTickTimer !== null) {
      clearInterval(this.ytTickTimer);
      this.ytTickTimer = null;
    }
  }

  private startYtTicker() {
    this.stopYtTicker();
    this.ytTickTimer = window.setInterval(() => {
      if (!this.ytActive || !this.isPlaying || !this.ytPlayer || !this.ytReady) return;
      try {
        const cur = this.ytPlayer.getCurrentTime();
        const dur = this.ytPlayer.getDuration();
        if (Number.isFinite(cur) && cur >= 0) {
          this.currentTime = cur;
          this.noteProgress(cur);
        }
        if (Number.isFinite(dur) && dur > 0) {
          this.duration = dur;
        }
        this.emit();
      } catch {
        // Ignore transient player query errors
      }
    }, 250);
  }

  private clearYtVolumeFade() {
    if (this.ytVolumeTimer !== null) {
      clearInterval(this.ytVolumeTimer);
      this.ytVolumeTimer = null;
    }
  }

  private rampYtVolume(from: number, to: number, seconds: number, onComplete?: () => void) {
    this.clearYtVolumeFade();
    if (!this.ytPlayer || !this.ytReady) {
      if (to > 0) this.isCrossfading = false;
      onComplete?.();
      return;
    }
    if (seconds <= 0.05) {
      try {
        this.ytPlayer.setVolume(to);
      } catch {
        // Ignore
      }
      if (to > 0) this.isCrossfading = false;
      onComplete?.();
      return;
    }

    const start = performance.now();
    const totalMs = seconds * 1000;
    try {
      this.ytPlayer.setVolume(from);
    } catch {
      // Ignore
    }
    this.ytVolumeTimer = window.setInterval(() => {
      const elapsed = performance.now() - start;
      const ratio = Math.min(1, elapsed / totalMs);
      const val = Math.round(from + (to - from) * ratio);
      try {
        this.ytPlayer?.setVolume(val);
      } catch {
        // Ignore
      }
      if (ratio >= 1) {
        this.clearYtVolumeFade();
        if (to > 0) {
          this.isCrossfading = false;
        }
        onComplete?.();
      }
    }, 50);
  }

  private clearYtStartupWatchdog() {
    if (this.ytStartupTimer !== null) {
      clearTimeout(this.ytStartupTimer);
      this.ytStartupTimer = null;
    }
  }

  private armYtStartupWatchdog(track: Track, seq: number) {
    this.clearYtStartupWatchdog();
    // Nudge cued WebView players once after 1.8s before falling back to recovery at 6.5s
    window.setTimeout(() => {
      if (seq !== this.playSeq || !this.ytActive || !this.isPlaying || !this.ytPlayer || !this.ytReady) return;
      try {
        const state = this.ytPlayer.getPlayerState();
        if (state === 5 || state === -1) {
          this.ytPlayer.playVideo();
        }
      } catch {
        // Ignore
      }
    }, 1800);

    this.ytStartupTimer = window.setTimeout(() => {
      if (seq !== this.playSeq || !this.ytActive || !this.isPlaying || !this.ytPlayer) return;
      try {
        const state = this.ytPlayer.getPlayerState();
        const cur = this.ytPlayer.getCurrentTime();
        // -1 = unstarted, 5 = cued (stuck due to embed/bot gate without firing onError)
        if ((state === -1 || state === 5) && (!Number.isFinite(cur) || cur < 0.2)) {
          void this.recoverActiveYouTubeTrack(track, seq);
        }
      } catch {
        void this.recoverActiveYouTubeTrack(track, seq);
      }
    }, 6500);
  }

  private clearYtSettleTimers() {
    for (const id of this.ytSettleTimers) {
      window.clearTimeout(id);
    }
    this.ytSettleTimers = [];
  }

  private scheduleYouTubeGeometrySettle() {
    if (typeof window === 'undefined') return;
    this.clearYtSettleTimers();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => this.syncYouTubeHostGeometry());
    }
    for (const delay of [50, 180, 380]) {
      const id = window.setTimeout(() => this.syncYouTubeHostGeometry(), delay);
      this.ytSettleTimers.push(id);
    }
  }

  private updateYtPositionMonitor() {
    if (typeof window === 'undefined') return;
    const shouldPoll = this.ytActive && this.ytViewports.size > 0;
    if (shouldPoll && this.ytPositionMonitorTimer === null) {
      this.ytPositionMonitorTimer = window.setInterval(() => {
        if (!this.ytActive || this.ytViewports.size === 0) {
          this.updateYtPositionMonitor();
          return;
        }
        this.syncYouTubeHostGeometry();
      }, 150);
    } else if (!shouldPoll && this.ytPositionMonitorTimer !== null) {
      window.clearInterval(this.ytPositionMonitorTimer);
      this.ytPositionMonitorTimer = null;
    }
  }

  private cancelCompositorNudge() {
    if (typeof window === 'undefined') return;
    if (this.ytCompositorNudgeRaf1 !== null) {
      window.cancelAnimationFrame(this.ytCompositorNudgeRaf1);
      this.ytCompositorNudgeRaf1 = null;
    }
    if (this.ytCompositorNudgeRaf2 !== null) {
      window.cancelAnimationFrame(this.ytCompositorNudgeRaf2);
      this.ytCompositorNudgeRaf2 = null;
    }
  }

  /**
   * Android WebView & Chromium can stop painting video frames inside an iframe while it is
   * occluded at z-index:-1 / opacity:0.001. A 1px two-frame width nudge forces an instant
   * GPU surface re-composite without reloading or interrupting audio playback.
   */
  private refreshYouTubeCompositorSurface() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    this.lastCompositorNudgeAt = Date.now();
    this.cancelCompositorNudge();
    const frame = document.getElementById('kago-yt-frame');
    if (!frame) return;

    frame.style.display = 'block';
    frame.style.width = 'calc(100% - 1px)';
    frame.style.height = '100%';

    if (typeof window.requestAnimationFrame === 'function') {
      this.ytCompositorNudgeRaf1 = window.requestAnimationFrame(() => {
        this.ytCompositorNudgeRaf1 = null;
        this.ytCompositorNudgeRaf2 = window.requestAnimationFrame(() => {
          this.ytCompositorNudgeRaf2 = null;
          const liveFrame = document.getElementById('kago-yt-frame');
          if (liveFrame) {
            liveFrame.style.width = '100%';
            liveFrame.style.height = '100%';
          }
          this.syncYouTubeHostGeometry();
        });
      });
    } else {
      frame.style.width = '100%';
    }
  }

  resyncYouTubeViewport(): void {
    this.syncYouTubeHostGeometry(true);
    this.scheduleYouTubeGeometrySettle();
  }

  attachYouTubeViewport(el: HTMLElement | null, zIndex = 30): () => void {
    if (!el) return () => {};

    const prev = this.ytViewports.get(el);
    if (prev?.observer) {
      prev.observer.disconnect();
    }

    const order = ++this.ytViewportSeq;
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => this.syncYouTubeHostGeometry());
      observer.observe(el);
      if (el.parentElement) {
        observer.observe(el.parentElement);
      }
    }

    this.ytViewports.set(el, { zIndex, order, observer });

    if (typeof window !== 'undefined' && !this.ytSyncListenerBound) {
      this.ytSyncListenerBound = true;
      const sync = () => this.syncYouTubeHostGeometry();
      window.addEventListener('scroll', sync, true);
      window.addEventListener('resize', sync);
      window.addEventListener('focus', () => this.syncYouTubeHostGeometry(true));
    }

    this.updateYtPositionMonitor();
    this.syncYouTubeHostGeometry();
    this.scheduleYouTubeGeometrySettle();

    return () => {
      const current = this.ytViewports.get(el);
      if (current && current.order === order) {
        current.observer?.disconnect();
        this.ytViewports.delete(el);
      } else if (observer) {
        observer.disconnect();
      }
      this.updateYtPositionMonitor();
      this.syncYouTubeHostGeometry();
    };
  }

  private syncYouTubeHostGeometry(forceSurfaceRefresh = false) {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('kago-yt-host');
    if (!host) return;

    const frame = document.getElementById('kago-yt-frame');
    if (frame && this.ytCompositorNudgeRaf1 === null && this.ytCompositorNudgeRaf2 === null) {
      frame.style.display = 'block';
      frame.style.width = '100%';
      frame.style.height = '100%';
    }

    if (this.ytActive && this.ytViewports.size > 0) {
      const candidates: Array<{
        el: HTMLElement;
        zIndex: number;
        order: number;
        connected: boolean;
        width: number;
        height: number;
        rect: DOMRect;
      }> = [];

      for (const [el, entry] of this.ytViewports.entries()) {
        if (!document.contains(el)) {
          entry.observer?.disconnect();
          this.ytViewports.delete(el);
          continue;
        }
        const rect = el.getBoundingClientRect();
        candidates.push({
          el,
          zIndex: entry.zIndex,
          order: entry.order,
          connected: true,
          width: rect.width,
          height: rect.height,
          rect,
        });
      }

      const active = selectActiveYouTubeViewport(candidates);
      if (active) {
        const wasHidden = !this.ytWasHostVisible;
        this.ytWasHostVisible = true;

        host.removeAttribute('aria-hidden');
        host.removeAttribute('inert');
        host.style.display = 'block';
        host.style.visibility = 'visible';
        host.style.position = 'fixed';
        host.style.top = `${Math.round(active.rect.top)}px`;
        host.style.left = `${Math.round(active.rect.left)}px`;
        host.style.bottom = 'auto';
        host.style.right = 'auto';
        host.style.width = `${Math.round(active.rect.width)}px`;
        host.style.height = `${Math.round(active.rect.height)}px`;
        host.style.opacity = '1';
        host.style.pointerEvents = 'auto';
        host.style.zIndex = String(active.zIndex);
        host.style.borderRadius = '10px';
        host.style.backgroundColor = '#000000';
        host.style.transform = 'translate3d(0, 0, 0)';
        host.style.willChange = 'transform';

        if (wasHidden || forceSurfaceRefresh) {
          const isDocVisible =
            typeof document === 'undefined' || document.visibilityState === 'visible';
          if (isDocVisible) {
            this.refreshYouTubeCompositorSurface();
          }
          if (this.isPlaying && this.ytPlayer && this.ytReady) {
            try {
              const state = this.ytPlayer.getPlayerState();
              const statePaused = window.YT?.PlayerState?.PAUSED ?? 2;
              const userPausedRecently =
                this.userPausedAt > 0 && Date.now() - this.userPausedAt < 2500;
              if (!userPausedRecently && (state === statePaused || state === 5)) {
                this.ytPlayer.unMute?.();
                this.ytPlayer.playVideo();
              }
            } catch {
              // Ignore transient player query errors
            }
          }
        }
        return;
      }
    }

    this.ytWasHostVisible = false;
    this.cancelCompositorNudge();
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    host.style.display = 'block';
    host.style.visibility = 'visible';
    host.style.position = 'fixed';
    host.style.top = 'auto';
    host.style.left = 'auto';
    host.style.bottom = '0px';
    host.style.right = '0px';
    host.style.width = '200px';
    host.style.height = '200px';
    host.style.opacity = '0.001';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '-1';
    host.style.transform = 'translate3d(0, 0, 0)';
  }

  private stopYouTubePlayback(fadeSeconds = 0) {
    this.ytActive = false;
    this.clearYtStartupWatchdog();
    this.stopYtTicker();
    this.syncYouTubeHostGeometry();
    if (!this.ytPlayer || !this.ytReady) return;
    if (fadeSeconds > 0.1) {
      this.rampYtVolume(100, 0, fadeSeconds, () => {
        if (!this.ytActive) {
          try {
            this.ytPlayer?.pauseVideo();
            this.ytPlayer?.setVolume(100);
          } catch {
            // Ignore
          }
        }
      });
    } else {
      try {
        this.ytPlayer.pauseVideo();
      } catch {
        // Ignore
      }
    }
  }

  private ensureYouTubePlayer(initialVideoId: string): Promise<YtPlayerInstance | null> {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return Promise.resolve(null);
    }
    if (this.ytPlayer && this.ytReady) {
      this.syncYouTubeHostGeometry();
      return Promise.resolve(this.ytPlayer);
    }
    if (this.ytLoadPromise) {
      return this.ytLoadPromise;
    }

    this.ytLoadPromise = new Promise<YtPlayerInstance | null>((resolve) => {
      let host = document.getElementById('kago-yt-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'kago-yt-host';
        host.setAttribute('aria-hidden', 'true');
        host.setAttribute('inert', '');
        host.style.position = 'fixed';
        host.style.bottom = '0px';
        host.style.right = '0px';
        host.style.width = '200px';
        host.style.height = '200px';
        host.style.opacity = '0.001';
        host.style.pointerEvents = 'none';
        host.style.zIndex = '-1';
        host.style.overflow = 'hidden';

        const frame = document.createElement('div');
        frame.id = 'kago-yt-frame';
        frame.style.width = '100%';
        frame.style.height = '100%';
        host.appendChild(frame);
        document.body.appendChild(host);
      }

      const timeoutId = window.setTimeout(() => {
        if (!this.ytReady) {
          this.ytLoadPromise = null;
          resolve(null);
        }
      }, 6500);

      const mountPlayer = () => {
        if (!window.YT?.Player) {
          clearTimeout(timeoutId);
          this.ytLoadPromise = null;
          resolve(null);
          return;
        }
        try {
          this.ytPlayer = new window.YT.Player('kago-yt-frame', {
            width: '100%',
            height: '100%',
            videoId: initialVideoId,
            playerVars: {
              autoplay: 1,
              controls: 1,
              disablekb: 0,
              fs: 1,
              modestbranding: 1,
              playsinline: 1,
              rel: 0,
              origin: window.location.origin,
            },
            events: {
              onReady: (ev) => {
                clearTimeout(timeoutId);
                this.ytReady = true;
                this.syncYouTubeHostGeometry(true);
                this.scheduleYouTubeGeometrySettle();
                try {
                  ev.target.unMute?.();
                  ev.target.setVolume(100);
                } catch {
                  // Ignore
                }
                if (this.ytActive && this.isPlaying) {
                  try {
                    ev.target.playVideo();
                  } catch {
                    // Ignore
                  }
                }
                resolve(ev.target);
              },
              onStateChange: (ev) => {
                if (!this.ytActive) return;
                const stateEnded = window.YT?.PlayerState?.ENDED ?? 0;
                const statePlaying = window.YT?.PlayerState?.PLAYING ?? 1;
                const statePaused = window.YT?.PlayerState?.PAUSED ?? 2;
                const stateBuffering = window.YT?.PlayerState?.BUFFERING ?? 3;
                if (ev.data === stateBuffering || ev.data === -1) {
                  this.isBuffering = true;
                  this.emit();
                } else if (ev.data === 5) {
                  // CUED mid-song / post-switch -> keep playback flowing unless paused by user
                  if (this.isPlaying && !this.isRecentlyUserPaused()) {
                    try {
                      ev.target.playVideo();
                    } catch {
                      // Ignore
                    }
                  }
                } else if (ev.data === statePlaying) {
                  this.clearYtStartupWatchdog();
                  this.isBuffering = false;
                  this.isPlaying = true;
                  this.noteProgress(ev.target.getCurrentTime() || this.currentTime, true);
                  try {
                    ev.target.unMute?.();
                    if (!this.isCrossfading) {
                      ev.target.setVolume(100);
                    }
                  } catch {
                    // Ignore
                  }
                  const dur = ev.target.getDuration();
                  if (Number.isFinite(dur) && dur > 0) {
                    this.duration = dur;
                  }
                  this.startYtTicker();
                  this.startBgKeepalive();
                  this.syncYouTubeHostGeometry();
                  this.scheduleProactivePreload(PRELOAD_SETTLE_DELAY_MS);
                  this.emit();
                } else if (ev.data === statePaused) {
                  this.isBuffering = false;
                  const vis = typeof document !== 'undefined' ? document.visibilityState : 'visible';
                  const iframeFocused = this.isYtIframeFocused();
                  if (
                    shouldAutoResumePlaybackPause({
                      isPlaying: this.isPlaying,
                      userPausedAt: this.userPausedAt,
                      nowMs: Date.now(),
                      visibilityState: vis,
                      backgroundTransitionUntil: this.backgroundTransitionUntil,
                      isIframeFocused: iframeFocused,
                    })
                  ) {
                    try {
                      ev.target.unMute?.();
                      ev.target.playVideo();
                    } catch {
                      // Ignore
                    }
                    window.setTimeout(() => this.ensurePlaybackAliveNow(), 30);
                    window.setTimeout(() => this.ensurePlaybackAliveNow(), 100);
                    window.setTimeout(() => this.ensurePlaybackAliveNow(), 250);
                    return;
                  }
                  if (iframeFocused) {
                    this.userPausedAt = Date.now();
                  }
                  if (vis === 'visible' || this.isRecentlyUserPaused()) {
                    this.isPlaying = false;
                    this.stopYtTicker();
                    this.stopBgKeepalive();
                    this.emit();
                  }
                } else if (ev.data === stateEnded) {
                  this.isBuffering = false;
                  this.isPlaying = false;
                  this.stopYtTicker();
                  this.stopBgKeepalive();
                  this.emit();
                  for (const fn of this.endListeners) fn();
                }
              },
              onError: () => {
                if (!this.ytActive || !this.currentTrack) return;
                this.isBuffering = true;
                this.streamErrorCount += 1;
                this.emit();
                void this.recoverActiveYouTubeTrack(
                  this.currentTrack,
                  this.playSeq,
                  Math.max(0, Math.floor(this.currentTime)),
                  true
                );
              },
            },
          });
        } catch {
          clearTimeout(timeoutId);
          this.ytLoadPromise = null;
          resolve(null);
        }
      };

      if (window.YT?.Player) {
        mountPlayer();
        return;
      }

      const prevReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prevReady?.();
        mountPlayer();
      };

      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.onerror = () => {
          clearTimeout(timeoutId);
          this.ytLoadPromise = null;
          resolve(null);
        };
        document.head.appendChild(script);
      }
    });

    return this.ytLoadPromise;
  }

  private async recoverActiveYouTubeTrack(
    track: Track,
    seq: number,
    resumeSeconds = 0,
    preferAlternate = false
  ) {
    if (seq !== this.playSeq) return;
    const activeStrip = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (!activeStrip) return;

    // If stalled mid-song on a playable YouTube video, first reload the exact same stream at saved position
    if (
      !preferAlternate &&
      resumeSeconds > 2 &&
      track.youtubeId &&
      this.ytPlayer &&
      this.ytReady &&
      this.ytRecoveryAttempts === 0
    ) {
      this.ytRecoveryAttempts += 1;
      try {
        this.ytPlayer.loadVideoById(track.youtubeId, resumeSeconds);
        this.ytPlayer.playVideo();
        this.noteProgress(resumeSeconds, true);
        this.emit();
        return;
      } catch {
        // Fall through to alternate stream search
      }
    }

    if (this.ytRecoveryAttempts < 2) {
      this.ytRecoveryAttempts += 1;
      try {
        const res = await fetch(
          `/api/stream/recover?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(
            track.artist
          )}&genre=${encodeURIComponent(track.genre || '')}&excludeId=${encodeURIComponent(
            track.youtubeId || ''
          )}`
        );
        if (seq !== this.playSeq) return;
        if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
          const data = (await res.json()) as {
            mode?: string;
            youtubeId?: string;
            streamUrl?: string;
            duration?: number;
            artworkUrl?: string;
            recoveredFrom?: string;
          };

          if (data.mode === 'alternate-youtube' && data.youtubeId && this.ytPlayer && this.ytReady) {
            const updated: Track = {
              ...track,
              youtubeId: data.youtubeId,
              duration: data.duration || track.duration,
              artworkUrl: data.artworkUrl || track.artworkUrl,
              recoveredFrom: data.recoveredFrom || 'Alternate YouTube Audio',
            };
            this.currentTrack = updated;
            this.duration = updated.duration;
            const targetStart =
              resumeSeconds > 2 && (!updated.duration || resumeSeconds < updated.duration - 8)
                ? resumeSeconds
                : 0;
            this.currentTime = targetStart;
            this.noteProgress(targetStart, true);
            this.ytPlayer.loadVideoById(data.youtubeId, targetStart);
            this.emit();
            return;
          }

          if (data.mode === 'alternate-stream' && data.streamUrl) {
            this.stopYouTubePlayback(0);
            const updated: Track = {
              ...track,
              youtubeId: undefined,
              streamUrl: data.streamUrl,
              duration: data.duration || track.duration,
              recoveredFrom: data.recoveredFrom || 'Audius Full-Length Mirror',
            };
            this.currentTrack = updated;
            this.duration = updated.duration;
            const streamSrc = isNativeAndroidApp()
              ? data.streamUrl
              : `/api/stream/proxy?url=${encodeURIComponent(data.streamUrl)}`;
            activeStrip.audioEl.src = streamSrc;
            try {
              await activeStrip.audioEl.play();
              this.isBuffering = false;
              this.emit();
              return;
            } catch {
              // Fall through
            }
          }
        }
      } catch {
        // Try native APK YouTube recovery below
      }

      // On Android APK (no Express server), find embeddable -Topic / Lyrics YouTube alternate directly
      if (seq === this.playSeq && hasNativeHttpBridge() && this.ytPlayer && this.ytReady) {
        try {
          const fallbackQuery =
            this.ytRecoveryAttempts === 1
              ? `${track.artist} ${track.title} topic`
              : `${track.title} ${track.artist} lyrics`;
          const nativeRes = await nativeFetchText(
            `https://www.youtube.com/results?search_query=${encodeURIComponent(
              fallbackQuery
            )}&sp=EgIQAQ%3D%3D`,
            8000
          );
          if (seq !== this.playSeq) return;
          if (nativeRes?.ok && nativeRes.text) {
            const candidates = extractYouTubeSearchResults(nativeRes.text).filter(
              (c) => c.videoId !== track.youtubeId
            );
            const ranked = rankYouTubeSearchResults(candidates, fallbackQuery);
            const alt = ranked[0];
            if (alt?.videoId) {
              const updated: Track = {
                ...track,
                youtubeId: alt.videoId,
                duration: alt.durationSeconds || track.duration,
                artworkUrl: alt.thumbnailUrl || track.artworkUrl,
                recoveredFrom: `Alternate YouTube (${alt.videoId})`,
              };
              this.currentTrack = updated;
              this.duration = updated.duration;
              this.currentTime = 0;
              this.ytPlayer.loadVideoById(alt.videoId, 0);
              this.ytPlayer.playVideo();
              this.emit();
              return;
            }
          }
        } catch {
          // Fall through to Audius mirror check
        }
      }

      // Try direct CORS-safe Audius track mirror before giving up
      if (seq === this.playSeq) {
        try {
          const audiusQuery = `${track.artist} ${track.title}`.trim();
          const audiusUrl = `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(
            audiusQuery
          )}&limit=5`;
          let rawJson = '';
          if (hasNativeHttpBridge()) {
            const nativeRes = await nativeFetchText(audiusUrl, 6000);
            if (nativeRes?.ok && nativeRes.text) rawJson = nativeRes.text;
          } else {
            const res = await fetch(audiusUrl);
            if (res.ok) rawJson = await res.text();
          }
          if (seq !== this.playSeq) return;
          if (rawJson) {
            const parsed = JSON.parse(rawJson) as {
              data?: Array<{
                id?: string;
                title?: string;
                duration?: number;
                user?: { name?: string };
              }>;
            };
            const targetTitle = track.title.toLowerCase();
            const match = (parsed.data || []).find((item) => {
              if (!item?.id || !item.title || (item.duration || 0) < 45) return false;
              const candTitle = item.title.toLowerCase();
              return candTitle.includes(targetTitle) || targetTitle.includes(candTitle);
            });
            if (match?.id) {
              const streamUrl = `https://api.audius.co/v1/tracks/${encodeURIComponent(match.id)}/stream`;
              this.stopYouTubePlayback(0);
              this.currentTrack = {
                ...track,
                youtubeId: undefined,
                streamUrl,
                duration: match.duration || track.duration,
                streamProvider: 'audius',
                recoveredFrom: 'Audius Full-Length Mirror',
              };
              this.duration = this.currentTrack.duration;
              activeStrip.audioEl.volume = 1.0;
              activeStrip.audioEl.muted = false;
              activeStrip.audioEl.src = streamUrl;
              await activeStrip.audioEl.play();
              this.isBuffering = false;
              this.emit();
              return;
            }
          }
        } catch {
          // No playable online mirror found
        }
      }
    }

    if (seq !== this.playSeq) return;
    // Never substitute fake synth stems for real songs — keep buffering flagged so the 30s auto-offline handler switches to Library
    this.stopYouTubePlayback(0);
    this.isBuffering = true;
    this.streamErrorCount += 1;
    this.isPlaying = true;
    this.startBgKeepalive();
    this.emit();
  }

  async playTrack(inputTrack: Track): Promise<void> {
    const seq = ++this.playSeq;
    this.ytRecoveryAttempts = 0;
    this.trackStartedAtMs = Date.now();

    // Consume any pre-buffered stream mirror or local blob cached by the proactive preloader
    const preloaded = this.preloadPool.get(inputTrack.id);
    let track = inputTrack;
    if (preloaded?.resolvedYoutubeId && track.youtubeId && preloaded.resolvedYoutubeId !== track.youtubeId) {
      track = {
        ...track,
        youtubeId: preloaded.resolvedYoutubeId,
        recoveredFrom: 'Pre-Buffered Verified Mirror',
      };
    } else if (preloaded?.resolvedStreamUrl && track.youtubeId && !track.streamUrl) {
      track = {
        ...track,
        youtubeId: undefined,
        streamUrl: preloaded.resolvedStreamUrl,
        recoveredFrom: 'Pre-Buffered Stream Mirror',
      };
    }
    const preloadedLocalBlob = preloaded?.blob;
    const preloadedStreamUrl = preloaded?.resolvedStreamUrl;
    this.evictPreloadEntry(inputTrack.id);

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const wasPlaying = this.isPlaying && this.currentTrack !== null;
    const crossfade = wasPlaying ? clampCrossfadeSeconds(this.dspSettings.crossfadeSeconds) : 0;

    const outgoingChannelId = this.activeChannel;
    const incomingChannelId: 'A' | 'B' =
      wasPlaying && crossfade > 0 ? (outgoingChannelId === 'A' ? 'B' : 'A') : outgoingChannelId;

    const outgoingStrip = outgoingChannelId === 'A' ? this.channelA : this.channelB;
    const incomingStrip = incomingChannelId === 'A' ? this.channelA : this.channelB;
    if (!incomingStrip) return;

    // Clean incoming strip before loading
    this.stopStrip(incomingStrip);

    // If instant cut (no crossfade), stop outgoing strip too
    if (!wasPlaying || crossfade <= 0 || outgoingChannelId === incomingChannelId) {
      if (outgoingStrip && outgoingStrip !== incomingStrip) {
        this.stopStrip(outgoingStrip);
      }
    }

    this.userPausedAt = 0;
    this.isBuffering = track.source === 'stream' && !track.isAppDownload && !preloadedLocalBlob;
    this.streamErrorCount = 0;
    this.activeChannel = incomingChannelId;
    this.currentTrack = track;
    this.currentTime = 0;
    this.duration = track.duration || 180;
    this.isPlaying = true;
    this.resetWatchdog(track.id);
    localDb.pushHistory(track.id);
    localDb.incrementPlayCount(track.id);
    this.reconcilePreloadEvictions();

    const now = ctx.currentTime;
    if (wasPlaying && crossfade > 0 && outgoingStrip && outgoingStrip !== incomingStrip) {
      this.isCrossfading = true;
      outgoingStrip.gainNode.gain.cancelScheduledValues(now);
      outgoingStrip.gainNode.gain.setValueAtTime(
        Math.max(0.01, outgoingStrip.gainNode.gain.value),
        now
      );
      outgoingStrip.gainNode.gain.linearRampToValueAtTime(0, now + crossfade);

      incomingStrip.gainNode.gain.cancelScheduledValues(now);
      incomingStrip.gainNode.gain.setValueAtTime(0, now);
      incomingStrip.gainNode.gain.linearRampToValueAtTime(1, now + crossfade);

      if (outgoingStrip.fadeTimer !== null) clearTimeout(outgoingStrip.fadeTimer);
      outgoingStrip.fadeTimer = window.setTimeout(() => {
        this.stopStrip(outgoingStrip);
        this.isCrossfading = false;
        this.emit();
      }, crossfade * 1000 + 50);
    } else {
      this.isCrossfading = false;
      incomingStrip.gainNode.gain.cancelScheduledValues(now);
      incomingStrip.gainNode.gain.setValueAtTime(1, now);
    }

    // Prefer offline stored IndexedDB audio for local imports AND Spotify-style App Downloads before any network stream
    if (track.source === 'local' || track.isAppDownload || Boolean(preloadedLocalBlob)) {
      const blob = preloadedLocalBlob ?? (await localDb.getAudioBlob(track.id));
      if (seq !== this.playSeq) return;
      if (blob) {
        if (this.ytActive) {
          this.stopYouTubePlayback(wasPlaying ? crossfade : 0);
        }
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }
        if (seq !== this.playSeq) return;
        incomingStrip.audioEl.volume = 1.0;
        incomingStrip.audioEl.muted = false;
        const url = URL.createObjectURL(blob);
        incomingStrip.objectUrl = url;
        incomingStrip.audioEl.src = url;
        incomingStrip.audioEl.currentTime = 0;
        this.isBuffering = false;
        try {
          await incomingStrip.audioEl.play();
          this.startBgKeepalive();
          this.scheduleProactivePreload(PRELOAD_SETTLE_DELAY_MS);
          this.emit();
          return;
        } catch {
          if (seq !== this.playSeq) return;
          this.isPlaying = false;
          this.isBuffering = false;
          this.streamErrorCount += 1;
          this.stopBgKeepalive();
          this.emit();
          return;
        }
      } else if (track.source === 'local' && track.streamUrl) {
        if (this.ytActive) {
          this.stopYouTubePlayback(wasPlaying ? crossfade : 0);
        }
        incomingStrip.audioEl.volume = 1.0;
        incomingStrip.audioEl.muted = false;
        incomingStrip.audioEl.src = track.streamUrl;
        incomingStrip.audioEl.currentTime = 0;
        await incomingStrip.audioEl.play().catch(() => {});
        this.startBgKeepalive();
        this.scheduleProactivePreload(PRELOAD_SETTLE_DELAY_MS);
        this.emit();
        return;
      }
    }

    // Play full-length YouTube stream via YouTube IFrame Player API
    if (track.youtubeId) {
      this.ytActive = true;
      this.updateYtPositionMonitor();
      this.syncYouTubeHostGeometry(true);
      this.scheduleYouTubeGeometrySettle();
      this.emit();

      const alreadyMounted = Boolean(this.ytPlayer && this.ytReady);
      const player = await this.ensureYouTubePlayer(track.youtubeId);
      if (seq !== this.playSeq) return;

      if (player) {
        try {
          player.unMute?.();
        } catch {
          // Ignore
        }
        if (alreadyMounted) {
          try {
            player.loadVideoById(track.youtubeId, 0);
          } catch {
            void this.recoverActiveYouTubeTrack(track, seq);
            return;
          }
        }
        if (wasPlaying && crossfade > 0) {
          this.rampYtVolume(0, 100, crossfade);
        } else {
          this.clearYtVolumeFade();
          try {
            player.unMute?.();
            player.setVolume(100);
          } catch {
            // Ignore
          }
        }
        this.startYtTicker();
        this.startBgKeepalive();
        this.armYtStartupWatchdog(track, seq);
        this.emit();
        return;
      }

      // If YouTube IFrame API fails to load (e.g. offline), recover smoothly
      await this.recoverActiveYouTubeTrack(track, seq);
      return;
    }

    // Switching away from YouTube playback
    if (this.ytActive) {
      this.stopYouTubePlayback(wasPlaying ? crossfade : 0);
    }

    // Play direct HTTPS / proxied stream when available (never synthesize placeholder music)
    if (track.source === 'synth') {
      this.isBuffering = false;
      this.isPlaying = false;
      this.stopBgKeepalive();
      this.emit();
      return;
    } else if (track.streamUrl) {
      incomingStrip.audioEl.volume = 1.0;
      incomingStrip.audioEl.muted = false;
      const proxied =
        track.streamUrl.startsWith('http') && !track.streamUrl.startsWith(window.location.origin)
          ? `/api/stream/proxy?url=${encodeURIComponent(track.streamUrl)}`
          : track.streamUrl;
      const preferredUrl = isNativeAndroidApp()
        ? preloadedStreamUrl || track.streamUrl
        : preloadedStreamUrl || proxied;
      incomingStrip.audioEl.src = preferredUrl;
      try {
        await incomingStrip.audioEl.play();
      } catch {
        // Try alternate direct/proxy HTTPS stream
        const fallbackUrl = preferredUrl === track.streamUrl ? proxied : track.streamUrl;
        let recoveredDirect = false;
        if (fallbackUrl !== preferredUrl) {
          try {
            incomingStrip.audioEl.src = fallbackUrl;
            await incomingStrip.audioEl.play();
            recoveredDirect = true;
          } catch {
            recoveredDirect = false;
          }
        }
        if (!recoveredDirect) {
          if (track.source === 'stream') {
            this.isBuffering = true;
            this.streamErrorCount += 1;
            this.startBgKeepalive();
            this.emit();
            return;
          }
          this.isBuffering = false;
          this.isPlaying = false;
          this.streamErrorCount += 1;
          this.stopBgKeepalive();
          this.emit();
          return;
        }
      }
    } else {
      if (track.source === 'stream') {
        this.isBuffering = true;
        this.streamErrorCount += 1;
        this.startBgKeepalive();
        this.emit();
        return;
      }
      this.isBuffering = false;
      this.isPlaying = false;
      this.streamErrorCount += 1;
      this.stopBgKeepalive();
      this.emit();
      return;
    }

    this.startBgKeepalive();
    this.scheduleProactivePreload(PRELOAD_SETTLE_DELAY_MS);
    this.emit();
  }

  pause(): void {
    if (!this.currentTrack) return;
    this.userPausedAt = Date.now();
    this.isBuffering = false;
    this.isPlaying = false;
    this.stopBgKeepalive();

    if (this.ytActive && this.ytPlayer && this.ytReady) {
      this.stopYtTicker();
      try {
        this.ytPlayer.pauseVideo();
      } catch {
        // Ignore
      }
      this.emit();
      return;
    }

    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (active) {
      active.audioEl.pause();
    }
    this.emit();
  }

  async play(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (!this.currentTrack) return;
    this.userPausedAt = 0;

    if (this.ytActive && this.ytPlayer && this.ytReady) {
      this.isPlaying = true;
      try {
        this.ytPlayer.unMute?.();
        this.ytPlayer.setVolume(100);
        this.ytPlayer.playVideo();
      } catch {
        // Ignore
      }
      this.startYtTicker();
      this.startBgKeepalive();
      this.emit();
      return;
    }

    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (!active) return;

    this.isPlaying = true;
    active.audioEl.volume = 1.0;
    active.audioEl.muted = false;
    if (this.currentTrack.source === 'synth' || !active.audioEl.src) {
      if (this.currentTrack.source === 'stream') {
        await this.playTrack(this.currentTrack);
        return;
      }
      this.isPlaying = false;
      this.isBuffering = false;
      this.stopBgKeepalive();
      this.emit();
      return;
    } else {
      await active.audioEl.play().catch(() => {});
    }
    this.startBgKeepalive();
    this.emit();
  }

  async togglePlay(): Promise<void> {
    if (!this.currentTrack) return;
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  seek(targetSeconds: number): void {
    const clamped = Math.max(0, Math.min(this.duration || 180, targetSeconds));
    this.currentTime = clamped;
    this.noteProgress(clamped, true);

    if (this.ytActive && this.ytPlayer && this.ytReady) {
      try {
        this.ytPlayer.seekTo(clamped, true);
      } catch {
        // Ignore
      }
      this.emit();
      return;
    }

    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (active && active.audioEl.src) {
      try {
        active.audioEl.currentTime = clamped;
      } catch {
        // Ignore
      }
    }
    this.emit();
  }

  seekBy(deltaSeconds: number): void {
    this.seek(this.currentTime + deltaSeconds);
  }

  updateDspSettings(next: DspSettings): void {
    const normalized: DspSettings = {
      ...next,
      crossfadeSeconds: clampCrossfadeSeconds(next.crossfadeSeconds),
    };
    this.dspSettings = normalized;
    localDb.saveDspSettings(normalized);

    if (this.ctx) {
      const now = this.ctx.currentTime;
      this.eqFilters.forEach((filter, idx) => {
        filter.gain.setTargetAtTime(normalized.bands[idx] ?? 0, now, 0.02);
      });
      if (this.bassBoostFilter) {
        this.bassBoostFilter.gain.setTargetAtTime(
          normalized.bassBoostEnabled ? normalized.bassBoostDb : 0,
          now,
          0.02
        );
      }
      if (this.masterGainNode) {
        this.masterGainNode.gain.setTargetAtTime(computeMasterOutputGain(normalized), now, 0.02);
      }
    }
  }

  resetDspFlat(): DspSettings {
    const next: DspSettings = {
      ...DEFAULT_DSP_SETTINGS,
      crossfadeSeconds: this.dspSettings.crossfadeSeconds,
    };
    this.updateDspSettings(next);
    return next;
  }
}

export const audioEngine = new DualChannelAudioEngine();

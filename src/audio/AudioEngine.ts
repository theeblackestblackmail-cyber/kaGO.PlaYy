import { DEFAULT_DSP_SETTINGS, EQ_FREQUENCIES } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type { AudioEngineSnapshot, DspSettings, SynthProfile, Track } from '../types/audio';
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
  shouldAutoResumeBackgroundPause,
} from '../utils/streamFilter';

type Listener = (snapshot: AudioEngineSnapshot) => void;
type TrackEndListener = () => void;

class SynthStemDriver {
  private ctx: AudioContext;
  private output: GainNode;
  private profile: SynthProfile;
  private timerId: number | null = null;
  private step = 0;
  private nextNoteTime = 0;
  private noiseBuffer: AudioBuffer;
  private isRunning = false;
  private padOsc1: OscillatorNode | null = null;
  private padOsc2: OscillatorNode | null = null;
  private padGain: GainNode | null = null;

  constructor(ctx: AudioContext, output: GainNode, profile: SynthProfile) {
    this.ctx = ctx;
    this.output = output;
    this.profile = profile;
    this.noiseBuffer = this.createNoiseBuffer(ctx);
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const bufferSize = ctx.sampleRate * 0.5;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  start(startStep = 0) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.step = startStep;
    this.nextNoteTime = this.ctx.currentTime + 0.03;
    this.startPad();
    this.timerId = window.setInterval(() => this.scheduler(), 25);
  }

  stop() {
    this.isRunning = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.stopPad();
  }

  private startPad() {
    this.stopPad();
    const now = this.ctx.currentTime;
    const padFilter = this.ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.setValueAtTime(680, now);
    padFilter.Q.value = 1.8;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.11, now + 0.8);

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    const padFreq = this.profile.rootFreq * 4;
    osc1.frequency.setValueAtTime(padFreq, now);
    osc2.frequency.setValueAtTime(padFreq * 1.5, now);
    osc1.detune.value = -7;
    osc2.detune.value = 7;

    osc1.connect(padFilter);
    osc2.connect(padFilter);
    padFilter.connect(gain);
    gain.connect(this.output);

    osc1.start(now);
    osc2.start(now);
    this.padOsc1 = osc1;
    this.padOsc2 = osc2;
    this.padGain = gain;
  }

  private stopPad() {
    const now = this.ctx.currentTime;
    if (this.padGain) {
      try {
        this.padGain.gain.cancelScheduledValues(now);
        this.padGain.gain.setTargetAtTime(0.0001, now, 0.04);
      } catch {
        // Ignore
      }
    }
    const o1 = this.padOsc1;
    const o2 = this.padOsc2;
    this.padOsc1 = null;
    this.padOsc2 = null;
    this.padGain = null;
    setTimeout(() => {
      try {
        o1?.stop();
        o1?.disconnect();
        o2?.stop();
        o2?.disconnect();
      } catch {
        // Ignore
      }
    }, 120);
  }

  private scheduler() {
    if (!this.isRunning) return;
    const stepDuration = 60 / this.profile.bpm / 4; // 16th note
    while (this.nextNoteTime < this.ctx.currentTime + 0.12) {
      this.scheduleStep(this.step, this.nextNoteTime, stepDuration);
      this.nextNoteTime += stepDuration;
      this.step = (this.step + 1) % 32;
    }
  }

  private scheduleStep(step: number, time: number, stepDuration: number) {
    const style = this.profile.patternStyle;
    const beatStep = step % 16;

    // Kick pattern
    const isKick =
      style === 'midnight'
        ? beatStep === 0 || beatStep === 10
        : style === 'cyber'
        ? beatStep === 0 || beatStep === 4 || beatStep === 8 || beatStep === 12 || beatStep === 14
        : beatStep % 4 === 0;

    if (isKick) {
      this.triggerKick(time);
    }

    // Snare / Rimshot pattern
    const isSnare =
      style === 'midnight' ? beatStep === 8 : beatStep === 4 || beatStep === 12;
    if (isSnare) {
      this.triggerSnare(time, style === 'cyber');
    }

    // Hi-hat pattern
    if (beatStep % 2 === 1 || (style === 'tokyo' && beatStep % 4 === 2)) {
      this.triggerHat(time, beatStep % 4 === 2 ? 0.09 : 0.045);
    }

    // Bassline pattern
    const bassHit =
      style === 'neon'
        ? true
        : style === 'midnight'
        ? beatStep === 0 || beatStep === 3 || beatStep === 6 || beatStep === 10 || beatStep === 14
        : beatStep % 2 === 0 || beatStep === 11 || beatStep === 15;

    if (bassHit) {
      const scale = this.profile.scale;
      const semi = scale[(step + Math.floor(step / 8)) % scale.length];
      const freq = this.profile.rootFreq * Math.pow(2, semi / 12);
      this.triggerBass(time, freq, stepDuration * (style === 'midnight' ? 1.8 : 0.88));
    }

    // Shift pad chord subtly on bar boundaries
    if (step === 0 || step === 16) {
      const semi = step === 0 ? 0 : this.profile.scale[2] ?? 5;
      const targetFreq = this.profile.rootFreq * 4 * Math.pow(2, semi / 12);
      try {
        this.padOsc1?.frequency.setTargetAtTime(targetFreq, time, 0.2);
        this.padOsc2?.frequency.setTargetAtTime(targetFreq * 1.5, time, 0.2);
      } catch {
        // Ignore
      }
    }
  }

  private triggerKick(time: number) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(145, time);
    osc.frequency.exponentialRampToValueAtTime(Math.max(36, this.profile.rootFreq * 0.8), time + 0.085);

    gain.gain.setValueAtTime(0.65, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.28);

    osc.connect(gain);
    gain.connect(this.output);
    osc.start(time);
    osc.stop(time + 0.3);
  }

  private triggerSnare(time: number, tightRim: boolean) {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(tightRim ? 1900 : 1200, time);

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(tightRim ? 0.18 : 0.24, time);
    nGain.gain.exponentialRampToValueAtTime(0.001, time + (tightRim ? 0.09 : 0.16));

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.output);
    noise.start(time);
    noise.stop(time + 0.18);

    const body = this.ctx.createOscillator();
    const bGain = this.ctx.createGain();
    body.type = 'triangle';
    body.frequency.setValueAtTime(195, time);
    body.frequency.exponentialRampToValueAtTime(95, time + 0.07);
    bGain.gain.setValueAtTime(0.22, time);
    bGain.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
    body.connect(bGain);
    bGain.connect(this.output);
    body.start(time);
    body.stop(time + 0.1);
  }

  private triggerHat(time: number, level: number) {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(8400, time);
    filter.Q.value = 2.4;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(level, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.045);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.output);
    noise.start(time);
    noise.stop(time + 0.05);
  }

  private triggerBass(time: number, freq: number, dur: number) {
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = this.profile.patternStyle === 'midnight' ? 'triangle' : 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    filter.type = 'lowpass';
    filter.Q.value = 3.8;
    filter.frequency.setValueAtTime(freq * 7, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(90, freq * 1.6), time + dur);

    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.24, time + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.output);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }
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
  synthDriver: SynthStemDriver | null;
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
  private currentTrack: Track | null = null;
  private currentTime = 0;
  private duration = 0;
  private synthTickTimer: number | null = null;
  private synthLastTickAt = 0;

  private ytActive = false;
  private ytPlayer: YtPlayerInstance | null = null;
  private ytReady = false;
  private ytLoadPromise: Promise<YtPlayerInstance | null> | null = null;
  private ytTickTimer: number | null = null;
  private ytVolumeTimer: number | null = null;
  private ytStartupTimer: number | null = null;
  private ytRecoveryAttempts = 0;
  private playSeq = 0;
  private ytViewportEl: HTMLElement | null = null;
  private ytViewportZIndex = 30;
  private ytResizeObserver: ResizeObserver | null = null;
  private ytSyncListenerBound = false;
  private backgroundTransitionUntil = 0;
  private userPausedAt = 0;
  private bgKeepaliveTimer: number | null = null;
  private bgListenersBound = false;

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
      if (document.visibilityState !== 'visible' && this.isPlaying) {
        this.handleBackgroundTransition();
      }
    });
    window.addEventListener('pagehide', triggerKeepalive);
    window.addEventListener('blur', triggerKeepalive);
    subscribeNativeKeepalive(() => triggerKeepalive());
  }

  private handleBackgroundTransition() {
    if (!this.isPlaying) return;
    if (this.userPausedAt > 0 && Date.now() - this.userPausedAt < 2000) return;

    this.backgroundTransitionUntil = Date.now() + 6500;
    this.ensurePlaybackAliveNow();
    window.setTimeout(() => this.ensurePlaybackAliveNow(), 160);
    window.setTimeout(() => this.ensurePlaybackAliveNow(), 550);
    this.startBgKeepalive();
  }

  private ensurePlaybackAliveNow() {
    if (!this.isPlaying || !this.currentTrack) return;
    if (this.userPausedAt > 0 && Date.now() - this.userPausedAt < 2000) return;

    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }

    if (this.ytActive && this.ytPlayer && this.ytReady) {
      try {
        const state = this.ytPlayer.getPlayerState();
        const statePaused = window.YT?.PlayerState?.PAUSED ?? 2;
        if (state === statePaused) {
          this.ytPlayer.playVideo();
        }
      } catch {
        // Ignore transient YouTube API errors
      }
      this.startYtTicker();
      return;
    }

    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (active && active.audioEl.src && !active.synthDriver && active.audioEl.paused && !active.audioEl.ended) {
      void active.audioEl.play().catch(() => {});
    }
  }

  private startBgKeepalive() {
    if (this.bgKeepaliveTimer !== null || typeof window === 'undefined') return;
    this.bgKeepaliveTimer = window.setInterval(() => {
      if (!this.isPlaying) {
        this.stopBgKeepalive();
        return;
      }
      const inBackground =
        (typeof document !== 'undefined' && document.visibilityState !== 'visible') ||
        isNativeAndroidApp();
      if (inBackground) {
        this.ensurePlaybackAliveNow();
      }
    }, 1200);
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

  getAnalyserBinCount(): number {
    return this.analyser ? this.analyser.frequencyBinCount : 64;
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
      synthDriver: null,
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
        this.currentTime = audioEl.currentTime || 0;
        if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          this.duration = audioEl.duration;
        }
        this.emit();
      }
    });

    audioEl.addEventListener('ended', () => {
      if (this.activeChannel === id && !this.ytActive) {
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
    if (strip.synthDriver) {
      strip.synthDriver.stop();
      strip.synthDriver = null;
    }
  }

  private stopSynthTicker() {
    if (this.synthTickTimer !== null) {
      clearInterval(this.synthTickTimer);
      this.synthTickTimer = null;
    }
  }

  private startSynthTicker() {
    this.stopSynthTicker();
    this.synthLastTickAt = performance.now();
    this.synthTickTimer = window.setInterval(() => {
      if (!this.isPlaying || this.ytActive) return;
      const now = performance.now();
      const delta = (now - this.synthLastTickAt) / 1000;
      this.synthLastTickAt = now;
      this.currentTime += delta;
      if (this.duration > 0 && this.currentTime >= this.duration) {
        this.currentTime = 0;
        this.isPlaying = false;
        this.stopSynthTicker();
        const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
        active?.synthDriver?.stop();
        this.emit();
        for (const fn of this.endListeners) fn();
        return;
      }
      this.emit();
    }, 200);
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
      onComplete?.();
      return;
    }
    if (seconds <= 0.05) {
      try {
        this.ytPlayer.setVolume(to);
      } catch {
        // Ignore
      }
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

  attachYouTubeViewport(el: HTMLElement | null, zIndex = 30): () => void {
    this.ytViewportEl = el;
    this.ytViewportZIndex = zIndex;

    if (this.ytResizeObserver) {
      this.ytResizeObserver.disconnect();
      this.ytResizeObserver = null;
    }

    if (el && typeof ResizeObserver !== 'undefined') {
      this.ytResizeObserver = new ResizeObserver(() => this.syncYouTubeHostGeometry());
      this.ytResizeObserver.observe(el);
    }

    if (typeof window !== 'undefined' && !this.ytSyncListenerBound) {
      this.ytSyncListenerBound = true;
      const sync = () => this.syncYouTubeHostGeometry();
      window.addEventListener('scroll', sync, true);
      window.addEventListener('resize', sync);
    }

    this.syncYouTubeHostGeometry();

    return () => {
      if (this.ytViewportEl === el) {
        this.ytViewportEl = null;
        if (this.ytResizeObserver) {
          this.ytResizeObserver.disconnect();
          this.ytResizeObserver = null;
        }
        this.syncYouTubeHostGeometry();
      }
    };
  }

  private syncYouTubeHostGeometry() {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('kago-yt-host');
    if (!host) return;

    const frame = document.getElementById('kago-yt-frame');
    if (frame) {
      frame.style.width = '100%';
      frame.style.height = '100%';
    }

    if (this.ytViewportEl && this.ytActive && document.contains(this.ytViewportEl)) {
      const rect = this.ytViewportEl.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) {
        host.removeAttribute('aria-hidden');
        host.removeAttribute('inert');
        host.style.position = 'fixed';
        host.style.top = `${Math.round(rect.top)}px`;
        host.style.left = `${Math.round(rect.left)}px`;
        host.style.bottom = 'auto';
        host.style.right = 'auto';
        host.style.width = `${Math.round(rect.width)}px`;
        host.style.height = `${Math.round(rect.height)}px`;
        host.style.opacity = '1';
        host.style.pointerEvents = 'auto';
        host.style.zIndex = String(this.ytViewportZIndex);
        host.style.borderRadius = '10px';
        return;
      }
    }

    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
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
                this.syncYouTubeHostGeometry();
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
                if (ev.data === statePlaying) {
                  this.clearYtStartupWatchdog();
                  this.isPlaying = true;
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
                  this.emit();
                } else if (ev.data === statePaused) {
                  const vis = typeof document !== 'undefined' ? document.visibilityState : 'visible';
                  if (
                    shouldAutoResumeBackgroundPause({
                      isPlaying: this.isPlaying,
                      visibilityState: vis,
                      now: Date.now(),
                      backgroundTransitionUntil: this.backgroundTransitionUntil,
                      userPausedAt: this.userPausedAt,
                    })
                  ) {
                    try {
                      ev.target.playVideo();
                    } catch {
                      // Ignore
                    }
                    window.setTimeout(() => this.ensurePlaybackAliveNow(), 180);
                    window.setTimeout(() => this.ensurePlaybackAliveNow(), 600);
                    return;
                  }
                  if (vis === 'visible' || (this.userPausedAt > 0 && Date.now() - this.userPausedAt < 2000)) {
                    this.isPlaying = false;
                    this.stopYtTicker();
                    this.stopBgKeepalive();
                    this.emit();
                  }
                } else if (ev.data === stateEnded) {
                  this.isPlaying = false;
                  this.stopYtTicker();
                  this.stopBgKeepalive();
                  this.emit();
                  for (const fn of this.endListeners) fn();
                }
              },
              onError: () => {
                if (!this.ytActive || !this.currentTrack) return;
                void this.recoverActiveYouTubeTrack(this.currentTrack, this.playSeq);
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

  private async recoverActiveYouTubeTrack(track: Track, seq: number) {
    if (seq !== this.playSeq) return;
    const activeStrip = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (!activeStrip) return;

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
            this.currentTime = 0;
            this.ytPlayer.loadVideoById(data.youtubeId, 0);
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
            const proxied = `/api/stream/proxy?url=${encodeURIComponent(data.streamUrl)}`;
            activeStrip.audioEl.src = proxied;
            try {
              await activeStrip.audioEl.play();
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
          // Fall through to synth stem
        }
      }
    }

    if (seq !== this.playSeq) return;
    this.stopYouTubePlayback(0);
    this.currentTrack = {
      ...track,
      recoveredFrom: track.recoveredFrom || 'Local Synth Engine Fallback',
    };
    await this.startSynthOnStrip(activeStrip, this.currentTrack);
    this.emit();
  }

  async playTrack(track: Track): Promise<void> {
    const seq = ++this.playSeq;
    this.ytRecoveryAttempts = 0;

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
      this.stopSynthTicker();
    }

    this.userPausedAt = 0;
    this.activeChannel = incomingChannelId;
    this.currentTrack = track;
    this.currentTime = 0;
    this.duration = track.duration || 180;
    this.isPlaying = true;
    localDb.pushHistory(track.id);

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

    // Play full-length YouTube stream via YouTube IFrame Player API
    if (track.youtubeId) {
      this.stopSynthTicker();
      this.ytActive = true;
      this.syncYouTubeHostGeometry();
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

    // Decide how to render audio for non-YouTube tracks
    if (track.source === 'synth' || (!track.streamUrl && track.source === 'stream' && track.synthProfile)) {
      await this.startSynthOnStrip(incomingStrip, track);
    } else if (track.source === 'local') {
      incomingStrip.audioEl.volume = 1.0;
      incomingStrip.audioEl.muted = false;
      const blob = await localDb.getAudioBlob(track.id);
      if (seq !== this.playSeq) return;
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
      if (seq !== this.playSeq) return;
      if (blob) {
        const url = URL.createObjectURL(blob);
        incomingStrip.objectUrl = url;
        incomingStrip.audioEl.src = url;
        incomingStrip.audioEl.currentTime = 0;
        try {
          await incomingStrip.audioEl.play();
        } catch {
          if (seq !== this.playSeq) return;
          // Fallback to synth if browser rejects codec
          if (track.synthProfile) await this.startSynthOnStrip(incomingStrip, track);
        }
      } else if (track.streamUrl) {
        incomingStrip.audioEl.src = track.streamUrl;
        incomingStrip.audioEl.currentTime = 0;
        await incomingStrip.audioEl.play().catch(() => {});
      }
    } else if (track.streamUrl) {
      incomingStrip.audioEl.volume = 1.0;
      incomingStrip.audioEl.muted = false;
      const proxied =
        track.streamUrl.startsWith('http') && !track.streamUrl.startsWith(window.location.origin)
          ? `/api/stream/proxy?url=${encodeURIComponent(track.streamUrl)}`
          : track.streamUrl;
      incomingStrip.audioEl.src = proxied;
      try {
        await incomingStrip.audioEl.play();
      } catch {
        // Standalone APK fallback: try direct HTTPS stream if proxy route isn't mounted
        if (proxied !== track.streamUrl) {
          try {
            incomingStrip.audioEl.src = track.streamUrl;
            await incomingStrip.audioEl.play();
            this.emit();
            return;
          } catch {
            // Fall through to synthesized stem profile
          }
        }
        await this.startSynthOnStrip(incomingStrip, track);
      }
    } else {
      await this.startSynthOnStrip(incomingStrip, track);
    }

    this.startBgKeepalive();
    this.emit();
  }

  private async startSynthOnStrip(strip: ChannelStrip, track: Track) {
    const ctx = this.ensureContext();
    const profile: SynthProfile = track.synthProfile || {
      bpm: track.bpm || 115,
      rootFreq: track.rootFreq || 55,
      scale: [0, 3, 7, 10, 12],
      patternStyle: 'cyber',
      description: 'Synthesized stream fallback',
    };
    const driver = new SynthStemDriver(ctx, strip.gainNode, profile);
    strip.synthDriver = driver;
    driver.start(0);
    this.startSynthTicker();
  }

  pause(): void {
    if (!this.currentTrack) return;
    this.userPausedAt = Date.now();
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
      if (active.synthDriver) {
        active.synthDriver.stop();
        this.stopSynthTicker();
      } else {
        active.audioEl.pause();
      }
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
    if (active.synthDriver || this.currentTrack.source === 'synth' || !active.audioEl.src) {
      if (!active.synthDriver) {
        await this.startSynthOnStrip(active, this.currentTrack);
      } else {
        const bpm = this.currentTrack.synthProfile?.bpm || this.currentTrack.bpm || 110;
        const stepIdx = Math.floor((this.currentTime * bpm) / 15) % 32;
        active.synthDriver.start(stepIdx);
        this.startSynthTicker();
      }
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
    if (active && active.audioEl.src && !active.synthDriver) {
      try {
        active.audioEl.currentTime = clamped;
      } catch {
        // Ignore
      }
    } else if (active?.synthDriver && this.isPlaying && this.currentTrack) {
      const bpm = this.currentTrack.synthProfile?.bpm || this.currentTrack.bpm || 110;
      const stepIdx = Math.floor((clamped * bpm) / 15) % 32;
      active.synthDriver.stop();
      active.synthDriver.start(stepIdx);
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

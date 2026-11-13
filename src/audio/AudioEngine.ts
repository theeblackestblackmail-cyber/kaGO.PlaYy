import { DEFAULT_DSP_SETTINGS, EQ_FREQUENCIES } from '../data/presetsAndStems';
import { localDb } from '../db/localDb';
import type { AudioEngineSnapshot, DspSettings, SynthProfile, Track } from '../types/audio';

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

  private listeners = new Set<Listener>();
  private endListeners = new Set<TrackEndListener>();

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

    // Protective Dynamics Limiter
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -3;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.compressor = comp;

    // 60fps Analyser
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.78;
    this.analyser = analyser;

    // Wire EQ -> Bass Boost -> Compressor -> Analyser -> Destination
    for (let i = 0; i < eqNodes.length - 1; i++) {
      eqNodes[i].connect(eqNodes[i + 1]);
    }
    eqNodes[eqNodes.length - 1].connect(bassBoost);
    bassBoost.connect(comp);
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

    audioEl.addEventListener('timeupdate', () => {
      if (this.activeChannel === id && this.currentTrack?.source !== 'synth') {
        this.currentTime = audioEl.currentTime || 0;
        if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          this.duration = audioEl.duration;
        }
        this.emit();
      }
    });

    audioEl.addEventListener('ended', () => {
      if (this.activeChannel === id) {
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
      if (!this.isPlaying) return;
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

  async playTrack(track: Track): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const wasPlaying = this.isPlaying && this.currentTrack !== null;
    const crossfade = wasPlaying ? this.dspSettings.crossfadeSeconds : 0;

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
      outgoingStrip.gainNode.gain.setValueAtTime(outgoingStrip.gainNode.gain.value || 1, now);
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

    // Decide how to render audio for this track
    if (track.source === 'synth' || (!track.streamUrl && track.source === 'stream' && track.synthProfile)) {
      await this.startSynthOnStrip(incomingStrip, track);
    } else if (track.source === 'local') {
      const blob = await localDb.getAudioBlob(track.id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        incomingStrip.objectUrl = url;
        incomingStrip.audioEl.src = url;
        try {
          await incomingStrip.audioEl.play();
        } catch {
          // Fallback to synth if browser rejects codec
          if (track.synthProfile) await this.startSynthOnStrip(incomingStrip, track);
        }
      } else if (track.streamUrl) {
        incomingStrip.audioEl.src = track.streamUrl;
        await incomingStrip.audioEl.play().catch(() => {});
      }
    } else if (track.streamUrl) {
      const proxied =
        track.streamUrl.startsWith('http') && !track.streamUrl.startsWith(window.location.origin)
          ? `/api/stream/proxy?url=${encodeURIComponent(track.streamUrl)}`
          : track.streamUrl;
      incomingStrip.audioEl.src = proxied;
      try {
        await incomingStrip.audioEl.play();
      } catch {
        // Auto fallback to synthesized stem profile if external audio stream fails
        await this.startSynthOnStrip(incomingStrip, track);
      }
    } else {
      await this.startSynthOnStrip(incomingStrip, track);
    }

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

  async togglePlay(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (!this.currentTrack) return;

    const active = this.activeChannel === 'A' ? this.channelA : this.channelB;
    if (!active) return;

    if (this.isPlaying) {
      this.isPlaying = false;
      if (active.synthDriver) {
        active.synthDriver.stop();
        this.stopSynthTicker();
      } else {
        active.audioEl.pause();
      }
    } else {
      this.isPlaying = true;
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
    }
    this.emit();
  }

  seek(targetSeconds: number): void {
    const clamped = Math.max(0, Math.min(this.duration || 180, targetSeconds));
    this.currentTime = clamped;
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
    this.dspSettings = next;
    localDb.saveDspSettings(next);

    if (this.ctx) {
      const now = this.ctx.currentTime;
      this.eqFilters.forEach((filter, idx) => {
        filter.gain.setTargetAtTime(next.bands[idx] ?? 0, now, 0.02);
      });
      if (this.bassBoostFilter) {
        this.bassBoostFilter.gain.setTargetAtTime(
          next.bassBoostEnabled ? next.bassBoostDb : 0,
          now,
          0.02
        );
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

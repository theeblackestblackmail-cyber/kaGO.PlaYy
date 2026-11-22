import type { Track } from '../types/audio';
import {
  downloadToCacheNative,
  hasNativeMediaDownloadBridge,
  hasNativePublicDownloadBridge,
  nativePostJson,
  hasNativeHttpPostBridge,
  readCachedDownloadBytes,
  saveNativeMediaToPublicDownloads,
} from './nativeMediaBridge';

export type DownloadFormatId =
  | 'm4a-128'
  | 'mp3-70'
  | 'mp3-128'
  | 'mp3-160'
  | 'mp3-320'
  | 'mp4-144p'
  | 'mp4-240p'
  | 'mp4-360p'
  | 'mp4-480p'
  | 'mp4-720p';

export interface DownloadFormatOption {
  id: DownloadFormatId;
  category: 'music' | 'video';
  title: string;
  subtitle: string;
  badge?: 'Low' | 'Slow';
  ext: 'm4a' | 'mp3' | 'mp4';
  mimeType: string;
  estimatedBitrateKbps: number;
  resolutionLabel?: string;
}

export const DEFAULT_LOCAL_DOWNLOAD_FORMAT: DownloadFormatId = 'mp3-160';

export const DOWNLOAD_FORMAT_OPTIONS: DownloadFormatOption[] = [
  {
    id: 'm4a-128',
    category: 'music',
    title: 'Fast',
    subtitle: 'M4A (128K), best for mobile play',
    ext: 'm4a',
    mimeType: 'audio/mp4',
    estimatedBitrateKbps: 128,
  },
  {
    id: 'mp3-70',
    category: 'music',
    title: 'Classic MP3 (70K)',
    subtitle: 'Supports Bluetooth speakers, phones, car stereos, smartwatches, etc',
    badge: 'Low',
    ext: 'mp3',
    mimeType: 'audio/mpeg',
    estimatedBitrateKbps: 70,
  },
  {
    id: 'mp3-128',
    category: 'music',
    title: 'Classic MP3 (128K)',
    subtitle: 'Supports Bluetooth speakers, phones, car stereos, smartwatches, etc',
    ext: 'mp3',
    mimeType: 'audio/mpeg',
    estimatedBitrateKbps: 128,
  },
  {
    id: 'mp3-160',
    category: 'music',
    title: 'Classic MP3',
    subtitle: 'MP3 (160K), support Bluetooth speaker, mobile phone, car, watch etc.',
    ext: 'mp3',
    mimeType: 'audio/mpeg',
    estimatedBitrateKbps: 160,
  },
  {
    id: 'mp3-320',
    category: 'music',
    title: 'Classic MP3 (320K)',
    subtitle: 'Supports Bluetooth speakers, phones, car stereos, smartwatches, etc',
    badge: 'Slow',
    ext: 'mp3',
    mimeType: 'audio/mpeg',
    estimatedBitrateKbps: 320,
  },
  {
    id: 'mp4-144p',
    category: 'video',
    title: 'Fast (144p)',
    subtitle: 'Poor video quality',
    badge: 'Low',
    ext: 'mp4',
    mimeType: 'video/mp4',
    estimatedBitrateKbps: 185,
    resolutionLabel: '144p',
  },
  {
    id: 'mp4-240p',
    category: 'video',
    title: 'Fast (240p)',
    subtitle: 'Low quality for quick play',
    ext: 'mp4',
    mimeType: 'video/mp4',
    estimatedBitrateKbps: 265,
    resolutionLabel: '240p',
  },
  {
    id: 'mp4-360p',
    category: 'video',
    title: 'Fast (360p)',
    subtitle: 'Normal quality for quick play',
    ext: 'mp4',
    mimeType: 'video/mp4',
    estimatedBitrateKbps: 420,
    resolutionLabel: '360p',
  },
  {
    id: 'mp4-480p',
    category: 'video',
    title: 'Fast (480p)',
    subtitle: 'Normal quality for quick play',
    ext: 'mp4',
    mimeType: 'video/mp4',
    estimatedBitrateKbps: 650,
    resolutionLabel: '480p',
  },
  {
    id: 'mp4-720p',
    category: 'video',
    title: 'High quality (720p)',
    subtitle: 'Clear view and quick play',
    ext: 'mp4',
    mimeType: 'video/mp4',
    estimatedBitrateKbps: 1150,
    resolutionLabel: '720p',
  },
];

export const DOWNLOAD_FORMAT_MAP: Record<DownloadFormatId, DownloadFormatOption> = Object.fromEntries(
  DOWNLOAD_FORMAT_OPTIONS.map((opt) => [opt.id, opt])
) as Record<DownloadFormatId, DownloadFormatOption>;

export interface DownloadProgressInfo {
  percent: number;
  loadedBytes: number;
  totalBytes?: number;
  label?: string;
}

export interface ResolvedDirectMedia {
  audioUrl?: string;
  audioExt?: 'm4a' | 'webm' | 'mp3';
  audioContentLength?: number;
  muxed360Url?: string;
  muxed360Length?: number;
  videoStreams: Partial<Record<'144p' | '240p' | '360p' | '480p' | '720p', { url: string; contentLength: number }>>;
  durationSeconds?: number;
}

/**
 * Only streamed tracks (YouTube / Audius) expose the Download trigger.
 * Local device files and internal synth stems must never show it.
 */
export function isStreamDownloadableTrack(track?: Track | null): track is Track {
  if (!track) return false;
  if (track.source !== 'stream') return false;
  if (track.youtubePlaylistId || track.resultType === 'album' || track.resultType === 'playlist') {
    return false;
  }
  return Boolean(track.youtubeId || track.streamUrl);
}

export function isCollectionDownloadable(tracks: Track[]): boolean {
  return tracks.some((t) => isStreamDownloadableTrack(t));
}

export function isTrackSavedAsAppDownload(trackId: string, savedTracks: Track[]): boolean {
  return savedTracks.some((t) => t.id === trackId && Boolean(t.isAppDownload));
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '— MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${mb.toFixed(0)} MB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${Math.max(0.1, mb).toFixed(1)} MB`;
}

export function estimateFormatSizeBytes(
  durationSeconds: number,
  option: DownloadFormatOption,
  exactSizes?: Partial<Record<DownloadFormatId, number>>
): number {
  const exact = exactSizes?.[option.id];
  if (typeof exact === 'number' && Number.isFinite(exact) && exact > 0) {
    return exact;
  }
  const safeDuration = Math.max(30, Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 210);
  // (kbps * 1000 / 8) * seconds
  return Math.round(((option.estimatedBitrateKbps * 1000) / 8) * safeDuration);
}

export function sanitizeDownloadFilename(
  title: string,
  artist: string,
  ext: string
): string {
  const cleanTitle = (title || 'Track')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanArtist = (artist || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = (cleanArtist ? `${cleanArtist} - ${cleanTitle}` : cleanTitle).slice(0, 110).trim() || 'kagoplay-audio';
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp3';
  return `${base}.${safeExt}`;
}

export async function resolveTrackDirectMediaNative(
  track: Track
): Promise<ResolvedDirectMedia | null> {
  if (!track.youtubeId) {
    if (track.streamUrl) {
      return {
        audioUrl: track.streamUrl,
        audioExt: 'mp3',
        videoStreams: {},
        durationSeconds: track.duration || 180,
      };
    }
    return null;
  }

  if (!hasNativeHttpPostBridge()) return null;

  try {
    const res = await nativePostJson(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        videoId: track.youtubeId,
        context: {
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.60.19',
            androidSdkVersion: 32,
            hl: 'en',
            gl: 'US',
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      },
      10000
    );

    if (!res?.ok || !res.text) return null;
    const data = JSON.parse(res.text) as {
      videoDetails?: { lengthSeconds?: string };
      streamingData?: {
        formats?: Array<{ itag?: number; url?: string; contentLength?: string; mimeType?: string }>;
        adaptiveFormats?: Array<{
          itag?: number;
          url?: string;
          contentLength?: string;
          mimeType?: string;
          bitrate?: number;
          qualityLabel?: string;
        }>;
      };
    };

    const streaming = data.streamingData;
    if (!streaming) return null;

    const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
    const formats = Array.isArray(streaming.formats) ? streaming.formats : [];

    // Prefer itag 140 (M4A AAC 128k), then any MP4 audio, then any audio
    const m4a140 = adaptive.find((f) => f.itag === 140 && f.url);
    const anyMp4Audio = adaptive.find((f) => (f.mimeType || '').includes('audio/mp4') && f.url);
    const anyAudio = adaptive.find((f) => (f.mimeType || '').startsWith('audio/') && f.url);
    const pickedAudio = m4a140 || anyMp4Audio || anyAudio;

    const muxed18 = formats.find((f) => f.itag === 18 && f.url);

    const videoStreams: ResolvedDirectMedia['videoStreams'] = {};
    const desiredVideoItags: Array<{ res: '144p' | '240p' | '360p' | '480p' | '720p'; itag: number }> = [
      { res: '144p', itag: 160 },
      { res: '240p', itag: 133 },
      { res: '360p', itag: 134 },
      { res: '480p', itag: 135 },
      { res: '720p', itag: 136 },
    ];

    for (const target of desiredVideoItags) {
      const match =
        adaptive.find((f) => f.itag === target.itag && f.url) ||
        adaptive.find(
          (f) =>
            (f.mimeType || '').includes('video/mp4') &&
            (f.mimeType || '').includes('avc1') &&
            f.qualityLabel === target.res &&
            f.url
        );
      if (match?.url) {
        videoStreams[target.res] = {
          url: match.url,
          contentLength: Number(match.contentLength || 0) || 0,
        };
      }
    }

    const parsedDuration = Number(data.videoDetails?.lengthSeconds || 0) || track.duration || 180;
    const audioMime = pickedAudio?.mimeType || '';
    return {
      audioUrl: pickedAudio?.url || muxed18?.url,
      audioExt: audioMime.includes('webm') ? 'webm' : 'm4a',
      audioContentLength: Number(pickedAudio?.contentLength || 0) || 0,
      muxed360Url: muxed18?.url,
      muxed360Length: Number(muxed18?.contentLength || 0) || 0,
      videoStreams,
      durationSeconds: parsedDuration,
    };
  } catch {
    return null;
  }
}

export async function fetchStreamFormatSizes(
  track: Track
): Promise<{
  sizes: Partial<Record<DownloadFormatId, number>>;
  durationSeconds: number;
}> {
  const durationSeconds = Math.max(10, track.duration || 210);
  if (!isStreamDownloadableTrack(track)) {
    return { sizes: {}, durationSeconds };
  }

  try {
    const params = new URLSearchParams();
    if (track.youtubeId) params.set('youtubeId', track.youtubeId);
    if (track.streamUrl) params.set('streamUrl', track.streamUrl);
    params.set('duration', String(Math.round(durationSeconds)));

    const res = await fetch(`/api/stream/formats?${params.toString()}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json()) as {
        sizes?: Partial<Record<DownloadFormatId, number>>;
        durationSeconds?: number;
      };
      if (data.sizes) {
        return {
          sizes: data.sizes,
          durationSeconds: data.durationSeconds || durationSeconds,
        };
      }
    }
  } catch {
    // Fall back to native / duration estimation below
  }

  const nativeResolved = await resolveTrackDirectMediaNative(track);
  if (nativeResolved) {
    const dur = nativeResolved.durationSeconds || durationSeconds;
    const sizes: Partial<Record<DownloadFormatId, number>> = {};
    const audioBytes = nativeResolved.audioContentLength || 0;
    for (const opt of DOWNLOAD_FORMAT_OPTIONS) {
      if (opt.id === 'm4a-128' && audioBytes > 0) {
        sizes[opt.id] = audioBytes;
      } else if (opt.category === 'video' && opt.resolutionLabel) {
        const resKey = opt.resolutionLabel as '144p' | '240p' | '360p' | '480p' | '720p';
        const vInfo = nativeResolved.videoStreams[resKey];
        if (vInfo?.contentLength && audioBytes > 0) {
          sizes[opt.id] = vInfo.contentLength + audioBytes;
        } else if (opt.id === 'mp4-360p' && nativeResolved.muxed360Length) {
          sizes[opt.id] = nativeResolved.muxed360Length;
        } else {
          sizes[opt.id] = estimateFormatSizeBytes(dur, opt);
        }
      } else {
        sizes[opt.id] = estimateFormatSizeBytes(dur, opt);
      }
    }
    return { sizes, durationSeconds: dur };
  }

  const fallbackSizes: Partial<Record<DownloadFormatId, number>> = {};
  for (const opt of DOWNLOAD_FORMAT_OPTIONS) {
    fallbackSizes[opt.id] = estimateFormatSizeBytes(durationSeconds, opt);
  }
  return { sizes: fallbackSizes, durationSeconds };
}

async function fetchBlobWithProgress(
  url: string,
  fallbackMime: string,
  onProgress?: (info: DownloadProgressInfo) => void
): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(errText || `Download request failed (${res.status})`);
  }

  const totalHeader = Number(res.headers.get('content-length') || 0);
  const contentType = res.headers.get('content-type') || fallbackMime;
  if (!res.body) {
    const blob = await res.blob();
    onProgress?.({ percent: 100, loadedBytes: blob.size, totalBytes: blob.size });
    return blob;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunks.push(value);
      loadedBytes += value.byteLength;
      const percent =
        totalHeader > 0
          ? Math.min(99, Math.round((loadedBytes / totalHeader) * 100))
          : Math.min(92, Math.round(loadedBytes / 65536) + 12);
      onProgress?.({
        percent,
        loadedBytes,
        totalBytes: totalHeader > 0 ? totalHeader : undefined,
      });
    }
  }

  const combined = new Uint8Array(loadedBytes);
  let pos = 0;
  for (const part of chunks) {
    combined.set(part, pos);
    pos += part.byteLength;
  }
  const blob = new Blob([combined.slice()], { type: contentType });
  onProgress?.({ percent: 100, loadedBytes: blob.size, totalBytes: blob.size });
  return blob;
}

function buildServerDownloadUrl(track: Track, formatId: DownloadFormatId): string {
  const params = new URLSearchParams({
    format: formatId,
    title: track.title || 'Track',
    artist: track.artist || 'Unknown Artist',
  });
  if (track.album) params.set('album', track.album);
  if (track.youtubeId) params.set('youtubeId', track.youtubeId);
  if (track.streamUrl) params.set('streamUrl', track.streamUrl);
  return `/api/stream/download?${params.toString()}`;
}

/**
 * Mode 1: Save inside kaGO.PIaY's private IndexedDB storage (Spotify Premium model).
 * Hidden from public device Downloads; plays 100% offline with full WebAudio DSP.
 */
export async function downloadTrackToAppStorage(
  track: Track,
  onProgress?: (info: DownloadProgressInfo) => void
): Promise<{ track: Track; blob: Blob }> {
  if (!isStreamDownloadableTrack(track)) {
    throw new Error('Only streamed songs can be saved for offline listening.');
  }

  let downloadedBlob: Blob | null = null;
  let formatLabel = track.youtubeId ? 'M4A 128K' : 'MP3 Stream';

  // 1. Try server endpoint (Web/PWA & tethered APK)
  try {
    const serverUrl = buildServerDownloadUrl(track, track.youtubeId ? 'm4a-128' : 'mp3-160');
    const candidateBlob = await fetchBlobWithProgress(serverUrl, 'audio/mp4', onProgress);
    if (candidateBlob.size >= 4096) {
      downloadedBlob = candidateBlob;
    }
  } catch {
    // Standalone Capacitor APK falls through to native CDN downloader
  }

  // 2. Native Android standalone fallback (fetches googlevideo / Audius URL into native cache + reads chunks into IndexedDB)
  if (!downloadedBlob && hasNativeMediaDownloadBridge()) {
    const resolved = await resolveTrackDirectMediaNative(track);
    if (resolved?.audioUrl) {
      const nativeCached = await downloadToCacheNative(
        resolved.audioUrl,
        (loadedBytes, totalBytes) => {
          const percent =
            totalBytes > 0
              ? Math.min(96, Math.round((loadedBytes / totalBytes) * 100))
              : 45;
          onProgress?.({ percent, loadedBytes, totalBytes });
        }
      );
      if (nativeCached.ok && nativeCached.totalBytes > 4096) {
        const bytes = readCachedDownloadBytes(nativeCached.requestId, nativeCached.totalBytes);
        if (bytes && bytes.byteLength > 4096) {
          const mime = resolved.audioExt === 'webm' ? 'audio/webm' : resolved.audioExt === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
          downloadedBlob = new Blob([bytes.slice()], { type: mime });
          formatLabel = resolved.audioExt === 'webm' ? 'OPUS Audio' : resolved.audioExt === 'mp3' ? 'MP3 Audio' : 'M4A 128K';
          onProgress?.({ percent: 100, loadedBytes: downloadedBlob.size, totalBytes: downloadedBlob.size });
        }
      }
    }
  }

  // 3. Direct Audius proxy fallback if streamUrl is present
  if (!downloadedBlob && track.streamUrl) {
    const directOrProxy = track.streamUrl.startsWith('http')
      ? `/api/stream/proxy?url=${encodeURIComponent(track.streamUrl)}`
      : track.streamUrl;
    const fallbackBlob = await fetchBlobWithProgress(directOrProxy, 'audio/mpeg', onProgress);
    if (fallbackBlob.size >= 4096) {
      downloadedBlob = fallbackBlob;
      formatLabel = 'MP3 Audio';
    }
  }

  if (!downloadedBlob || downloadedBlob.size < 4096) {
    throw new Error('Could not fetch audio bytes for offline storage.');
  }

  const savedTrack: Track = {
    ...track,
    isAppDownload: true,
    downloadedAt: Date.now(),
    downloadSizeBytes: downloadedBlob.size,
    downloadFormat: formatLabel,
  };

  return { track: savedTrack, blob: downloadedBlob };
}

function triggerBrowserFileDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }, 45000);
}

/**
 * Mode 2: Download locally to public device storage in chosen Music or Video format.
 */
export async function downloadTrackToLocalDevice(
  track: Track,
  formatId: DownloadFormatId,
  onProgress?: (info: DownloadProgressInfo) => void
): Promise<{ filename: string; sizeBytes: number; actualFormatLabel: string }> {
  if (!isStreamDownloadableTrack(track)) {
    throw new Error('Only streamed content can be downloaded locally.');
  }

  const option = DOWNLOAD_FORMAT_MAP[formatId] || DOWNLOAD_FORMAT_MAP[DEFAULT_LOCAL_DOWNLOAD_FORMAT];
  const targetFilename = sanitizeDownloadFilename(track.title, track.artist, option.ext);

  // Check whether server backend transcoding endpoint is reachable
  let serverReachable = true;
  try {
    const serverDownloadUrl = buildServerDownloadUrl(track, option.id);
    if (hasNativePublicDownloadBridge() && typeof window !== 'undefined' && (window.location.protocol === 'capacitor:' || window.location.hostname === 'localhost')) {
      // Probe health quickly so standalone static APK skips 404 HTML bodies
      const probe = await fetch('/api/health', { signal: AbortSignal.timeout(1800) }).catch(() => null);
      serverReachable = Boolean(probe?.ok && (probe.headers.get('content-type') || '').includes('application/json'));
    }

    if (serverReachable) {
      const blob = await fetchBlobWithProgress(serverDownloadUrl, option.mimeType, onProgress);
      if (blob.size >= 4096 && !blob.type.includes('text/html')) {
        triggerBrowserFileDownload(blob, targetFilename);
        return {
          filename: targetFilename,
          sizeBytes: blob.size,
          actualFormatLabel: option.title,
        };
      }
    }
  } catch (err) {
    if (!hasNativePublicDownloadBridge()) {
      throw err instanceof Error ? err : new Error('Failed to download file.');
    }
  }

  // Standalone Android APK fallback: write directly to MediaStore.Downloads/kaGO.PIaY
  if (hasNativePublicDownloadBridge()) {
    const resolved = await resolveTrackDirectMediaNative(track);
    if (!resolved) {
      throw new Error('Could not resolve direct media stream on device.');
    }

    if (option.category === 'video' && option.resolutionLabel) {
      const resKey = option.resolutionLabel as '144p' | '240p' | '360p' | '480p' | '720p';
      const adaptiveVideo = resolved.videoStreams[resKey];
      const primaryUrl =
        adaptiveVideo?.url ||
        (resKey === '360p' ? resolved.muxed360Url : undefined) ||
        resolved.muxed360Url;
      const secondaryAudio = adaptiveVideo?.url ? resolved.audioUrl : undefined;

      if (!primaryUrl) {
        throw new Error(`Video stream ${option.resolutionLabel} unavailable for this item.`);
      }

      const nativeResult = await saveNativeMediaToPublicDownloads({
        primaryUrl,
        secondaryAudioUrl: secondaryAudio,
        fileName: targetFilename,
        mimeType: 'video/mp4',
        onProgress: (loadedBytes, totalBytes) => {
          const percent = totalBytes > 0 ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100)) : 50;
          onProgress?.({ percent, loadedBytes, totalBytes });
        },
      });

      if (!nativeResult.ok) {
        throw new Error(nativeResult.error || 'Android download failed.');
      }

      onProgress?.({ percent: 100, loadedBytes: nativeResult.totalBytes, totalBytes: nativeResult.totalBytes });
      return {
        filename: targetFilename,
        sizeBytes: nativeResult.totalBytes,
        actualFormatLabel: option.title,
      };
    }

    // Audio in standalone offline APK without Node LAME encoder: save M4A AAC directly (playable on every Android device)
    if (!resolved.audioUrl) {
      throw new Error('Audio stream unavailable on this video.');
    }
    const nativeExt = resolved.audioExt === 'mp3' ? 'mp3' : 'm4a';
    const nativeFilename = sanitizeDownloadFilename(track.title, track.artist, nativeExt);
    const nativeMime = nativeExt === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
    const nativeResult = await saveNativeMediaToPublicDownloads({
      primaryUrl: resolved.audioUrl,
      fileName: nativeFilename,
      mimeType: nativeMime,
      onProgress: (loadedBytes, totalBytes) => {
        const percent = totalBytes > 0 ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100)) : 50;
        onProgress?.({ percent, loadedBytes, totalBytes });
      },
    });
    if (!nativeResult.ok) {
      throw new Error(nativeResult.error || 'Android download failed.');
    }
    onProgress?.({ percent: 100, loadedBytes: nativeResult.totalBytes, totalBytes: nativeResult.totalBytes });
    return {
      filename: nativeFilename,
      sizeBytes: nativeResult.totalBytes,
      actualFormatLabel: nativeExt === 'mp3' ? 'Classic MP3' : 'Fast M4A (128K)',
    };
  }

  throw new Error('Download service unavailable.');
}

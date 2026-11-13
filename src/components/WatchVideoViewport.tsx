import React, { useEffect, useRef, useState } from 'react';
import { Disc3, ExternalLink, PictureInPicture2, Radio, Video } from 'lucide-react';
import { audioEngine } from '../audio/AudioEngine';
import type { Track } from '../types/audio';
import { enterNativeAndroidPip, isNativeAndroidApp, setNativeVideoMode } from '../utils/nativeMediaBridge';

interface DocumentPictureInPictureApi {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
}

interface WatchVideoViewportProps {
  track: Track | null;
  isPlaying: boolean;
  currentTime: number;
  zIndex?: number;
  compact?: boolean;
  isInAppPip?: boolean;
  onToggleInAppPip?: () => void;
  onOpenStream?: () => void;
}

export const WatchVideoViewport: React.FC<WatchVideoViewportProps> = ({
  track,
  isPlaying,
  currentTime,
  zIndex = 30,
  compact = false,
  isInAppPip = false,
  onToggleInAppPip,
  onOpenStream,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const pipIframeRef = useRef<HTMLIFrameElement | null>(null);
  const pipTitleRef = useRef<HTMLSpanElement | null>(null);
  const [pipNote, setPipNote] = useState<string>('');
  const [isDocPipOpen, setIsDocPipOpen] = useState(false);

  const hasYouTubeVideo = Boolean(track?.youtubeId);

  useEffect(() => {
    setNativeVideoMode(hasYouTubeVideo);
    return () => {
      setNativeVideoMode(false);
    };
  }, [hasYouTubeVideo]);

  useEffect(() => {
    if (!hasYouTubeVideo || isInAppPip || isDocPipOpen) {
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    const detach = audioEngine.attachYouTubeViewport(el, zIndex);
    return () => {
      detach();
    };
  }, [hasYouTubeVideo, track?.youtubeId, zIndex, isInAppPip, isDocPipOpen]);

  // Keep an open Document PiP window synced when user skips to another track
  useEffect(() => {
    if (!isDocPipOpen || !track?.youtubeId) return;
    const pipWin = pipWindowRef.current;
    if (!pipWin || pipWin.closed) return;
    if (pipTitleRef.current) {
      pipTitleRef.current.textContent = `${track.title} — ${track.artist}`;
    }
    if (pipIframeRef.current) {
      const nextUrl = `https://www.youtube.com/embed/${encodeURIComponent(
        track.youtubeId
      )}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
      if (pipIframeRef.current.src !== nextUrl) {
        pipIframeRef.current.src = nextUrl;
      }
    }
  }, [isDocPipOpen, track?.youtubeId, track?.title, track?.artist]);

  const handleOpenPictureInPicture = async () => {
    if (!track?.youtubeId) return;
    setPipNote('');

    // If Document PiP window is already open, close and re-dock back into dashboard
    if (isDocPipOpen && pipWindowRef.current && !pipWindowRef.current.closed) {
      pipWindowRef.current.close();
      return;
    }

    // 1. Native Android APK Picture-in-Picture (floats over any other phone app)
    if (isNativeAndroidApp() && enterNativeAndroidPip()) {
      return;
    }

    // 2. Desktop / Chromium Document Picture-in-Picture API (OS-level floating window)
    const docPip = (
      window as unknown as { documentPictureInPicture?: DocumentPictureInPictureApi }
    ).documentPictureInPicture;

    if (docPip && typeof docPip.requestWindow === 'function') {
      try {
        const startSec = Math.max(0, Math.floor(audioEngine.getSnapshot().currentTime || currentTime));
        if (isPlaying) {
          void audioEngine.togglePlay();
        }
        const pipWin = await docPip.requestWindow({ width: 420, height: 276 });
        pipWindowRef.current = pipWin;
        setIsDocPipOpen(true);

        pipWin.document.documentElement.style.background = '#000000';
        pipWin.document.body.style.margin = '0';
        pipWin.document.body.style.background = '#000000';
        pipWin.document.body.style.color = '#F4F3F0';
        pipWin.document.body.style.fontFamily = 'system-ui, sans-serif';
        pipWin.document.body.style.display = 'flex';
        pipWin.document.body.style.flexDirection = 'column';
        pipWin.document.body.style.height = '100vh';

        const header = pipWin.document.createElement('div');
        header.style.cssText =
          'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#0D0E12;border-bottom:1px solid #222530;font-size:12px;font-weight:600;';
        const titleEl = pipWin.document.createElement('span');
        titleEl.textContent = `${track.title} — ${track.artist}`;
        titleEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        pipTitleRef.current = titleEl;
        header.appendChild(titleEl);
        pipWin.document.body.appendChild(header);

        const iframe = pipWin.document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(
          track.youtubeId
        )}?autoplay=1&start=${startSec}&playsinline=1&rel=0&modestbranding=1`;
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.style.cssText = 'width:100%;flex:1;border:0;background:#000;';
        pipIframeRef.current = iframe;
        pipWin.document.body.appendChild(iframe);

        pipWin.addEventListener('pagehide', () => {
          pipWindowRef.current = null;
          pipIframeRef.current = null;
          pipTitleRef.current = null;
          setIsDocPipOpen(false);
          if (!audioEngine.getSnapshot().isPlaying) {
            void audioEngine.togglePlay();
          }
        });
        return;
      } catch {
        pipWindowRef.current = null;
        pipIframeRef.current = null;
        pipTitleRef.current = null;
        setIsDocPipOpen(false);
      }
    }

    // 3. In-app floating mini-video fallback (continues across tabs inside kaGO.PIaY)
    if (onToggleInAppPip) {
      onToggleInAppPip();
      setPipNote(
        isInAppPip
          ? ''
          : 'Floating Picture-in-Picture docked. Install the Android APK for system-wide PiP over other apps.'
      );
    } else {
      setPipNote('System Picture-in-Picture activates automatically in the Android APK.');
    }
  };

  if (!track || !hasYouTubeVideo) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-[#1E2028] bg-[#06070A] px-5 py-10 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[#282B36] bg-[#12141C]">
          {track ? (
            <Disc3 className="h-7 w-7 text-[#E11D48]" />
          ) : (
            <Video className="h-7 w-7 text-[#8E929B]" />
          )}
        </div>
        <h3 className="mt-4 font-display text-base font-bold text-[#F4F3F0]">
          {track ? 'Audio-Only Engine Active' : 'No YouTube Stream Loaded'}
        </h3>
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-[#8E929B]">
          {track
            ? `"${track.title}" is running on the ${
                track.source === 'synth' ? 'Built-In Synth Engine' : 'Local Audio Engine'
              }. Search and play any song from the Stream tab to watch its video or pop out Picture-in-Picture.`
            : 'Search and play a song in the Stream tab to watch its video here while keeping continuous background playback.'}
        </p>
        {onOpenStream && (
          <button
            type="button"
            onClick={onOpenStream}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors cursor-pointer"
          >
            <Radio className="h-3.5 w-3.5" />
            <span>Browse YouTube Streams</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#E11D48] shadow-[0_0_8px_#E11D48]" />
          <span className="truncate font-mono-tabular text-xs font-semibold text-[#D1D5DB]">
            {isDocPipOpen
              ? 'PLAYING IN FLOATING WINDOW'
              : isInAppPip
              ? 'IN-APP FLOATING PiP'
              : 'YOUTUBE VIDEO STREAM'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            aria-pressed={isInAppPip || isDocPipOpen}
            onClick={() => void handleOpenPictureInPicture()}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              isInAppPip || isDocPipOpen
                ? 'border-[#E11D48] bg-[#E11D48] text-white'
                : 'border-[#2A2D39] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48]'
            }`}
          >
            <PictureInPicture2 className="h-3.5 w-3.5" />
            <span>
              {isDocPipOpen ? 'Exit PiP' : isInAppPip ? 'Dock Video' : 'Picture-in-Picture'}
            </span>
          </button>

          <a
            href={`https://www.youtube.com/watch?v=${encodeURIComponent(track.youtubeId!)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open source video on YouTube"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#2A2D39] bg-[#14161D] text-[#8E929B] hover:border-[#E11D48] hover:text-white transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* 16:9 Dock Target where #kago-yt-host aligns without reloading iframe */}
      <div
        ref={hostRef}
        data-testid="watch-video-viewport"
        className={`relative w-full overflow-hidden rounded-xl border border-[#252834] bg-black ${
          compact ? 'aspect-video max-h-[280px]' : 'aspect-video'
        }`}
      >
        {(isInAppPip || isDocPipOpen) && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#07080B] p-4 text-center">
            <PictureInPicture2 className="h-7 w-7 text-[#E11D48]" />
            <p className="text-xs font-medium text-[#D1D5DB]">
              {isDocPipOpen
                ? 'Video is active in your floating Picture-in-Picture window.'
                : 'Video is floating in the corner mini-window.'}
            </p>
          </div>
        )}
      </div>

      {pipNote && (
        <p className="font-mono-tabular text-[11px] text-[#8E929B]">{pipNote}</p>
      )}
    </div>
  );
};

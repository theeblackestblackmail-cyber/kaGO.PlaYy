import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock,
  Edit3,
  Eye,
  FileText,
  Minus,
  Plus,
  RotateCcw,
  Save,
  Upload,
} from 'lucide-react';
import type { AudioEngineSnapshot, StoredLyrics, Track } from '../types/audio';
import {
  findActiveLyricIndex,
  formatDuration,
  formatLrcTimestamp,
  parseLrc,
} from '../utils/lrcParser';

interface SyncLyricsViewProps {
  tracks: Track[];
  engine: AudioEngineSnapshot;
  lyricsMap: Record<string, StoredLyrics>;
  onSaveLyrics: (entry: StoredLyrics) => Promise<void>;
  onSeek: (seconds: number) => void;
  onPlayTrack: (track: Track) => void;
}

export const SyncLyricsView: React.FC<SyncLyricsViewProps> = ({
  tracks,
  engine,
  lyricsMap,
  onSaveLyrics,
  onSeek,
  onPlayTrack,
}) => {
  const [selectedTrackId, setSelectedTrackId] = useState<string>(
    engine.currentTrack?.id || tracks[0]?.id || ''
  );
  const [isEditMode, setIsEditMode] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [offsetSeconds, setOffsetSeconds] = useState(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [saveBanner, setSaveBanner] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeLineRef = useRef<HTMLButtonElement | null>(null);

  const activeTrack = useMemo(
    () => tracks.find((t) => t.id === selectedTrackId) || engine.currentTrack || tracks[0] || null,
    [tracks, selectedTrackId, engine.currentTrack]
  );

  // Sync selected track with active playing track when engine changes track
  useEffect(() => {
    if (engine.currentTrack?.id) {
      setSelectedTrackId(engine.currentTrack.id);
    }
  }, [engine.currentTrack?.id]);

  // Hydrate editor draft and offset whenever selected track or stored map changes
  useEffect(() => {
    if (!activeTrack) return;
    const stored = lyricsMap[activeTrack.id];
    setDraftText(stored?.rawLrc ?? activeTrack.lrcLyrics ?? '');
    setOffsetSeconds(stored?.offsetSeconds ?? 0);
  }, [activeTrack?.id, lyricsMap]);

  const parsedLines = useMemo(() => parseLrc(draftText), [draftText]);
  const effectiveTime =
    engine.currentTrack?.id === activeTrack?.id ? engine.currentTime : 0;

  const activeIdx = useMemo(
    () => findActiveLyricIndex(parsedLines, effectiveTime, offsetSeconds),
    [parsedLines, effectiveTime, offsetSeconds]
  );

  useEffect(() => {
    if (!isEditMode && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIdx, isEditMode]);

  const handleImportFile = async (file: File) => {
    const text = await file.text();
    setDraftText(text);
    if (activeTrack) {
      await onSaveLyrics({
        trackId: activeTrack.id,
        rawLrc: text,
        offsetSeconds,
        updatedAt: Date.now(),
      });
      setSaveBanner(`Imported "${file.name}" and saved to IndexedDB.`);
      setTimeout(() => setSaveBanner(''), 3000);
    }
  };

  const handleInsertTimestamp = () => {
    const stamp = formatLrcTimestamp(engine.currentTime);
    const el = textareaRef.current;
    if (!el) {
      setDraftText((prev) => `${prev}${prev.endsWith('\n') || !prev ? '' : '\n'}${stamp} `);
      return;
    }
    const start = el.selectionStart ?? draftText.length;
    const end = el.selectionEnd ?? draftText.length;
    const next = `${draftText.slice(0, start)}${stamp} ${draftText.slice(end)}`;
    setDraftText(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + stamp.length + 1;
      el.setSelectionRange(caret, caret);
    });
  };

  const handleSaveToDb = async () => {
    if (!activeTrack) return;
    await onSaveLyrics({
      trackId: activeTrack.id,
      rawLrc: draftText,
      offsetSeconds,
      updatedAt: Date.now(),
    });
    setSaveBanner(`Saved synced lyrics for "${activeTrack.title}" to offline DB.`);
    setTimeout(() => setSaveBanner(''), 3000);
  };

  const handleOffsetChange = async (nextOffset: number) => {
    const clamped = Math.max(-2, Math.min(2, Number(nextOffset.toFixed(1))));
    setOffsetSeconds(clamped);
    if (activeTrack) {
      await onSaveLyrics({
        trackId: activeTrack.id,
        rawLrc: draftText,
        offsetSeconds: clamped,
        updatedAt: Date.now(),
      });
    }
  };

  const handleLineJump = async (time: number) => {
    if (!activeTrack) return;
    if (engine.currentTrack?.id !== activeTrack.id) {
      onPlayTrack(activeTrack);
      setTimeout(() => onSeek(time), 120);
    } else {
      onSeek(time);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#F4F3F0]">Sync Lyrics Studio</h1>
            <p className="mt-1 text-xs text-[#8E929B]">
              Drop or import .lrc files, calibrate sync timing in 0.1s steps, click any line to seek, or author timestamps live
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <select
              value={activeTrack?.id || ''}
              onChange={(e) => setSelectedTrackId(e.target.value)}
              aria-label="Select track for synced lyrics"
              className="rounded-lg border border-[#262936] bg-[#07080B] px-3 py-2 text-xs text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none max-w-[220px]"
            >
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} — {t.artist}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-3.5 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5 text-[#E11D48]" />
              <span>Import LRC</span>
            </button>

            <button
              type="button"
              onClick={() => setIsEditMode((prev) => !prev)}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                isEditMode
                  ? 'bg-[#E11D48] text-white'
                  : 'border border-[#282B36] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48]'
              }`}
            >
              {isEditMode ? (
                <>
                  <Eye className="h-3.5 w-3.5" />
                  <span>Live View</span>
                </>
              ) : (
                <>
                  <Edit3 className="h-3.5 w-3.5 text-[#E11D48]" />
                  <span>Edit Lyrics</span>
                </>
              )}
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".lrc,.txt,text/plain"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await handleImportFile(file);
            e.target.value = '';
          }}
          className="hidden"
        />

        {/* Timing Calibration Offset Tool */}
        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-[#1E2028] bg-[#07080B] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-semibold text-[#F4F3F0]">Timing Calibration Offset</div>
            <div className="font-mono-tabular text-xs text-[#8E929B]">
              Range -2.0s to +2.0s (0.1s steps) · Clock {formatDuration(effectiveTime)}
            </div>
          </div>

          <div className="flex flex-1 max-w-md items-center gap-2.5">
            <button
              type="button"
              aria-label="Shift lyrics minus 0.1 seconds"
              onClick={() => handleOffsetChange(offsetSeconds - 0.1)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#2A2D39] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>

            <input
              type="range"
              min={-2}
              max={2}
              step={0.1}
              value={offsetSeconds}
              aria-label="Lyric timing calibration slider"
              onChange={(e) => handleOffsetChange(Number(e.target.value))}
              className="hardware-slider w-full"
            />

            <button
              type="button"
              aria-label="Shift lyrics plus 0.1 seconds"
              onClick={() => handleOffsetChange(offsetSeconds + 0.1)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#2A2D39] bg-[#14161D] text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>

            <span
              data-testid="lyrics-offset-readout"
              className="w-14 shrink-0 text-right font-mono-tabular text-xs font-bold text-[#FF4D6D]"
            >
              {offsetSeconds >= 0 ? `+${offsetSeconds.toFixed(1)}s` : `${offsetSeconds.toFixed(1)}s`}
            </span>

            <button
              type="button"
              onClick={() => handleOffsetChange(0)}
              className="inline-flex items-center gap-1 rounded-md border border-[#2A2D39] bg-[#14161D] px-2.5 py-1.5 font-mono-tabular text-xs text-[#8E929B] hover:text-white cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              <span>0.0s</span>
            </button>
          </div>
        </div>

        {saveBanner && (
          <p className="mt-3 font-mono-tabular text-xs text-[#FF4D6D]">{saveBanner}</p>
        )}
      </section>

      {/* Main Lyrics Canvas or Editor */}
      {isEditMode ? (
        <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[#C7C9D1]">
              LRC Monospace Editor — {activeTrack?.title || 'No Track'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleInsertTimestamp}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 font-mono-tabular text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] cursor-pointer"
              >
                <Clock className="h-3.5 w-3.5 text-[#E11D48]" />
                <span>Insert Timestamp ({formatLrcTimestamp(engine.currentTime)})</span>
              </button>

              <button
                type="button"
                onClick={handleSaveToDb}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
              >
                <Save className="h-3.5 w-3.5" />
                <span>Save to DB</span>
              </button>
            </div>
          </div>

          <textarea
            ref={textareaRef}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={14}
            aria-label="LRC lyric text editor"
            placeholder="[00:12.00] Enter synced lyrics here..."
            className="w-full rounded-xl border border-[#242732] bg-[#06070A] p-4 font-mono-tabular text-sm leading-relaxed text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none"
          />
        </section>
      ) : (
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingOver(true);
          }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) await handleImportFile(file);
          }}
          className={`min-h-[380px] rounded-xl border p-6 sm:p-10 transition-colors ${
            isDraggingOver
              ? 'border-[#E11D48] bg-[#19090E]'
              : 'border-[#1F2129] bg-[#0D0E12]'
          }`}
        >
          {parsedLines.length > 0 ? (
            <div className="mx-auto max-w-2xl space-y-3 text-center max-h-[460px] overflow-y-auto py-8">
              {parsedLines.map((line, idx) => {
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={`${line.time}-${idx}`}
                    ref={isActive ? activeLineRef : undefined}
                    type="button"
                    onClick={() => handleLineJump(line.time)}
                    className={`block w-full rounded-lg px-4 py-2 transition-all cursor-pointer ${
                      isActive
                        ? 'scale-[1.04] text-xl sm:text-2xl font-bold text-[#FF3B5C] drop-shadow-[0_0_16px_rgba(225,29,72,0.78)]'
                        : 'text-base sm:text-lg text-[#737885] hover:text-[#E5E7EB]'
                    }`}
                  >
                    <span className="mr-3 font-mono-tabular text-xs opacity-50">
                      {formatLrcTimestamp(line.time)}
                    </span>
                    <span>{line.text}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileText className="h-10 w-10 text-[#E11D48]" />
              <h2 className="mt-3 font-display text-lg font-bold text-[#F4F3F0]">
                Drop an .lrc File Here
              </h2>
              <p className="mt-1 max-w-md text-xs text-[#8E929B]">
                Drag and drop a synced lyric file, click Import LRC above, or switch to Edit Lyrics to timestamp lines live.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

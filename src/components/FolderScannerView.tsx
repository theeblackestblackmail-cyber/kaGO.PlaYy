import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, FileAudio, FolderSearch, Loader2, Music, Sparkles } from 'lucide-react';
import type { Track } from '../types/audio';
import { SAMPLE_FILENAMES, sanitizeFilename } from '../utils/filenameSanitizer';
import {
  buildTracksFromFilePairs,
  importFromNativeFolderPicker,
} from '../utils/folderImporter';
import { hasNativeFolderPicker } from '../utils/nativeMediaBridge';

interface FolderScannerViewProps {
  onImportTracks: (entries: Array<{ track: Track; file: File }>) => Promise<void>;
  onPickSong?: () => void;
  onBack?: () => void;
}

export const FolderScannerView: React.FC<FolderScannerViewProps> = ({
  onImportTracks,
  onPickSong,
  onBack,
}) => {
  const [isScanning, setIsScanning] = useState(false);
  const [scanStats, setScanStats] = useState<{
    scanned: number;
    found: number;
    currentFile: string;
    lastImported: Track[];
    error: string;
  }>({
    scanned: 0,
    found: 0,
    currentFile: '',
    lastImported: [],
    error: '',
  });

  const [testInput, setTestInput] = useState<string>(SAMPLE_FILENAMES[0].value);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);

  const sanitizedPreview = useMemo(() => sanitizeFilename(testInput), [testInput]);

  const processFiles = async (filePairs: Array<{ file: File; folderPath: string }>) => {
    setIsScanning(true);
    setScanStats({
      scanned: 0,
      found: 0,
      currentFile: 'Inspecting headers...',
      lastImported: [],
      error: '',
    });

    const importedEntries = await buildTracksFromFilePairs(filePairs, (progress) => {
      setScanStats((prev) => ({
        ...prev,
        scanned: progress.scanned,
        found: progress.found,
        currentFile: progress.currentFile,
      }));
    });

    if (importedEntries.length > 0) {
      await onImportTracks(importedEntries);
    }

    setScanStats({
      scanned: filePairs.length,
      found: importedEntries.length,
      currentFile: importedEntries.length > 0 ? 'Scan complete' : 'No supported audio files found',
      lastImported: importedEntries.map((e) => e.track),
      error:
        importedEntries.length === 0
          ? 'No audio files (.mp3, .flac, .wav, .m4a, .ogg) were found in that selection.'
          : '',
    });
    setIsScanning(false);
  };

  const handleSelectDirectory = async () => {
    if (hasNativeFolderPicker()) {
      setIsScanning(true);
      setScanStats({
        scanned: 0,
        found: 0,
        currentFile: 'Opening Android folder picker...',
        lastImported: [],
        error: '',
      });

      const result = await importFromNativeFolderPicker((progress) => {
        setScanStats((prev) => ({
          ...prev,
          scanned: progress.scanned,
          found: progress.found,
          currentFile: progress.currentFile,
        }));
      });

      if (result.cancelled) {
        setIsScanning(false);
        setScanStats((prev) => ({ ...prev, currentFile: 'Folder selection cancelled' }));
        return;
      }

      if (result.error) {
        setIsScanning(false);
        setScanStats((prev) => ({
          ...prev,
          currentFile: 'Scan failed',
          error: result.error || 'Unable to scan folder.',
        }));
        return;
      }

      if (result.entries.length > 0) {
        await onImportTracks(result.entries);
      }

      setScanStats({
        scanned: result.entries.length,
        found: result.entries.length,
        currentFile:
          result.entries.length > 0 ? 'Folder scan complete' : 'No supported audio files found',
        lastImported: result.entries.map((e) => e.track),
        error:
          result.entries.length === 0
            ? 'No audio files (.mp3, .flac, .wav, .m4a, .ogg) were found inside that folder.'
            : '',
      });
      setIsScanning(false);
      return;
    }

    const picker = (
      window as unknown as {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;

    if (typeof picker !== 'function') {
      folderInputRef.current?.click();
      return;
    }

    try {
      const rootHandle = await picker();
      setIsScanning(true);
      const collected: Array<{ file: File; folderPath: string }> = [];

      const walk = async (dirHandle: FileSystemDirectoryHandle, prefix: string) => {
        const entries = (
          dirHandle as unknown as {
            values: () => AsyncIterable<FileSystemHandle>;
          }
        ).values();

        for await (const entry of entries) {
          if (entry.kind === 'file') {
            const fileHandle = entry as FileSystemFileHandle;
            const file = await fileHandle.getFile();
            collected.push({ file, folderPath: prefix || rootHandle.name });
            setScanStats((prev) => ({
              ...prev,
              scanned: collected.length,
              currentFile: file.name,
            }));
          } else if (entry.kind === 'directory') {
            await walk(entry as FileSystemDirectoryHandle, `${prefix}/${entry.name}`);
          }
        }
      };

      await walk(rootHandle, rootHandle.name);
      await processFiles(collected);
    } catch (err) {
      setIsScanning(false);
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Fallback to webkitdirectory input if File System Access API is blocked in iframe
      folderInputRef.current?.click();
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const pairs = files.map((file) => {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      const folderPath = rel ? rel.split('/').slice(0, -1).join('/') : 'Picked Songs';
      return { file, folderPath };
    });
    await processFiles(pairs);
    e.target.value = '';
  };

  return (
    <div className="space-y-6">
      {/* Directory Scanner Card */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5 sm:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-[#282B36] bg-[#14161D] px-3 py-1.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5 text-[#E11D48]" />
                <span>Back</span>
              </button>
            )}
            <h1 className="font-display text-2xl font-bold text-[#F4F3F0]">
              Recursive Folder &amp; Song Picker
            </h1>
            <p className="mt-1 text-xs text-[#8E929B]">
              Pick an entire music folder (including subfolders) or pick individual songs — extracts ID3v2 / ID3v1 / FLAC tags automatically.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleSelectDirectory}
              disabled={isScanning}
              className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_18px_rgba(225,29,72,0.45)] hover:bg-[#BE123C] disabled:opacity-60 transition-colors cursor-pointer"
            >
              {isScanning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderSearch className="h-4 w-4" />
              )}
              <span>Pick Music Folder</span>
            </button>

            <button
              type="button"
              onClick={() => (onPickSong ? onPickSong() : filesInputRef.current?.click())}
              disabled={isScanning}
              className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#14161D] px-4 py-2.5 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] transition-colors cursor-pointer"
            >
              <Music className="h-4 w-4 text-[#E11D48]" />
              <span>Pick Song(s)</span>
            </button>
          </div>
        </div>

        {/* Hidden Fallback Inputs */}
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is standard in Chromium/WebKit
          webkitdirectory="true"
          accept="audio/*"
          onChange={handleFileInputChange}
          className="hidden"
        />
        <input
          ref={filesInputRef}
          type="file"
          multiple
          accept="audio/*"
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* Live Scan Progress Telemetry */}
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl border border-[#1E2028] bg-[#07080B] p-4">
          <div>
            <div className="text-xs text-[#8E929B]">Files Scanned</div>
            <div className="mt-1 font-mono-tabular text-lg font-bold text-[#F4F3F0]">
              {scanStats.scanned}
            </div>
          </div>
          <div>
            <div className="text-xs text-[#8E929B]">Audio Tracks Imported</div>
            <div className="mt-1 font-mono-tabular text-lg font-bold text-[#FF4D6D]">
              {scanStats.found}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-[#8E929B]">Scanner Status</div>
            <div className="mt-1 truncate font-mono-tabular text-sm font-medium text-[#D1D5DB]">
              {scanStats.currentFile || 'Idle — ready to scan'}
            </div>
          </div>
        </div>

        {scanStats.error && (
          <p className="mt-3 rounded-lg border border-[#E11D48]/40 bg-[#180A0F] px-3.5 py-2 text-xs text-[#FDA4AF]">
            {scanStats.error}
          </p>
        )}

        {scanStats.lastImported.length > 0 && (
          <div className="mt-4 rounded-xl border border-[#1E2028] bg-[#090A0E] p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#F4F3F0]">
              <CheckCircle2 className="h-4 w-4 text-[#E11D48]" />
              <span>Recently Imported &amp; Tagged ({scanStats.lastImported.length})</span>
            </div>
            <div className="max-h-40 space-y-1.5 overflow-y-auto text-xs">
              {scanStats.lastImported.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded border border-[#1B1D26] bg-[#111319] px-3 py-1.5"
                >
                  <span className="truncate font-medium text-[#F4F3F0]">
                    {t.artist} — {t.title}
                  </span>
                  <span className="shrink-0 font-mono-tabular text-[#8E929B]">{t.album}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Live Filename Sanitizer Test Bench */}
      <section className="rounded-xl border border-[#1F2129] bg-[#0D0E12] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-bold text-[#F4F3F0]">
              Live Filename Sanitizer Test Bench
            </h2>
            <p className="text-xs text-[#8E929B]">
              Strips Official Video, HQ, 4K, Lyrics, track numbers, underscores, and corrupted characters in real time
            </p>
          </div>
          <Sparkles className="h-4 w-4 text-[#E11D48]" />
        </div>

        {/* 4 Sample Buttons */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[#8E929B]">Samples:</span>
          {SAMPLE_FILENAMES.map((sample) => (
            <button
              key={sample.label}
              type="button"
              onClick={() => setTestInput(sample.value)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                testInput === sample.value
                  ? 'border-[#E11D48] bg-[#E11D48]/15 text-[#FF4D6D]'
                  : 'border-[#252834] bg-[#14161D] text-[#D1D5DB] hover:border-[#E11D48]'
              }`}
            >
              {sample.label}
            </button>
          ))}
        </div>

        {/* Raw Filename Input */}
        <div className="mt-4">
          <label
            htmlFor="sanitizer-input"
            className="block text-xs font-semibold text-[#C7C9D1]"
          >
            Raw Messy Audio Filename
          </label>
          <div className="relative mt-1.5">
            <FileAudio className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8E929B]" />
            <input
              id="sanitizer-input"
              type="text"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder="Paste any messy filename..."
              className="w-full rounded-lg border border-[#262936] bg-[#07080B] py-2.5 pl-10 pr-4 font-mono-tabular text-xs sm:text-sm text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none"
            />
          </div>
        </div>

        {/* Cleaned Display Name */}
        <div className="mt-4 rounded-lg border border-[#E11D48]/40 bg-[#15090E] p-3.5">
          <div className="text-xs text-[#8E929B]">Cleaned Display Name</div>
          <div
            data-testid="sanitized-display-name"
            className="mt-1 font-display text-lg font-bold text-[#F4F3F0]"
          >
            {sanitizedPreview.displayName || '—'}
          </div>
        </div>

        {/* Three Output Boxes */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border border-[#1E2028] bg-[#07080B] p-3.5">
            <div className="text-xs text-[#8E929B]">Parsed Title</div>
            <div
              data-testid="parsed-title"
              className="mt-1 font-semibold text-sm text-[#FF4D6D] truncate"
            >
              {sanitizedPreview.title}
            </div>
          </div>

          <div className="rounded-lg border border-[#1E2028] bg-[#07080B] p-3.5">
            <div className="text-xs text-[#8E929B]">Parsed Artist</div>
            <div
              data-testid="parsed-artist"
              className="mt-1 font-semibold text-sm text-[#F4F3F0] truncate"
            >
              {sanitizedPreview.artist}
            </div>
          </div>

          <div className="rounded-lg border border-[#1E2028] bg-[#07080B] p-3.5">
            <div className="text-xs text-[#8E929B]">Parsed Album</div>
            <div
              data-testid="parsed-album"
              className="mt-1 font-semibold text-sm text-[#F4F3F0] truncate"
            >
              {sanitizedPreview.album}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

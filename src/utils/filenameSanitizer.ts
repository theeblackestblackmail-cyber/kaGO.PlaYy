export interface SanitizedFilenameResult {
  displayName: string;
  title: string;
  artist: string;
  album: string;
}

export const SAMPLE_FILENAMES: Array<{ label: string; value: string }> = [
  {
    label: 'YouTube Rip',
    value: '04 - Daft_Punk_-_Derezzed_(Official_Video)_[4K_HQ_320kbps].mp3',
  },
  {
    label: 'Lyric Video',
    value: '01. Burna Boy - Last Last (Official Audio) [Lyrics HD].flac',
  },
  {
    label: 'Underscore Mess',
    value: '07_kavinsky_-_nightcall_(drive_ost)_[official_music_video].m4a',
  },
  {
    label: 'Nested Album',
    value: 'TRN09_Carpenter_Brut_-_Turbo_Killer_[Trilogy_Album]_(HQ_Audio).wav',
  },
];

const AUDIO_EXT_RE = /\.(mp3|flac|wav|ogg|m4a|aac|opus|webm|aiff|wma)$/i;

const NOISE_PHRASES_RE =
  /\b(official\s*music\s*video|official\s*video|official\s*audio|official\s*visualizer|lyric\s*video|lyrics|music\s*video|visualizer|audio\s*only|hd\s*remaster|remastered|hq\s*audio|hq|hd|4k|8k|320kbps|256kbps|192kbps|128kbps|explicit|clean\s*version|free\s*download|prod\.?\s*by\s*[^)\]]+)\b/gi;

export function sanitizeFilename(rawInput: string, fallbackFolderAlbum = 'Local Import'): SanitizedFilenameResult {
  if (!rawInput || !rawInput.trim()) {
    return {
      displayName: '',
      title: 'Untitled Track',
      artist: 'Unknown Artist',
      album: fallbackFolderAlbum,
    };
  }

  let cleaned = rawInput
    // Extract just filename if a path is pasted
    .split(/[/\\]/)
    .pop() || rawInput;

  // Strip extension
  cleaned = cleaned.replace(AUDIO_EXT_RE, '');

  // Remove replacement chars and control characters
  cleaned = cleaned.replace(/[\uFFFD\u0000-\u001F\u007F]/g, '');

  // Convert underscores to spaces
  cleaned = cleaned.replace(/_/g, ' ');

  // Remove leading track number prefixes like "01 - ", "04.", "TRN09 ", "[02] "
  cleaned = cleaned.replace(/^\s*(?:TRN\d{1,3}|\[?\d{1,3}\]?)\s*(?:[-–—.)\]\s]+)\s*/i, '');

  // Check if there's an explicit album hint in brackets/parens like (Drive OST) or [Trilogy Album]
  let detectedAlbum = '';
  const bracketMatches = cleaned.match(/[\[(]([^\])]+)[\])]/g) || [];
  for (const segment of bracketMatches) {
    const inner = segment.slice(1, -1).trim();
    const strippedNoise = inner.replace(NOISE_PHRASES_RE, '').trim();
    if (strippedNoise.length >= 2 && /\b(ost|album|ep|lp|edition|soundtrack|deluxe|sessions)\b/i.test(strippedNoise)) {
      detectedAlbum = strippedNoise.replace(/\s+/g, ' ').trim();
    }
  }

  // Strip noise inside brackets/parentheses, and drop brackets that become empty or noise-only
  cleaned = cleaned.replace(/[\[(]([^\])]+)[\])]/g, (_match, inner: string) => {
    const remaining = inner
      .replace(NOISE_PHRASES_RE, '')
      .replace(/[-–—,|/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!remaining || remaining.length < 2) {
      return ' ';
    }
    // If it was detected as album metadata, keep it out of title
    if (detectedAlbum && remaining.toLowerCase() === detectedAlbum.toLowerCase()) {
      return ' ';
    }
    // Keep meaningful musical qualifiers like (Remix), (Live), (Feat. X)
    return ` (${remaining}) `;
  });

  // Strip unbracketed trailing noise tags
  cleaned = cleaned.replace(NOISE_PHRASES_RE, ' ');

  // Normalize dashes and whitespace
  cleaned = cleaned
    .replace(/\s*[-–—]{2,}\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
    .trim();

  // Separate Artist - Title (or Artist - Album - Title)
  const parts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);

  let artist = 'Unknown Artist';
  let title = cleaned || 'Untitled Track';
  let album = detectedAlbum || fallbackFolderAlbum;

  if (parts.length === 2) {
    artist = parts[0];
    title = parts[1];
  } else if (parts.length >= 3) {
    artist = parts[0];
    if (!detectedAlbum) {
      album = parts[1];
      title = parts.slice(2).join(' - ');
    } else {
      title = parts.slice(1).join(' - ');
    }
  }

  const displayName = artist !== 'Unknown Artist' ? `${artist} - ${title}` : title;

  return {
    displayName,
    title,
    artist,
    album,
  };
}

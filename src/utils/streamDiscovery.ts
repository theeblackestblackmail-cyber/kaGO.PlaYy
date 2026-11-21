import type { Track } from '../types/audio';

export const DYNAMIC_POPULAR_POOL: readonly string[] = [
  'Sabrina Carpenter Espresso',
  'Tems Love Me JeJe',
  'The Weeknd Timeless',
  'Kendrick Lamar Luther',
  'SZA Kill Bill',
  'Burna Boy City Boys',
  'Wizkid Essence',
  'Billie Eilish Birds of a Feather',
  'Rema Ozeba',
  'Tyla Push 2 Start',
  'Asake Lonely At The Top',
  'Bruno Mars Die With A Smile',
  'Ayra Starr Commas',
  'Travis Scott FE!N',
  'Arctic Monkeys Do I Wanna Know',
  'Dua Lipa Houdini',
  'Davido Unavailable',
  'Frank Ocean Pink + White',
  'Chappell Roan Good Luck Babe',
  'Central Cee Sprinter',
  'Benson Boone Beautiful Things',
  'Kanye West Flashing Lights',
  'Coldplay Viva La Vida',
  'Omah Lay Soso',
  'Teddy Swims Lose Control',
  'Tame Impala The Less I Know The Better',
  'Post Malone Circles',
  'Future Like That',
  'Victony Soweto',
  'Drake Rich Baby Daddy',
];

export const DISCOVERY_FEED_QUERIES: readonly string[] = [
  'top global music hits official audio',
  'afrobeats trending hits official music video',
  'r&b soul favorites official audio',
  'hip hop chart hits official video',
  'pop essentials official music video',
  'amapiano dance hits official audio',
  'indie alt rock hits official video',
  'electronic dance hits official audio',
  'world music chart hits official music video',
  'late night chill r&b official audio',
];

export const GENRE_DISCOVERY_SEEDS: Record<string, readonly string[]> = {
  Afrobeats: [
    'Burna Boy City Boys',
    'Wizkid Essence',
    'Tems Love Me JeJe',
    'Rema Ozeba',
    'Asake Lonely At The Top',
    'Ayra Starr Commas',
    'Davido Unavailable',
    'Omah Lay Soso',
    'Victony Soweto',
  ],
  'Hip-Hop': [
    'Kendrick Lamar Luther',
    'Travis Scott FE!N',
    'Future Like That',
    'Central Cee Sprinter',
    'Kanye West Flashing Lights',
    'Drake Rich Baby Daddy',
  ],
  Pop: [
    'Sabrina Carpenter Espresso',
    'Billie Eilish Birds of a Feather',
    'Bruno Mars Die With A Smile',
    'Dua Lipa Houdini',
    'Chappell Roan Good Luck Babe',
    'Benson Boone Beautiful Things',
  ],
  'R&B': [
    'SZA Kill Bill',
    'The Weeknd Timeless',
    'Frank Ocean Pink + White',
    'Tyla Push 2 Start',
    'Teddy Swims Lose Control',
  ],
  Rock: [
    'Arctic Monkeys Do I Wanna Know',
    'Coldplay Viva La Vida',
    'Tame Impala The Less I Know The Better',
    'Fleetwood Mac Dreams',
    'Linkin Park Numb',
    'Radiohead Creep',
  ],
  'Lo-Fi': [
    'Nujabes Feather',
    'J Dilla Donuts Workinonit',
    'Lofi Girl Beats Chill Study',
    'Kina Get You The Moon',
    'Joji Slow Dancing in the Dark',
    'potsu just friends',
  ],
  Synthwave: [
    'Kavinsky Nightcall',
    'The Midnight Sunset',
    'M83 Midnight City',
    'Timecop1983 On the Run',
    'Gunship Tech Noir',
    'Carpenter Brut Turbo Killer',
  ],
  EDM: [
    'Fred again Delilah',
    'Calvin Harris Summer',
    'Avicii Levels',
    'Daft Punk One More Time',
    'Disclosure Latch',
    'RÜFÜS DU SOL Innerbloom',
  ],
};

function createSeededRng(seed: number): () => number {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const arr = [...items];
  const rand = createSeededRng(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function readDiscoveryHistory(key: string): string[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter((x): x is string => typeof x === 'string');
        }
      }
    }
  } catch {
    // Fallback to sessionStorage
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter((x): x is string => typeof x === 'string');
        }
      }
    }
  } catch {
    // Ignore storage errors
  }
  return [];
}

export function writeDiscoveryHistory(key: string, values: readonly string[]): void {
  const serialized = JSON.stringify(values);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, serialized);
    }
  } catch {
    // Ignore storage quota errors
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, serialized);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function readDiscoveryText(key: string): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const val = localStorage.getItem(key);
      if (val) return val;
    }
  } catch {
    // Fallback
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage.getItem(key) || '';
    }
  } catch {
    // Ignore
  }
  return '';
}

export function writeDiscoveryText(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, value);
    }
  } catch {
    // Ignore
  }
}

export function nextDiscoveryVisitSeed(storageKey = 'kago_discovery_visit_seed'): number {
  const entropy = Date.now() ^ Math.floor(Math.random() * 0x7fffffff);
  try {
    if (typeof localStorage !== 'undefined') {
      const prev = Number(localStorage.getItem(storageKey) || '0');
      const next = (Number.isFinite(prev) ? prev : 0) + 1;
      localStorage.setItem(storageKey, String(next));
      return (entropy ^ Math.imul(next, 2654435761)) >>> 0;
    }
  } catch {
    // Fallback to sessionStorage
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      const prev = Number(sessionStorage.getItem(storageKey) || '0');
      const next = (Number.isFinite(prev) ? prev : 0) + 1;
      sessionStorage.setItem(storageKey, String(next));
      return (entropy ^ Math.imul(next, 2654435761)) >>> 0;
    }
  } catch {
    // Ignore restricted storage contexts
  }
  return entropy >>> 0;
}

export function pickDynamicPopularSearches(
  count = 5,
  seed = Date.now(),
  excludeTerms: readonly string[] = []
): string[] {
  const excludeSet = new Set(excludeTerms.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const freshPool = DYNAMIC_POPULAR_POOL.filter((t) => !excludeSet.has(t.toLowerCase()));
  const primaryPool = freshPool.length >= count ? freshPool : DYNAMIC_POPULAR_POOL;
  return shuffleWithSeed(primaryPool, seed).slice(0, Math.max(1, count));
}

export function pickDiscoveryFeedQuery(
  seed = Date.now(),
  previousQuery?: string
): string {
  const prevLower = previousQuery?.trim().toLowerCase();
  const candidates = prevLower
    ? DISCOVERY_FEED_QUERIES.filter((q) => q.toLowerCase() !== prevLower)
    : DISCOVERY_FEED_QUERIES;
  const pool = candidates.length > 0 ? candidates : DISCOVERY_FEED_QUERIES;
  const shuffled = shuffleWithSeed(pool, seed);
  return shuffled[0] || DISCOVERY_FEED_QUERIES[0];
}

export function pickDiverseDiscoverySeeds(
  count = 6,
  seed = Date.now(),
  excludeSeeds: readonly string[] = [],
  genreFilter = ''
): string[] {
  const genrePool =
    genreFilter && GENRE_DISCOVERY_SEEDS[genreFilter]
      ? GENRE_DISCOVERY_SEEDS[genreFilter]
      : DYNAMIC_POPULAR_POOL;
  const excludeSet = new Set(excludeSeeds.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const fresh = genrePool.filter((item) => !excludeSet.has(item.toLowerCase()));
  const pool = fresh.length >= count ? fresh : genrePool;
  return shuffleWithSeed(pool, seed).slice(0, Math.min(pool.length, Math.max(1, count)));
}

export function normalizeDiscoveryTitle(rawTitle: string): string {
  return rawTitle
    .toLowerCase()
    // Remove bracketed/parenthetical version & video noise (Official Video, Visualizer, Acoustic, Lyric Video, etc.)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(
      /\((?:[^)]*(?:official|video|audio|lyric|lyrics|visualizer|visualiser|acoustic|live|clean|explicit|remaster|hd|4k|hq|sped\s*up|slowed|reverb|session|studio|performance|version|feat\.?|ft\.?)[^)]*)\)/gi,
      ' '
    )
    .replace(/\b(?:official\s+(?:music\s+)?video|official\s+audio|lyric\s+video|music\s+video|official\s+visualizer)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDiscoveryArtist(rawArtist: string): string {
  const primary = rawArtist
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b/i)[0] || '';
  return primary
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalSongKey(title: string, artist: string): string {
  let normTitle = normalizeDiscoveryTitle(title);
  const normArtist = normalizeDiscoveryArtist(artist);
  const compactArtist = normArtist.replace(/\s+/g, '');
  if (normArtist && normTitle.startsWith(`${normArtist} `) && normTitle.length > normArtist.length + 2) {
    normTitle = normTitle.slice(normArtist.length + 1).trim();
  }
  if (!normTitle) return `raw::${title.trim().toLowerCase()}::${compactArtist}`;
  return `${normTitle}::${compactArtist}`;
}

export function deduplicateDiverseTracks(
  tracks: readonly Track[],
  options: {
    maxPerSong?: number;
    maxPerArtist?: number;
    maxResults?: number;
  } = {}
): Track[] {
  const maxPerSong = options.maxPerSong ?? 1;
  const maxPerArtist = options.maxPerArtist ?? 1;
  const maxResults = options.maxResults ?? 24;

  const seenTrackIds = new Set<string>();
  const seenYoutubeIds = new Set<string>();
  const songCounts = new Map<string, number>();
  const artistCounts = new Map<string, number>();
  const selected: Track[] = [];
  const deferredForArtistCap: Track[] = [];

  for (const track of tracks) {
    if (!track || !track.id) continue;
    if (seenTrackIds.has(track.id)) continue;
    if (track.youtubeId && seenYoutubeIds.has(track.youtubeId)) continue;

    const songKey = canonicalSongKey(track.title, track.artist);
    const artistKey =
      normalizeDiscoveryArtist(track.artist).replace(/\s+/g, '') ||
      track.artist.toLowerCase().trim();

    const currentSongCount = songCounts.get(songKey) ?? 0;
    if (currentSongCount >= maxPerSong) {
      continue;
    }

    const currentArtistCount = artistCounts.get(artistKey) ?? 0;
    if (currentArtistCount >= maxPerArtist) {
      deferredForArtistCap.push(track);
      continue;
    }

    seenTrackIds.add(track.id);
    if (track.youtubeId) seenYoutubeIds.add(track.youtubeId);
    songCounts.set(songKey, currentSongCount + 1);
    artistCounts.set(artistKey, currentArtistCount + 1);
    selected.push(track);

    if (selected.length >= maxResults) return selected;
  }

  // If strict maxPerArtist=1 yielded fewer than 6 distinct songs, allow extra distinct songs (still maxPerSong=1)
  if (selected.length < Math.min(6, maxResults) && deferredForArtistCap.length > 0) {
    for (const track of deferredForArtistCap) {
      if (selected.length >= maxResults) break;
      const songKey = canonicalSongKey(track.title, track.artist);
      if ((songCounts.get(songKey) ?? 0) >= maxPerSong) continue;
      seenTrackIds.add(track.id);
      if (track.youtubeId) seenYoutubeIds.add(track.youtubeId);
      songCounts.set(songKey, (songCounts.get(songKey) ?? 0) + 1);
      selected.push(track);
    }
  }

  return selected;
}

export function rotateCuratedFallbackTracks(
  tracks: readonly Track[],
  seed = Date.now()
): Track[] {
  return deduplicateDiverseTracks(shuffleWithSeed(tracks, seed), {
    maxPerSong: 1,
    maxPerArtist: tracks.length || 1,
    maxResults: tracks.length,
  });
}

export const RELATED_GENRES: Record<string, readonly string[]> = {
  Afrobeats: ['R&B', 'Hip-Hop', 'Pop'],
  'Hip-Hop': ['R&B', 'Afrobeats', 'Lo-Fi'],
  Pop: ['R&B', 'EDM', 'Synthwave'],
  'R&B': ['Afrobeats', 'Hip-Hop', 'Lo-Fi', 'Pop'],
  Rock: ['Synthwave', 'Pop', 'Lo-Fi'],
  'Lo-Fi': ['R&B', 'Hip-Hop', 'Synthwave'],
  Synthwave: ['EDM', 'Pop', 'Rock'],
  EDM: ['Synthwave', 'Pop', 'Hip-Hop'],
};

const CANONICAL_GENRE_ALIASES: Record<string, string> = {
  afrobeat: 'Afrobeats',
  afrobeats: 'Afrobeats',
  afropop: 'Afrobeats',
  amapiano: 'Afrobeats',
  'hip-hop': 'Hip-Hop',
  'hip hop': 'Hip-Hop',
  rap: 'Hip-Hop',
  trap: 'Hip-Hop',
  drill: 'Hip-Hop',
  pop: 'Pop',
  'synth-pop': 'Pop',
  'r&b': 'R&B',
  rnb: 'R&B',
  soul: 'R&B',
  'neo-soul': 'R&B',
  rock: 'Rock',
  indie: 'Rock',
  alternative: 'Rock',
  'alt-rock': 'Rock',
  'lo-fi': 'Lo-Fi',
  lofi: 'Lo-Fi',
  chillhop: 'Lo-Fi',
  chill: 'Lo-Fi',
  synthwave: 'Synthwave',
  retrowave: 'Synthwave',
  outrun: 'Synthwave',
  edm: 'EDM',
  electronic: 'EDM',
  dance: 'EDM',
  house: 'EDM',
  techno: 'EDM',
};

const GENERIC_ARTIST_NAMES = new Set([
  'unknown',
  'unknown artist',
  'youtube audio',
  'picked songs',
  'various artists',
  'kago synth engine',
  'stream',
  'topic',
  'local',
]);

const GENERIC_ALBUM_NAMES = new Set([
  'offline',
  'picked songs',
  'youtube music stream',
  'audius full stream',
  'audius radio',
  'local library',
  'folder',
  'discovery',
  'stems',
  'offline stems vol. 01',
]);

const METADATA_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'official',
  'video',
  'audio',
  'music',
  'lyric',
  'lyrics',
  'feat',
  'stream',
  'youtube',
  'track',
  'song',
  'hits',
  'mix',
]);

export interface TrackContentProfile {
  trackId: string;
  youtubeId?: string;
  cleanTitle: string;
  primaryArtist: string;
  collaborators: string[];
  cleanAlbum: string;
  resolvedGenre: string;
  relatedGenres: string[];
  tempoMood: 'chill' | 'midtempo' | 'upbeat' | '';
  keywords: string[];
  excludedSongKey: string;
}

export function resolveCanonicalGenre(
  rawGenre?: string,
  artist?: string,
  title?: string,
  bpm?: number
): string {
  const normalized = (rawGenre || '').trim().toLowerCase();
  if (normalized && CANONICAL_GENRE_ALIASES[normalized]) {
    return CANONICAL_GENRE_ALIASES[normalized];
  }
  if (normalized) {
    for (const [alias, canonical] of Object.entries(CANONICAL_GENRE_ALIASES)) {
      if (normalized.includes(alias)) return canonical;
    }
  }

  const combined = `${artist || ''} ${title || ''}`.toLowerCase();
  for (const [alias, canonical] of Object.entries(CANONICAL_GENRE_ALIASES)) {
    if (alias.length >= 3 && new RegExp(`\\b${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(combined)) {
      return canonical;
    }
  }

  // Match known artists from GENRE_DISCOVERY_SEEDS when genre metadata is missing/generic
  const cleanArtist = normalizeDiscoveryArtist(artist || '');
  if (cleanArtist && cleanArtist.length >= 3) {
    for (const [genreName, seeds] of Object.entries(GENRE_DISCOVERY_SEEDS)) {
      if (seeds.some((seed) => seed.toLowerCase().includes(cleanArtist))) {
        return genreName;
      }
    }
  }

  if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) {
    if (bpm < 90) return 'Lo-Fi';
    if (bpm >= 122) return 'EDM';
  }

  return '';
}

function extractCollaborators(title: string, artist: string, primaryArtist: string): string[] {
  const collaborators: string[] = [];
  const seen = new Set<string>([primaryArtist.toLowerCase()]);

  const pushCandidate = (raw: string) => {
    const cleaned = raw
      .replace(/\s*-\s*topic$/i, '')
      .replace(/vevo$/i, '')
      .replace(/[()[\]]/g, ' ')
      .trim();
    const key = cleaned.toLowerCase();
    if (cleaned.length >= 2 && !seen.has(key) && !GENERIC_ARTIST_NAMES.has(key)) {
      seen.add(key);
      collaborators.push(cleaned);
    }
  };

  for (const part of artist.split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b/i)) {
    pushCandidate(part);
  }

  const featMatch = title.match(/\b(?:feat\.?|ft\.?|with)\s+([^)\]]+)/i);
  if (featMatch?.[1]) {
    for (const part of featMatch[1].split(/,|&|\band\b|\bx\b/i)) {
      pushCandidate(part);
    }
  }

  return collaborators.slice(0, 3);
}

function extractContentKeywords(parts: readonly string[]): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const words = part
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !METADATA_STOPWORDS.has(w));
    for (const word of words) {
      if (!seen.has(word)) {
        seen.add(word);
        tokens.push(word);
      }
    }
  }
  return tokens.slice(0, 12);
}

export function analyzeTrackContentProfile(
  track: Track | null | undefined,
  genreOverride = ''
): TrackContentProfile | null {
  if (!track) return null;

  const cleanTitle = normalizeDiscoveryTitle(track.title || '');
  const normArtist = normalizeDiscoveryArtist(track.artist || '');
  const primaryArtist =
    normArtist && !GENERIC_ARTIST_NAMES.has(normArtist)
      ? track.artist
          .replace(/\s*-\s*topic$/i, '')
          .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b/i)[0]
          .trim()
      : '';

  const albumTrimmed = (track.album || '').trim();
  const cleanAlbum =
    albumTrimmed && !GENERIC_ALBUM_NAMES.has(albumTrimmed.toLowerCase()) ? albumTrimmed : '';

  const overrideCanonical = genreOverride.trim()
    ? resolveCanonicalGenre(genreOverride) || genreOverride.trim()
    : '';
  const resolvedGenre =
    overrideCanonical ||
    resolveCanonicalGenre(track.genre, track.artist, track.title, track.bpm);

  const relatedGenres = resolvedGenre
    ? [...(RELATED_GENRES[resolvedGenre] || [])]
    : [];

  let tempoMood: 'chill' | 'midtempo' | 'upbeat' | '' = '';
  if (typeof track.bpm === 'number' && Number.isFinite(track.bpm) && track.bpm > 0) {
    if (track.bpm < 94) tempoMood = 'chill';
    else if (track.bpm >= 119) tempoMood = 'upbeat';
    else tempoMood = 'midtempo';
  }

  const collaborators = extractCollaborators(
    track.title || '',
    track.artist || '',
    primaryArtist || normArtist
  );

  const keywords = extractContentKeywords([
    cleanTitle,
    primaryArtist,
    cleanAlbum,
    resolvedGenre,
    ...collaborators,
    track.synthProfile?.description || '',
  ]);

  return {
    trackId: track.id,
    youtubeId: track.youtubeId,
    cleanTitle,
    primaryArtist,
    collaborators,
    cleanAlbum,
    resolvedGenre,
    relatedGenres,
    tempoMood,
    keywords,
    excludedSongKey: canonicalSongKey(track.title || '', track.artist || ''),
  };
}

export function buildContentBasedQueries(
  profile: TrackContentProfile | null,
  visitSeed: number,
  excludeSeeds: readonly string[] = [],
  previousFeedQuery?: string,
  genreOverride = ''
): {
  seeds: string[];
  broadQuery: string;
} {
  const effectiveGenre = genreOverride.trim() || profile?.resolvedGenre || '';

  if (!profile) {
    const broadQuery = effectiveGenre
      ? `${effectiveGenre} top hits official music`
      : pickDiscoveryFeedQuery(visitSeed, previousFeedQuery);
    return {
      seeds: pickDiverseDiscoverySeeds(6, visitSeed, excludeSeeds, effectiveGenre),
      broadQuery,
    };
  }

  // Assemble genre + adjacent-genre seed candidates, excluding the current song and recently shown seeds
  const primaryPool = effectiveGenre
    ? GENRE_DISCOVERY_SEEDS[effectiveGenre] || []
    : [];
  const adjacentPool = (profile.relatedGenres || []).flatMap(
    (g) => GENRE_DISCOVERY_SEEDS[g] || []
  );
  const combinedPool = Array.from(
    new Set([
      ...primaryPool,
      ...adjacentPool,
      ...(primaryPool.length === 0 ? DYNAMIC_POPULAR_POOL : []),
    ])
  ).filter((seed) => {
    const seedLower = seed.toLowerCase();
    if (
      profile.cleanTitle &&
      profile.cleanTitle.length >= 4 &&
      seedLower.includes(profile.cleanTitle)
    ) {
      return false;
    }
    return true;
  });

  const excludeSet = new Set(excludeSeeds.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const fresh = combinedPool.filter((item) => !excludeSet.has(item.toLowerCase()));
  const pool = fresh.length >= 4 ? fresh : combinedPool.length > 0 ? combinedPool : [...DYNAMIC_POPULAR_POOL];
  const pickedSeeds = shuffleWithSeed(pool, visitSeed).slice(0, 4);

  // Add metadata-driven collaborator / similar-vibe queries
  const dynamicQueries: string[] = [];
  if (profile.collaborators.length > 0) {
    dynamicQueries.push(
      `${profile.collaborators[0]} ${effectiveGenre || 'official music'}`.trim()
    );
  }
  if (profile.primaryArtist) {
    dynamicQueries.push(
      `artists similar to ${profile.primaryArtist} ${effectiveGenre || ''} official audio`.replace(/\s+/g, ' ').trim()
    );
  }
  if (profile.cleanAlbum && effectiveGenre) {
    dynamicQueries.push(`${effectiveGenre} essentials ${profile.tempoMood || 'mix'}`.trim());
  }

  for (const dq of dynamicQueries) {
    if (pickedSeeds.length < 6 && !pickedSeeds.includes(dq)) {
      pickedSeeds.push(dq);
    }
  }

  // Broad multi-artist genre/vibe query scoped to effectiveGenre when available, rotated against previousFeedQuery
  const broadCandidates = effectiveGenre
    ? [
        `${effectiveGenre} trending hits official audio`,
        profile.tempoMood
          ? `${profile.tempoMood} ${effectiveGenre} playlist official music`
          : `${effectiveGenre} essentials official audio`,
        `best ${effectiveGenre} songs official music video`,
        profile.relatedGenres[0]
          ? `${effectiveGenre} and ${profile.relatedGenres[0]} hits official music`
          : `new ${effectiveGenre} releases official audio`,
      ]
    : [...DISCOVERY_FEED_QUERIES];

  const prevLower = (previousFeedQuery || '').trim().toLowerCase();
  const freshBroad = broadCandidates.filter((q) => q.toLowerCase() !== prevLower);
  const broadPool = freshBroad.length > 0 ? freshBroad : broadCandidates;
  const broadQuery = shuffleWithSeed(broadPool, visitSeed ^ 0x517cc1b7)[0] || DISCOVERY_FEED_QUERIES[0];

  return {
    seeds: pickedSeeds.slice(0, 6),
    broadQuery,
  };
}

export function scoreContentBasedCandidate(
  candidate: Track,
  profile: TrackContentProfile | null,
  seenSongKeys: ReadonlySet<string> = new Set(),
  seenTrackIds: ReadonlySet<string> = new Set(),
  jitter = 0
): number {
  const songKey = canonicalSongKey(candidate.title || '', candidate.artist || '');
  const candGenre = resolveCanonicalGenre(candidate.genre, candidate.artist, candidate.title, candidate.bpm);
  const haystack = `${candidate.title} ${candidate.artist} ${candidate.album} ${candidate.genre || ''}`.toLowerCase();

  let score = 0;

  // Strong novelty bonus for tracks not yet surfaced in this session
  if (!seenSongKeys.has(songKey) && !seenTrackIds.has(candidate.id)) {
    score += 100;
  } else {
    score -= 80;
  }

  if (profile) {
    if (profile.resolvedGenre && candGenre === profile.resolvedGenre) {
      score += 32;
    } else if (candGenre && profile.relatedGenres.includes(candGenre)) {
      score += 18;
    }

    if (
      profile.collaborators.some((c) => haystack.includes(c.toLowerCase()))
    ) {
      score += 15;
    }

    let keywordMatches = 0;
    for (const kw of profile.keywords) {
      if (haystack.includes(kw)) {
        keywordMatches += 1;
        if (keywordMatches >= 3) break;
      }
    }
    score += keywordMatches * 8;
  }

  if (candidate.isOfficial) score += 12;
  if (candidate.duration >= 110 && candidate.duration <= 420) score += 8;

  return score + jitter;
}

export function rankContentBasedCandidates(
  candidates: readonly Track[],
  profile: TrackContentProfile | null,
  options: {
    seenSongKeys?: ReadonlySet<string>;
    seenTrackIds?: ReadonlySet<string>;
    visitSeed?: number;
    maxResults?: number;
  } = {}
): Track[] {
  const seenSongKeys = options.seenSongKeys ?? new Set<string>();
  const seenTrackIds = options.seenTrackIds ?? new Set<string>();
  const visitSeed = options.visitSeed ?? Date.now();
  const maxResults = options.maxResults ?? 12;

  const filtered = candidates.filter((track) => {
    if (!track || !track.id || !track.title) return false;
    if (profile) {
      if (track.id === profile.trackId) return false;
      if (profile.youtubeId && track.youtubeId === profile.youtubeId) return false;
      if (canonicalSongKey(track.title, track.artist) === profile.excludedSongKey) return false;
    }
    return true;
  });

  const rand = createSeededRng(visitSeed ^ 0x9e3779b9);
  const scored = filtered
    .map((track) => ({
      track,
      score: scoreContentBasedCandidate(
        track,
        profile,
        seenSongKeys,
        seenTrackIds,
        rand() * 6
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track);

  return deduplicateDiverseTracks(scored, {
    maxPerSong: 1,
    maxPerArtist: 1,
    maxResults,
  });
}

const memorySessionSeen = new Map<string, string[]>();

export function readSessionSeenSongKeys(storageKey = 'kago_session_seen_songs'): Set<string> {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((x): x is string => typeof x === 'string'));
        }
      }
    }
  } catch {
    // Fallback to memory cache
  }
  return new Set(memorySessionSeen.get(storageKey) || []);
}

export function markSessionSeenSongs(
  tracks: readonly Track[],
  storageKey = 'kago_session_seen_songs',
  maxRemembered = 90
): void {
  const current = readSessionSeenSongKeys(storageKey);
  for (const track of tracks) {
    const key = canonicalSongKey(track.title || '', track.artist || '');
    if (key) current.add(key);
    if (track.id) current.add(`id::${track.id}`);
  }
  const trimmed = Array.from(current).slice(-maxRemembered);
  memorySessionSeen.set(storageKey, trimmed);
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(storageKey, JSON.stringify(trimmed));
    }
  } catch {
    // Ignore restricted sessionStorage contexts
  }
}

export function pickContentBasedPopularSearches(
  count = 5,
  seed = Date.now(),
  excludeTerms: readonly string[] = [],
  profile: TrackContentProfile | null = null
): string[] {
  if (!profile || !profile.resolvedGenre) {
    return pickDynamicPopularSearches(count, seed, excludeTerms);
  }

  const genrePool = GENRE_DISCOVERY_SEEDS[profile.resolvedGenre] || [];
  const adjacentPool = profile.relatedGenres.flatMap(
    (g) => GENRE_DISCOVERY_SEEDS[g] || []
  );
  const candidatePool = Array.from(
    new Set([...genrePool, ...adjacentPool, ...DYNAMIC_POPULAR_POOL])
  ).filter((term) => {
    if (
      profile.cleanTitle &&
      profile.cleanTitle.length >= 4 &&
      term.toLowerCase().includes(profile.cleanTitle)
    ) {
      return false;
    }
    return true;
  });

  const excludeSet = new Set(excludeTerms.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const fresh = candidatePool.filter((t) => !excludeSet.has(t.toLowerCase()));
  const pool = fresh.length >= count ? fresh : candidatePool;
  return shuffleWithSeed(pool, seed).slice(0, Math.max(1, count));
}

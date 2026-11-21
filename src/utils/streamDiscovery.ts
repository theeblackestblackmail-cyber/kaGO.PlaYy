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
];

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

export function nextDiscoveryVisitSeed(storageKey = 'kago_discovery_visit_seed'): number {
  const base = Date.now() ^ Math.floor(Math.random() * 0x7fffffff);
  try {
    if (typeof sessionStorage !== 'undefined') {
      const prev = Number(sessionStorage.getItem(storageKey) || '0');
      const next = (Number.isFinite(prev) ? prev : 0) + 1;
      sessionStorage.setItem(storageKey, String(next));
      return (base ^ (next * 2654435761)) >>> 0;
    }
  } catch {
    // Ignore restricted sessionStorage contexts
  }
  return base >>> 0;
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
  const combined = [...DISCOVERY_FEED_QUERIES, ...DYNAMIC_POPULAR_POOL.slice(0, 12)];
  const prevLower = previousQuery?.trim().toLowerCase();
  const candidates = prevLower
    ? combined.filter((q) => q.toLowerCase() !== prevLower)
    : combined;
  const pool = candidates.length > 0 ? candidates : combined;
  const shuffled = shuffleWithSeed(pool, seed);
  return shuffled[0] || DISCOVERY_FEED_QUERIES[0];
}

export function rotateCuratedFallbackTracks(
  tracks: readonly Track[],
  seed = Date.now()
): Track[] {
  return shuffleWithSeed(tracks, seed);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilename } from './filenameSanitizer';
import { parseLrc, formatLrcTimestamp, findActiveLyricIndex, formatDuration } from './lrcParser';
import {
  parseId3v2Buffer,
  repairCorruptedTrack,
  repairMojibakeText,
} from './audioMetadata';
import {
  buildCategorySearchPlan,
  buildCollectionQueue,
  buildInnertubeSearchBody,
  buildRadioSeedQuery,
  clampCrossfadeSeconds,
  computeMasterOutputGain,
  enqueueImportedOfflineTracks,
  extractYouTubeArtists,
  extractYouTubeCollections,
  extractYouTubePlaylistTracks,
  extractYouTubePodcasts,
  extractYouTubeRelatedResults,
  extractYouTubeSearchResults,
  filterMusicSuggestions,
  filterRelevantAudiusTracks,
  isIndividualSong,
  MAX_RECENT_SEARCHES,
  mergeAutoplayQueue,
  parseYouTubeArtistAndTitle,
  parseYouTubeDuration,
  parseYouTubeSuggestResponse,
  parseYouTubeViewCount,
  pushRecentSearch,
  rankYouTubeSearchResults,
  reorderQueueItems,
  selectActiveYouTubeViewport,
  shouldAutoResumeBackgroundPause,
  sortStudioQueue,
} from './streamFilter';
import {
  convertPlainLyricsToLrc,
  pickBestLrclibCandidate,
  sanitizeTrackForLyrics,
} from './lyricsFetcher';
import {
  POOR_CONNECTION_THRESHOLD_MS,
  evaluatePoorConnectionState,
  reorderMultipleQueueItems,
  restoreQueueOrder,
  selectSmartLibraryTracks,
  shuffleQueuePreservingCurrent,
} from './queueUtils';
import {
  STALL_NUDGE_MS,
  STALL_RECOVER_MS,
  evaluatePlaybackWatchdog,
  isPrematureStreamEnded,
  shouldAutoResumePlaybackPause,
} from './playbackStability';
import type { StudioQueueItem, Track } from '../types/audio';

test('sanitizeFilename cleans noisy YouTube rip filenames and separates artist and title', () => {
  const res = sanitizeFilename('04 - Daft_Punk_-_Derezzed_(Official_Video)_[4K_HQ_320kbps].mp3');
  assert.equal(res.artist, 'Daft Punk');
  assert.equal(res.title, 'Derezzed');
  assert.equal(res.displayName, 'Daft Punk - Derezzed');
});

test('sanitizeFilename preserves meaningful qualifiers and detects OST/Album brackets', () => {
  const res = sanitizeFilename('07_kavinsky_-_nightcall_(drive_ost)_[official_music_video]\uFFFD.m4a');
  assert.equal(res.artist, 'kavinsky');
  assert.equal(res.title, 'nightcall');
  assert.equal(res.album, 'drive ost');
});

test('parseLrc parses timestamps, sorts lines, and ignores metadata tags', () => {
  const raw = [
    '[ti:Cyber Resonance]',
    '[ar:kaGO Synth]',
    '[00:15.50] Signal locked in the dark',
    '[00:05.00] Booting hardware rack',
    '[00:30.25] Crimson frequency rising',
  ].join('\n');

  const lines = parseLrc(raw);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].time, 5);
  assert.equal(lines[0].text, 'Booting hardware rack');
  assert.equal(lines[1].time, 15.5);
  assert.equal(lines[2].time, 30.25);
});

test('findActiveLyricIndex respects calibration offset', () => {
  const lines = parseLrc('[00:10.00] First line\n[00:20.00] Second line');
  assert.equal(findActiveLyricIndex(lines, 9.5, 0), -1);
  assert.equal(findActiveLyricIndex(lines, 9.5, 0.8), 0);
  assert.equal(findActiveLyricIndex(lines, 20.5, -1.0), 0);
  assert.equal(findActiveLyricIndex(lines, 20.5, 0), 1);
});

test('formatLrcTimestamp and formatDuration format time accurately', () => {
  assert.equal(formatLrcTimestamp(65.42), '[01:05.42]');
  assert.equal(formatDuration(185), '3:05');
  assert.equal(formatDuration(3665), '1:01:05');
});

test('isIndividualSong strictly rejects 30s previews, mixes, playlists, and >15m sets', () => {
  assert.equal(isIndividualSong('Midnight City', 'Hurry Up', 243), true);
  assert.equal(isIndividualSong('Short Preview Clip', 'Single', 30), false);
  assert.equal(isIndividualSong('Synthwave 1 Hour Mix', 'Various', 3600), false);
  assert.equal(isIndividualSong('Afrobeats Nonstop DJ Set', 'Club', 700), false);
  assert.equal(isIndividualSong('Deep Focus Playlist', 'Study', 300), false);
});

test('parseYouTubeDuration, parseYouTubeViewCount, and parseYouTubeArtistAndTitle parse cleanly', () => {
  assert.equal(parseYouTubeDuration('2:54'), 174);
  assert.equal(parseYouTubeDuration('1:02:05'), 3725);
  assert.equal(parseYouTubeDuration('LIVE'), 0);

  assert.equal(parseYouTubeViewCount('2.1B views'), 2_100_000_000);
  assert.equal(parseYouTubeViewCount('45M views'), 45_000_000);
  assert.equal(parseYouTubeViewCount('890K views'), 890_000);
  assert.equal(parseYouTubeViewCount('12,345 views'), 12_345);

  const parsed = parseYouTubeArtistAndTitle(
    'Burna Boy - Last Last [Official Audio]',
    'Burna Boy - Topic'
  );
  assert.equal(parsed.artist, 'Burna Boy');
  assert.equal(parsed.title, 'Last Last');
});

test('extractYouTubeSearchResults & rankYouTubeSearchResults rank official high-view hits above covers', () => {
  const sampleYtData = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      videoRenderer: {
                        videoId: 'cover000001',
                        title: { runs: [{ text: 'OceanSkies - Hotline Bling (Drake Cover)' }] },
                        ownerText: { runs: [{ text: 'OceanSkies Avenue' }] },
                        lengthText: { simpleText: '2:53' },
                        viewCountText: { simpleText: '1,200 views' },
                      },
                    },
                    {
                      videoRenderer: {
                        videoId: 'uxpDa-c-4Mc',
                        title: { runs: [{ text: 'Drake - Hotline Bling' }] },
                        ownerText: { runs: [{ text: 'Drake' }] },
                        ownerBadges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED_ARTIST' } }],
                        lengthText: { simpleText: '4:55' },
                        viewCountText: { simpleText: '2.1B views' },
                      },
                    },
                    {
                      videoRenderer: {
                        videoId: 'short000001',
                        title: { runs: [{ text: 'Quick Teaser' }] },
                        ownerText: { runs: [{ text: 'Channel' }] },
                        lengthText: { simpleText: '0:28' },
                      },
                    },
                    {
                      videoRenderer: {
                        videoId: 'mix00000002',
                        title: { runs: [{ text: 'Drake 1 Hour Mix' }] },
                        ownerText: { runs: [{ text: 'DJ' }] },
                        lengthText: { simpleText: '58:00' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const html = `<html><script>var ytInitialData = ${JSON.stringify(sampleYtData)};</script></html>`;
  const extracted = extractYouTubeSearchResults(html);
  assert.equal(extracted.length, 2);

  const ranked = rankYouTubeSearchResults(extracted, 'Drake hotline bling');
  assert.equal(ranked[0].videoId, 'uxpDa-c-4Mc');
  assert.equal(ranked[0].isOfficial, true);
  assert.equal(ranked[0].viewCount, 2_100_000_000);
});

test('parseYouTubeSuggestResponse parses autocomplete arrays cleanly', () => {
  const payload = JSON.stringify(['drake', ['drake hotline bling', 'drake gods plan', 'drake passionfruit']]);
  assert.deepEqual(parseYouTubeSuggestResponse(payload), [
    'drake hotline bling',
    'drake gods plan',
    'drake passionfruit',
  ]);
  assert.deepEqual(parseYouTubeSuggestResponse('not-json'), []);
});

test('sortStudioQueue orders by upvotes descending then timestamp ascending', () => {
  const baseTrack = {
    id: 't1',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    source: 'synth' as const,
    addedAt: 1000,
  };
  const items: StudioQueueItem[] = [
    { id: 'q1', track: baseTrack, addedBy: 'A', addedAt: 100, upvotes: 1, voterIds: ['u1'] },
    { id: 'q2', track: baseTrack, addedBy: 'B', addedAt: 200, upvotes: 4, voterIds: ['u1', 'u2', 'u3', 'u4'] },
    { id: 'q3', track: baseTrack, addedBy: 'C', addedAt: 50, upvotes: 4, voterIds: ['u1', 'u2', 'u3', 'u4'] },
  ];
  const sorted = sortStudioQueue(items);
  assert.deepEqual(sorted.map((s) => s.id), ['q3', 'q2', 'q1']);
});

test('parseId3v2Buffer extracts UTF-8, UTF-16BE BOM, UTF-16LE BOM, BOM-less UTF-16BE, and v2.4 Data Length Indicator frames', () => {
  function utf16BeBytes(str: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      out.push((code >> 8) & 0xff, code & 0xff);
    }
    return out;
  }
  function utf16LeBytes(str: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      out.push(code & 0xff, (code >> 8) & 0xff);
    }
    return out;
  }
  function makeV4Frame(id: string, payload: number[], flag2 = 0): number[] {
    const size = payload.length;
    return [
      ...Array.from(new TextEncoder().encode(id)),
      (size >>> 21) & 0x7f,
      (size >>> 14) & 0x7f,
      (size >>> 7) & 0x7f,
      size & 0x7f,
      0,
      flag2,
      ...payload,
    ];
  }

  // TIT2: UTF-16BE with FE FF BOM + ID3v2.4 Data Length Indicator (0x01, 4 extra bytes)
  const tit2Payload = [0, 0, 0, 12, 1, 0xfe, 0xff, ...utf16BeBytes('See You Again')];
  // TPE1: UTF-16LE with FF FE BOM
  const tpe1Payload = [1, 0xff, 0xfe, ...utf16LeBytes('Wiz Khalifa')];
  // TALB: BOM-less UTF-16BE tagged as encoding 1 (broken tagger quirk)
  const talbPayload = [1, ...utf16BeBytes('Furious 7')];
  // TRCK: UTF-8
  const trckPayload = [3, ...Array.from(new TextEncoder().encode('03/12'))];

  const frames = [
    ...makeV4Frame('TIT2', tit2Payload, 0x01),
    ...makeV4Frame('TPE1', tpe1Payload),
    ...makeV4Frame('TALB', talbPayload),
    ...makeV4Frame('TRCK', trckPayload),
  ];
  const tagSize = frames.length;
  const header = [
    0x49, 0x44, 0x33, // ID3
    4, 0, // v2.4
    0,
    (tagSize >>> 21) & 0x7f,
    (tagSize >>> 14) & 0x7f,
    (tagSize >>> 7) & 0x7f,
    tagSize & 0x7f,
  ];
  const buf = new Uint8Array([...header, ...frames]).buffer;
  const parsed = parseId3v2Buffer(buf);
  assert.equal(parsed.title, 'See You Again');
  assert.equal(parsed.artist, 'Wiz Khalifa');
  assert.equal(parsed.album, 'Furious 7');
  assert.equal(parsed.trackNumber, 3);
});

test('repairMojibakeText and repairCorruptedTrack heal swapped UTF-16 CJK mojibake and fallback cleanly', async () => {
  assert.equal(repairMojibakeText('匀攀攀'), 'See');

  const brokenTrack: Track = {
    id: 'local-Drake_-_Hotline_Bling_mp3-123456-7890',
    title: '\uFFFD\uFFFE胯斁揌楸',
    artist: '\uFFFD一仭吀',
    album: '\uFFFD蓨玪洉',
    duration: 180,
    source: 'local',
    folderPath: 'Picked Songs',
    addedAt: 1,
  };

  const repaired = await repairCorruptedTrack(brokenTrack);
  assert.ok(repaired);
  assert.equal(repaired.artist, 'Drake');
  assert.equal(repaired.title, 'Hotline Bling');
});

test('setup-android-native patches AndroidManifest, Gradle, and copies Java Media/PiP classes idempotently', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { applyAndroidNativeOverrides } = await import('../../scripts/setup-android-native.mjs');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kago-android-test-'));
  try {
    const androidMain = path.join(tmpRoot, 'android', 'app', 'src', 'main');
    fs.mkdirSync(path.join(androidMain, 'java', 'com', 'kagoplay', 'workstation'), { recursive: true });
    fs.symlinkSync(path.resolve(process.cwd(), 'android-native'), path.join(tmpRoot, 'android-native'));

    fs.writeFileSync(
      path.join(androidMain, 'AndroidManifest.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale"
            android:exported="true">
        </activity>
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(tmpRoot, 'android', 'app', 'build.gradle'),
      `android {\n    namespace "com.kagoplay.workstation"\n}\ndependencies {\n    implementation "androidx.appcompat:appcompat:1.6.1"\n}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'android', 'variables.gradle'),
      `ext {\n    compileSdkVersion = 34\n    targetSdkVersion = 34\n}\n`,
      'utf8'
    );

    applyAndroidNativeOverrides(tmpRoot);
    applyAndroidNativeOverrides(tmpRoot); // verify idempotency

    const manifest = fs.readFileSync(path.join(androidMain, 'AndroidManifest.xml'), 'utf8');
    assert.ok(manifest.includes('android:hardwareAccelerated="true"'));
    assert.ok(manifest.includes('ACCESS_WIFI_STATE'));
    assert.ok(manifest.includes('ACCESS_NETWORK_STATE'));
    assert.ok(manifest.includes('VIBRATE'));
    assert.ok(manifest.includes('FOREGROUND_SERVICE_MEDIA_PLAYBACK'));
    assert.ok(manifest.includes('POST_NOTIFICATIONS'));
    assert.ok(manifest.includes('android:supportsPictureInPicture="true"'));
    assert.ok(manifest.includes('.KaGoMediaService'));
    assert.ok(manifest.includes('smallestScreenSize'));

    const gradle = fs.readFileSync(path.join(androidMain, '..', '..', 'build.gradle'), 'utf8');
    assert.equal(gradle.match(/androidx\.media:media:1\.7\.0/g)?.length, 1);
    assert.equal(gradle.match(/JavaVersion\.VERSION_17/g)?.length, 2);

    const mainActivityPath = path.join(androidMain, 'java', 'com', 'kagoplay', 'workstation', 'MainActivity.java');
    assert.ok(fs.existsSync(mainActivityPath));
    assert.ok(fs.readFileSync(mainActivityPath, 'utf8').includes('triggerHaptic'));
    assert.ok(fs.existsSync(path.join(androidMain, 'java', 'com', 'kagoplay', 'workstation', 'KaGoMediaService.java')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('extractYouTubeRelatedResults extracts Up Next individual songs and excludes mixes and seed ID', () => {
  const sampleWatchData = {
    contents: {
      twoColumnWatchNextResults: {
        secondaryResults: {
          secondaryResults: {
            results: [
              {
                compactVideoRenderer: {
                  videoId: 'seed1234567',
                  title: { simpleText: 'Kavinsky - Nightcall' },
                  shortBylineText: { runs: [{ text: 'Kavinsky' }] },
                  lengthText: { simpleText: '4:18' },
                },
              },
              {
                compactVideoRenderer: {
                  videoId: 'rel11111111',
                  title: { simpleText: 'M83 - Midnight City [Official Audio]' },
                  shortBylineText: { runs: [{ text: 'M83 - Topic' }] },
                  lengthText: { simpleText: '4:03' },
                },
              },
              {
                compactVideoRenderer: {
                  videoId: 'relmix22222',
                  title: { simpleText: 'Best Synthwave 1 Hour Mix' },
                  shortBylineText: { runs: [{ text: 'DJ Mix' }] },
                  lengthText: { simpleText: '59:12' },
                },
              },
            ],
          },
        },
      },
    },
  };
  const html = `<html><script>var ytInitialData = ${JSON.stringify(sampleWatchData)};</script></html>`;
  const related = extractYouTubeRelatedResults(html, 'seed1234567');
  assert.equal(related.length, 1);
  assert.equal(related[0].videoId, 'rel11111111');
  assert.equal(related[0].artist, 'M83');
  assert.equal(related[0].title, 'Midnight City');
});

test('buildRadioSeedQuery and mergeAutoplayQueue preserve manual queue tracks and refresh auto radio items', () => {
  const seed: Track = {
    id: 'yt-seed',
    youtubeId: 'seed123',
    title: 'Nightcall',
    artist: 'Kavinsky',
    album: 'YouTube Music Stream',
    duration: 258,
    source: 'stream',
    genre: 'Electronic',
    addedAt: 1,
  };
  const manualTrack: Track = {
    id: 'manual-1',
    title: 'Manual Pick',
    artist: 'User Artist',
    album: 'Local',
    duration: 200,
    source: 'local',
    addedAt: 2,
  };
  const staleAutoTrack: Track = {
    id: 'yt-old-auto',
    youtubeId: 'oldauto',
    title: 'Old Auto',
    artist: 'Old Artist',
    album: 'Radio',
    duration: 210,
    source: 'stream',
    autoQueued: true,
    addedAt: 3,
  };
  const newRelated: Track[] = [
    { ...seed }, // duplicate of seed should be skipped
    {
      id: 'yt-rel-1',
      youtubeId: 'rel1',
      title: 'Midnight City',
      artist: 'M83',
      album: 'YouTube Radio Up Next',
      duration: 243,
      source: 'stream',
      addedAt: 4,
    },
  ];

  assert.equal(buildRadioSeedQuery(seed), 'Kavinsky Electronic songs');

  const merged = mergeAutoplayQueue([seed, manualTrack, staleAutoTrack], seed, newRelated, {
    replaceExistingAuto: true,
  });
  assert.deepEqual(
    merged.map((t) => t.id),
    ['yt-seed', 'manual-1', 'yt-rel-1']
  );
  assert.equal(merged[1].autoQueued, undefined);
  assert.equal(merged[2].autoQueued, true);
});

test('folderImporter filters supported audio files and builds local tracks cleanly', async () => {
  const { buildTracksFromFilePairs, isSupportedAudioFile } = await import('./folderImporter');

  assert.equal(isSupportedAudioFile({ name: 'song.mp3', type: 'audio/mpeg' }), true);
  assert.equal(isSupportedAudioFile({ name: 'lossless.flac', type: '' }), true);
  assert.equal(isSupportedAudioFile({ name: 'cover.jpg', type: 'image/jpeg' }), false);

  const mp3File = new File([new Uint8Array([0x49, 0x44, 0x33])], 'Kavinsky_-_Nightcall.mp3', {
    type: 'audio/mpeg',
    lastModified: 1700000000000,
  });
  const jpgFile = new File([new Uint8Array([0xff, 0xd8])], 'album_cover.jpg', {
    type: 'image/jpeg',
  });

  const built = await buildTracksFromFilePairs([
    { file: jpgFile, folderPath: 'Music/Synth' },
    { file: mp3File, folderPath: 'Music/Synth' },
  ]);

  assert.equal(built.length, 1);
  assert.equal(built[0].track.source, 'local');
  assert.equal(built[0].track.folderPath, 'Music/Synth');
  assert.equal(built[0].track.artist, 'Kavinsky');
  assert.equal(built[0].track.title, 'Nightcall');
});

test('themeManager converts HSV/Hex accurately and derives accessible accent palettes', async () => {
  const {
    deriveAccentPalette,
    getContrastTextColor,
    hexToHsv,
    hsvToHex,
    normalizeHex,
  } = await import('./themeManager');

  assert.equal(normalizeHex('3b82f6'), '#3B82F6');
  assert.equal(normalizeHex('#abc'), '#AABBCC');
  assert.equal(normalizeHex('invalid'), null);

  // Pure primary round-trips
  assert.equal(hsvToHex(0, 100, 100), '#FF0000');
  assert.equal(hsvToHex(240, 100, 100), '#0000FF');
  const redHsv = hexToHsv('#E11D48');
  const roundTrip = hsvToHex(redHsv.h, redHsv.s, redHsv.v);
  assert.ok(roundTrip.startsWith('#') && roundTrip.length === 7);

  // Contrast safety for light vs dark accent choices
  assert.equal(getContrastTextColor('#FACC15'), '#0A0B0F');
  assert.equal(getContrastTextColor('#E11D48'), '#FFFFFF');

  const blueDark = deriveAccentPalette('#2563EB', 'dark', 100);
  assert.equal(blueDark.base, '#2563EB');
  assert.equal(blueDark.rgb, '37, 99, 235');
  assert.equal(blueDark.onAccent, '#FFFFFF');
});

test('shouldAutoResumeBackgroundPause keeps backgrounded playback alive while respecting explicit pauses', () => {
  const now = 100_000;

  // Switching to Recents / another app triggers visibility=hidden: auto-resume!
  assert.equal(
    shouldAutoResumeBackgroundPause({
      isPlaying: true,
      visibilityState: 'hidden',
      now,
      backgroundTransitionUntil: 0,
      userPausedAt: 0,
    }),
    true
  );

  // Within native minimize grace window even if visibility momentarily flickers: auto-resume!
  assert.equal(
    shouldAutoResumeBackgroundPause({
      isPlaying: true,
      visibilityState: 'visible',
      now,
      backgroundTransitionUntil: now + 3000,
      userPausedAt: 0,
    }),
    true
  );

  // Explicit user pause within last 2s must NOT auto-resume
  assert.equal(
    shouldAutoResumeBackgroundPause({
      isPlaying: true,
      visibilityState: 'hidden',
      now,
      backgroundTransitionUntil: now + 3000,
      userPausedAt: now - 500,
    }),
    false
  );

  // Already paused state stays paused
  assert.equal(
    shouldAutoResumeBackgroundPause({
      isPlaying: false,
      visibilityState: 'hidden',
      now,
      backgroundTransitionUntil: now + 3000,
      userPausedAt: 0,
    }),
    false
  );
});

test('rankYouTubeSearchResults ranks popular official songs #1 even with minor spelling typos', () => {
  const candidates = [
    {
      videoId: 'lowview9999',
      title: 'We Wega (Fan Upload)',
      artist: 'Random Channel',
      durationSeconds: 210,
      thumbnailUrl: 'https://i.ytimg.com/vi/lowview9999/hqdefault.jpg',
      viewCount: 850,
      isOfficial: false,
      channelName: 'Random Channel',
    },
    {
      videoId: 'popularhit1',
      title: 'We Wega',
      artist: 'Wangechi, Scar Mkadinali',
      durationSeconds: 218,
      thumbnailUrl: 'https://i.ytimg.com/vi/popularhit1/hqdefault.jpg',
      viewCount: 3_400_000,
      isOfficial: true,
      channelName: 'Wangechi - Topic',
    },
    {
      videoId: 'coverhit002',
      title: 'We Wega Acoustic Cover',
      artist: 'Local Singer',
      durationSeconds: 205,
      thumbnailUrl: 'https://i.ytimg.com/vi/coverhit002/hqdefault.jpg',
      viewCount: 15_000,
      isOfficial: false,
      channelName: 'Local Singer',
    },
  ];

  // Typo "wangeci" (missing 'h') still boosts official 3.4M hit to #1 and filters out unrequested acoustic covers
  const ranked = rankYouTubeSearchResults(candidates, 'we wega wangeci', 'songs');
  assert.equal(ranked[0].videoId, 'popularhit1');
  assert.equal(ranked.some((r) => r.videoId === 'coverhit002'), false);
});

test('buildCategorySearchPlan builds appropriate search queries and YouTube filters for all 8 categories', () => {
  assert.equal(buildCategorySearchPlan('Drake', '', 'all').sp, undefined);
  assert.equal(buildCategorySearchPlan('Drake', '', 'songs').sp, 'EgIQAQ%3D%3D');
  assert.ok(buildCategorySearchPlan('Drake', '', 'videos').searchQuery.includes('official music video'));
  assert.ok(buildCategorySearchPlan('Drake', '', 'albums').searchQuery.includes('full album'));
  assert.equal(buildCategorySearchPlan('Drake', '', 'artists').sp, 'EgIQAg%3D%3D');
  assert.equal(buildCategorySearchPlan('Drake', '', 'playlists').sp, 'EgIQAw%3D%3D');
  assert.equal(buildCategorySearchPlan('Drake', '', 'featured_playlists').sp, 'EgIQAw%3D%3D');
  assert.ok(buildCategorySearchPlan('Drake', '', 'podcasts').searchQuery.includes('podcast full episode'));
});

test('extractYouTubeArtists, extractYouTubeCollections, extractYouTubePodcasts, and extractYouTubePlaylistTracks parse YouTube initialData payloads', () => {
  const searchPayload = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      channelRenderer: {
                        channelId: 'UCartist01',
                        title: { simpleText: 'Wangechi - Topic' },
                        thumbnail: { thumbnails: [{ url: '//yt3.ggpht.com/avatar=s176' }] },
                        subscriberCountText: { simpleText: '240K subscribers' },
                        ownerBadges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED_ARTIST' } }],
                      },
                    },
                    {
                      playlistRenderer: {
                        playlistId: 'PLalbum001',
                        title: { simpleText: 'Chonjo EP' },
                        shortBylineText: { runs: [{ text: 'Wangechi' }] },
                        videoCount: '6',
                        thumbnails: [{ thumbnails: [{ url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' }] }],
                      },
                    },
                    {
                      videoRenderer: {
                        videoId: 'pod12345678',
                        title: { runs: [{ text: 'Behind The Music Podcast Episode 12' }] },
                        ownerText: { runs: [{ text: 'Studio Talk' }] },
                        lengthText: { simpleText: '42:10' },
                        viewCountText: { simpleText: '120K views' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const searchHtml = `<html><script>var ytInitialData = ${JSON.stringify(searchPayload)};</script></html>`;

  const artists = extractYouTubeArtists(searchHtml);
  assert.equal(artists.length, 1);
  assert.equal(artists[0].name, 'Wangechi');
  assert.equal(artists[0].thumbnailUrl, 'https://yt3.ggpht.com/avatar=s176');
  assert.equal(artists[0].isOfficial, true);

  const albums = extractYouTubeCollections(searchHtml, 'albums', 'Hip-Hop');
  assert.equal(albums.length, 1);
  assert.equal(albums[0].youtubePlaylistId, 'PLalbum001');
  assert.equal(albums[0].trackCount, 6);
  assert.equal(albums[0].resultType, 'album');

  const podcasts = extractYouTubePodcasts(searchHtml, 'Talk');
  assert.equal(podcasts.length, 1);
  assert.equal(podcasts[0].youtubeId, 'pod12345678');
  assert.equal(podcasts[0].resultType, 'podcast');

  const playlistHtml = `<html><script>var ytInitialData = ${JSON.stringify({
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      itemSectionRenderer: {
                        contents: [
                          {
                            playlistVideoListRenderer: {
                              contents: [
                                {
                                  playlistVideoRenderer: {
                                    videoId: 'trk11111111',
                                    title: { runs: [{ text: 'Wangechi - We Wega' }] },
                                    shortBylineText: { runs: [{ text: 'Wangechi' }] },
                                    lengthText: { simpleText: '3:38' },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  })};</script></html>`;

  const playlistTracks = extractYouTubePlaylistTracks(playlistHtml, 'Chonjo EP');
  assert.equal(playlistTracks.length, 1);
  assert.equal(playlistTracks[0].youtubeId, 'trk11111111');
  assert.equal(playlistTracks[0].artist, 'Wangechi');
  assert.equal(playlistTracks[0].title, 'We Wega');
  assert.equal(playlistTracks[0].album, 'Chonjo EP');
});

test('pushRecentSearch deduplicates case-insensitively and limits history to 5 most recent items', () => {
  let list: string[] = [];
  for (const term of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'two']) {
    list = pushRecentSearch(list, term);
  }
  assert.equal(list.length, MAX_RECENT_SEARCHES);
  assert.equal(MAX_RECENT_SEARCHES, 5);
  assert.deepEqual(list, ['two', 'Six', 'Five', 'Four', 'Three']);
});

test('computeMasterOutputGain unlocks full clean speaker headroom without compressing flat tracks', () => {
  const flatGain = computeMasterOutputGain({
    bands: [0, 0, 0, 0, 0],
    bassBoostEnabled: false,
    bassBoostDb: 0,
  });
  const boostedGain = computeMasterOutputGain({
    bands: [6, 4, 0, 3, 5],
    bassBoostEnabled: true,
    bassBoostDb: 10,
  });

  assert.ok(flatGain >= 1.3, `Expected flatGain >= 1.3, got ${flatGain}`);
  assert.ok(boostedGain >= 1.0 && boostedGain < flatGain);
});

test('sanitizeTrackForLyrics, pickBestLrclibCandidate, and convertPlainLyricsToLrc prepare synced lyrics accurately', () => {
  const cleaned = sanitizeTrackForLyrics(
    'Hotline Bling (Official Music Video) [HD]',
    'Drake - Topic'
  );
  assert.equal(cleaned.artistName, 'Drake');
  assert.equal(cleaned.trackName, 'Hotline Bling');

  const best = pickBestLrclibCandidate(
    [
      { id: 1, trackName: 'Test', plainLyrics: 'Line 1\nLine 2\nLine 3\nLine 4', duration: 200 },
      {
        id: 2,
        trackName: 'Test',
        syncedLyrics: '[00:10.00] Line 1\n[00:20.00] Line 2\n[00:30.00] Line 3',
        duration: 198,
      },
    ],
    200
  );
  assert.equal(best?.id, 2);

  const lrc = convertPlainLyricsToLrc('First verse\nSecond verse\nChorus line', 120);
  const parsed = parseLrc(lrc);
  assert.equal(parsed.length, 3);
  assert.ok(parsed[0].time < parsed[1].time && parsed[1].time < parsed[2].time);
});

test('extractYouTubeSearchResults parses Innertube JSON, videoWithContextRenderer, and rejects unverified "Official Audio" title spam', () => {
  const innertubeJson = JSON.stringify({
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      // Spam channel putting "Official Lyric Video" in title with 650 views
                      videoWithContextRenderer: {
                        videoId: 'spam0000001',
                        headline: { runs: [{ text: 'Burna Boy - Last Last (Official Lyric Video)' }] },
                        shortBylineText: { runs: [{ text: 'Random Lyrics Uploads' }] },
                        lengthText: { simpleText: '2:53' },
                        shortViewCountText: { simpleText: '650 views' },
                      },
                    },
                    {
                      // Sped up derivative version with medium views
                      videoRenderer: {
                        videoId: 'spedup00002',
                        title: { runs: [{ text: 'Burna Boy - Last Last (Sped Up + Reverb)' }] },
                        ownerText: { runs: [{ text: 'SpeedBeats' }] },
                        lengthText: { simpleText: '2:25' },
                        viewCountText: { simpleText: '420K views' },
                      },
                    },
                    {
                      // Real verified official hit
                      videoRenderer: {
                        videoId: '421w1j87fEM',
                        title: { runs: [{ text: 'Burna Boy - Last Last [Official Music Video]' }] },
                        ownerText: { runs: [{ text: 'Burna Boy' }] },
                        ownerBadges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED_ARTIST' } }],
                        lengthText: { simpleText: '2:56' },
                        viewCountText: { simpleText: '340M views' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });

  const extracted = extractYouTubeSearchResults(innertubeJson);
  assert.equal(extracted.length, 3);

  const spamItem = extracted.find((v) => v.videoId === 'spam0000001');
  const officialItem = extracted.find((v) => v.videoId === '421w1j87fEM');
  assert.equal(spamItem?.isOfficial, false);
  assert.equal(officialItem?.isOfficial, true);

  // Plain search drops Sped Up and ranks verified 340M official upload #1
  const rankedPlain = rankYouTubeSearchResults(extracted, 'Burna Boy Last Last', 'songs');
  assert.equal(rankedPlain[0].videoId, '421w1j87fEM');
  assert.equal(rankedPlain.some((r) => r.videoId === 'spedup00002'), false);

  // Explicit derivative search keeps Sped Up when requested
  const rankedSpedUp = rankYouTubeSearchResults(extracted, 'Burna Boy Last Last sped up', 'songs');
  assert.equal(rankedSpedUp.some((r) => r.videoId === 'spedup00002'), true);
});

test('filterMusicSuggestions, buildInnertubeSearchBody, and filterRelevantAudiusTracks enforce clean music search hygiene', () => {
  const suggestions = filterMusicSuggestions(
    [
      'drake hotline bling',
      'drake hotline bling piano tutorial',
      'drake hotline bling reaction',
      'drake hotline bling slowed reverb',
      'drake gods plan',
    ],
    'drake'
  );
  assert.deepEqual(suggestions, ['drake hotline bling', 'drake gods plan']);

  const innertubeBody = JSON.parse(buildInnertubeSearchBody('Rema Calm Down', 'EgIQAQ%3D%3D')) as {
    context: { client: { gl: string; hl: string } };
    query: string;
    params?: string;
  };
  assert.equal(innertubeBody.query, 'Rema Calm Down');
  assert.equal(innertubeBody.params, 'EgIQAQ==');
  assert.equal(innertubeBody.context.client.gl, 'US');

  const audiusCandidates: Track[] = [
    {
      id: 'audius-1',
      title: 'Unrelated Synth Jam',
      artist: 'Bedroom Producer',
      album: 'Audius',
      duration: 180,
      source: 'stream',
      addedAt: 1,
    },
    {
      id: 'audius-2',
      title: 'Hotline Bling (Flip)',
      artist: 'Drake Fan Club',
      album: 'Audius',
      duration: 210,
      source: 'stream',
      addedAt: 2,
    },
  ];
  const relevant = filterRelevantAudiusTracks(audiusCandidates, 'Drake Hotline Bling');
  assert.deepEqual(
    relevant.map((t) => t.id),
    ['audius-2']
  );
});

test('reorderQueueItems moves tracks forward, backward, and guards out-of-bounds indices', () => {
  const mk = (id: string): Track => ({
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Offline',
    duration: 180,
    source: 'local',
    addedAt: 1,
  });
  const q = [mk('a'), mk('b'), mk('c'), mk('d')];

  const moveDown = reorderQueueItems(q, 0, 2);
  assert.deepEqual(
    moveDown.map((t) => t.id),
    ['b', 'c', 'a', 'd']
  );

  const moveUp = reorderQueueItems(moveDown, 3, 1);
  assert.deepEqual(
    moveUp.map((t) => t.id),
    ['b', 'd', 'c', 'a']
  );

  // Invalid or no-op moves return unchanged order
  assert.deepEqual(reorderQueueItems(q, -1, 2).map((t) => t.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(reorderQueueItems(q, 1, 99).map((t) => t.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(reorderQueueItems(q, 2, 2).map((t) => t.id), ['a', 'b', 'c', 'd']);
});

test('enqueueImportedOfflineTracks and buildCollectionQueue queue all uploaded offline tracks in sequence', () => {
  const stem1: Track = {
    id: 'stem-1',
    title: 'Stem 1',
    artist: 'Synth',
    album: 'Stems',
    duration: 180,
    source: 'synth',
    addedAt: 1,
  };
  const stem2: Track = {
    id: 'stem-2',
    title: 'Stem 2',
    artist: 'Synth',
    album: 'Stems',
    duration: 180,
    source: 'synth',
    addedAt: 2,
  };
  const stemIds = new Set(['stem-1', 'stem-2']);

  const off1: Track = {
    id: 'local-1',
    title: 'Track One',
    artist: 'Local Artist',
    album: 'Folder',
    duration: 200,
    source: 'local',
    addedAt: 3,
  };
  const off2: Track = {
    id: 'local-2',
    title: 'Track Two',
    artist: 'Local Artist',
    album: 'Folder',
    duration: 210,
    source: 'local',
    addedAt: 4,
  };
  const off3: Track = {
    id: 'local-3',
    title: 'Track Three',
    artist: 'Local Artist',
    album: 'Folder',
    duration: 220,
    source: 'local',
    addedAt: 5,
  };

  // Uploading offline tracks when queue only has default stems replaces stems cleanly with all uploaded songs
  const afterInitialUpload = enqueueImportedOfflineTracks([stem1, stem2], [off1, off2], stemIds);
  assert.deepEqual(
    afterInitialUpload.map((t) => t.id),
    ['local-1', 'local-2']
  );

  // Subsequent upload appends new songs without duplicating existing ones
  const afterSecondUpload = enqueueImportedOfflineTracks(afterInitialUpload, [off2, off3], stemIds);
  assert.deepEqual(
    afterSecondUpload.map((t) => t.id),
    ['local-1', 'local-2', 'local-3']
  );

  // Playing from Library collection queues entire folder/playlist and starts at clicked index
  const collection = buildCollectionQueue([off1, off2, off3, off1], 1);
  assert.deepEqual(
    collection.queue.map((t) => t.id),
    ['local-1', 'local-2', 'local-3']
  );
  assert.equal(collection.startTrack?.id, 'local-2');
});

test('clampCrossfadeSeconds enforces 0s to 12s bounds for user crossfade preferences', () => {
  assert.equal(clampCrossfadeSeconds(0), 0);
  assert.equal(clampCrossfadeSeconds(2), 2);
  assert.equal(clampCrossfadeSeconds(3), 3);
  assert.equal(clampCrossfadeSeconds(2.5), 2.5);
  assert.equal(clampCrossfadeSeconds(-4), 0);
  assert.equal(clampCrossfadeSeconds(25), 12);
  assert.equal(clampCrossfadeSeconds(Number.NaN), 2.5);
});

test('selectActiveYouTubeViewport prioritizes highest visible connected viewport and skips collapsed slots', () => {
  const dashboard = { name: 'dashboard', zIndex: 30, order: 1, connected: true, width: 340, height: 191 };
  const fullscreen = { name: 'fullscreen', zIndex: 60, order: 2, connected: true, width: 358, height: 201 };
  const dashboardLaterRemount = {
    name: 'dashboard-later',
    zIndex: 30,
    order: 5,
    connected: true,
    width: 340,
    height: 191,
  };
  const detachedOverlay = { name: 'detached', zIndex: 110, order: 9, connected: false, width: 300, height: 168 };
  const zeroBoxOverlay = { name: 'zero', zIndex: 110, order: 10, connected: true, width: 0, height: 0 };

  // Lower zIndex dashboard remounting later must NEVER clobber fullscreen (zIndex 60)
  const picked = selectActiveYouTubeViewport([
    dashboard,
    fullscreen,
    dashboardLaterRemount,
    detachedOverlay,
    zeroBoxOverlay,
  ]);
  assert.equal(picked?.name, 'fullscreen');

  // When fullscreen unmounts, falls back cleanly to connected visible dashboard
  const fallback = selectActiveYouTubeViewport([dashboardLaterRemount, detachedOverlay, zeroBoxOverlay]);
  assert.equal(fallback?.name, 'dashboard-later');

  // Ties at same zIndex pick the most recently mounted viewport
  const pipOlder = { name: 'pip-old', zIndex: 65, order: 3, connected: true, width: 280, height: 158 };
  const pipNewer = { name: 'pip-new', zIndex: 65, order: 7, connected: true, width: 280, height: 158 };
  assert.equal(selectActiveYouTubeViewport([pipOlder, pipNewer])?.name, 'pip-new');

  // Returns null if nothing is visible/connected
  assert.equal(selectActiveYouTubeViewport([detachedOverlay, zeroBoxOverlay]), null);
});

test('haptics engine resolves patterns for all styles and throttles rapid triggers cleanly', async () => {
  const { HAPTIC_PATTERNS, resolveHapticPattern, shouldThrottleHaptic } = await import('./haptics');

  assert.equal(resolveHapticPattern('light'), HAPTIC_PATTERNS.light);
  assert.equal(resolveHapticPattern('selection'), HAPTIC_PATTERNS.selection);
  assert.equal(resolveHapticPattern('medium'), HAPTIC_PATTERNS.medium);
  assert.equal(resolveHapticPattern('reorder'), HAPTIC_PATTERNS.reorder);
  assert.deepEqual(resolveHapticPattern('success'), HAPTIC_PATTERNS.success);

  // Rapid triggers within cooldown window (35ms) should be throttled
  assert.equal(shouldThrottleHaptic(1020, 1000, 35), true);
  // Triggers at or past cooldown window should proceed
  assert.equal(shouldThrottleHaptic(1035, 1000, 35), false);
  assert.equal(shouldThrottleHaptic(10, 0, 35), false);
});

test('shuffleQueuePreservingCurrent and restoreQueueOrder pin current track and restore exact arrangement on toggle off', () => {
  const mk = (id: string): Track => ({
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    source: 'local',
    addedAt: 1,
  });

  const original = [mk('t1'), mk('t2'), mk('t3'), mk('t4'), mk('t5')];
  const { shuffledQueue, originalOrderIds } = shuffleQueuePreservingCurrent(
    original,
    't3',
    () => 0.15
  );

  // Current track pinned first, all tracks preserved without loss
  assert.equal(shuffledQueue[0].id, 't3');
  assert.equal(shuffledQueue.length, original.length);
  assert.deepEqual(originalOrderIds, ['t1', 't2', 't3', 't4', 't5']);

  // Simulate adding a new track while shuffled and removing t2, then turning shuffle off
  const modifiedWhileShuffled = [...shuffledQueue.filter((t) => t.id !== 't2'), mk('t6')];
  const restored = restoreQueueOrder(modifiedWhileShuffled, originalOrderIds);
  assert.deepEqual(
    restored.map((t) => t.id),
    ['t1', 't3', 't4', 't5', 't6']
  );

  // Exact restoration when unmodified
  assert.deepEqual(
    restoreQueueOrder(shuffledQueue, originalOrderIds).map((t) => t.id),
    ['t1', 't2', 't3', 't4', 't5']
  );
});

test('reorderMultipleQueueItems moves multiple contiguous or non-contiguous selected tracks together cleanly', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];

  // Move non-contiguous [1 ('b'), 3 ('d')] down onto 4 ('e') -> lands right after 'e'
  assert.deepEqual(reorderMultipleQueueItems(items, [1, 3], 4, 1), ['a', 'c', 'e', 'b', 'd', 'f']);

  // Move non-contiguous [2 ('c'), 5 ('f')] up onto 0 ('a') -> lands right before 'a'
  assert.deepEqual(reorderMultipleQueueItems(items, [2, 5], 0, 5), ['c', 'f', 'a', 'b', 'd', 'e']);

  // Single selected item delegates cleanly
  assert.deepEqual(reorderMultipleQueueItems(items, [4], 1, 4), ['a', 'e', 'b', 'c', 'd', 'f']);

  // Dropping onto one of the selected indices itself is a safe no-op
  assert.deepEqual(reorderMultipleQueueItems(items, [1, 3], 3, 1), items);
});

test('selectSmartLibraryTracks prioritizes least-played user tracks over frequently played and synth stems', () => {
  const mk = (id: string, source: 'local' | 'synth'): Track => ({
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Library',
    duration: 200,
    source,
    addedAt: 1,
  });

  const library = [
    mk('heavy', 'local'),
    mk('fresh-1', 'local'),
    mk('light', 'local'),
    mk('fresh-2', 'local'),
    mk('queued-already', 'local'),
    mk('stem-1', 'synth'),
  ];
  const counts: Record<string, number> = {
    heavy: 12,
    light: 2,
    'fresh-1': 0,
    'fresh-2': 0,
    'queued-already': 0,
  };

  const picked = selectSmartLibraryTracks(
    library,
    counts,
    new Set(['queued-already']),
    4,
    () => 0.4
  );

  // Zero-play tracks appear before 2-play track, which appears before 12-play track; excluded ID skipped; synth skipped while local tracks exist
  assert.equal(picked.length, 4);
  assert.equal(picked.some((t) => t.id === 'queued-already' || t.id === 'stem-1'), false);
  assert.ok(picked.slice(0, 2).every((t) => t.id === 'fresh-1' || t.id === 'fresh-2'));
  assert.equal(picked[2].id, 'light');
  assert.equal(picked[3].id, 'heavy');
  assert.equal(picked[0].autoQueued, true);

  // Falls back to synth stems only when no user library tracks exist
  const synthOnly = selectSmartLibraryTracks([mk('stem-a', 'synth')], {}, new Set(), 3, () => 0.1);
  assert.deepEqual(
    synthOnly.map((t) => t.id),
    ['stem-a']
  );
});

test('evaluatePoorConnectionState requires continuous 30s outage while streaming and respects dismissal & recovery', () => {
  const t0 = 100_000;

  // Below 30,000ms threshold: should not prompt yet
  const at29s = evaluatePoorConnectionState({
    isStreamingTrack: true,
    isPlaying: true,
    isOnline: false,
    isBuffering: true,
    lastProgressAtMs: t0,
    badSinceMs: t0,
    nowMs: t0 + (POOR_CONNECTION_THRESHOLD_MS - 1),
    dismissedSinceMs: null,
  });
  assert.equal(at29s.shouldPromptOffline, false);
  assert.equal(at29s.nextBadSinceMs, t0);

  // At 30,000ms threshold while offline or stalled: triggers prompt
  const at30s = evaluatePoorConnectionState({
    isStreamingTrack: true,
    isPlaying: true,
    isOnline: true,
    isBuffering: false,
    lastProgressAtMs: t0,
    badSinceMs: t0,
    nowMs: t0 + POOR_CONNECTION_THRESHOLD_MS,
    dismissedSinceMs: null,
  });
  assert.equal(at30s.shouldPromptOffline, true);

  // Dismissed for current outage stays suppressed
  const afterDismiss = evaluatePoorConnectionState({
    isStreamingTrack: true,
    isPlaying: true,
    isOnline: false,
    isBuffering: true,
    lastProgressAtMs: t0,
    badSinceMs: t0,
    nowMs: t0 + 45_000,
    dismissedSinceMs: t0 + 31_000,
  });
  assert.equal(afterDismiss.shouldPromptOffline, false);

  // Recovery clears outage timer completely
  const recovered = evaluatePoorConnectionState({
    isStreamingTrack: true,
    isPlaying: true,
    isOnline: true,
    isBuffering: false,
    lastProgressAtMs: t0 + 49_000,
    badSinceMs: t0,
    nowMs: t0 + 50_000,
    dismissedSinceMs: null,
  });
  assert.equal(recovered.nextBadSinceMs, null);
  assert.equal(recovered.shouldPromptOffline, false);

  // Local offline tracks never trigger streaming poor-connection prompts
  const localPlayback = evaluatePoorConnectionState({
    isStreamingTrack: false,
    isPlaying: true,
    isOnline: false,
    isBuffering: false,
    lastProgressAtMs: t0,
    badSinceMs: t0,
    nowMs: t0 + 60_000,
    dismissedSinceMs: null,
  });
  assert.equal(localPlayback.shouldPromptOffline, false);
});

test('shouldAutoResumePlaybackPause heals spurious pauses while respecting genuine user pauses', () => {
  const now = 200_000;

  // Backgrounded pause without user pressing Pause -> auto-resume
  assert.equal(
    shouldAutoResumePlaybackPause({
      isPlaying: true,
      userPausedAt: 0,
      nowMs: now,
      visibilityState: 'hidden',
      backgroundTransitionUntil: 0,
      isIframeFocused: false,
    }),
    true
  );

  // Foreground spurious pause (e.g. "Continue watching?" / notification focus duck) -> auto-resume
  assert.equal(
    shouldAutoResumePlaybackPause({
      isPlaying: true,
      userPausedAt: 0,
      nowMs: now,
      visibilityState: 'visible',
      backgroundTransitionUntil: 0,
      isIframeFocused: false,
    }),
    true
  );

  // Foreground user click directly inside YouTube iframe -> stay paused
  assert.equal(
    shouldAutoResumePlaybackPause({
      isPlaying: true,
      userPausedAt: 0,
      nowMs: now,
      visibilityState: 'visible',
      backgroundTransitionUntil: 0,
      isIframeFocused: true,
    }),
    false
  );

  // Explicit user pause via player UI -> stay paused
  assert.equal(
    shouldAutoResumePlaybackPause({
      isPlaying: true,
      userPausedAt: now - 500,
      nowMs: now,
      visibilityState: 'hidden',
      backgroundTransitionUntil: now + 5000,
      isIframeFocused: false,
    }),
    false
  );
});

test('isPrematureStreamEnded catches truncated HTTP stream cutoffs and honors normal track completion', () => {
  // Stream cuts off at 75s out of 220s while online -> recover at 75s
  assert.equal(
    isPrematureStreamEnded({
      source: 'stream',
      currentTime: 75,
      expectedDuration: 220,
      isOnline: true,
      retriesUsed: 0,
    }),
    true
  );

  // Normal ending near song duration -> allow advance to next song
  assert.equal(
    isPrematureStreamEnded({
      source: 'stream',
      currentTime: 215,
      expectedDuration: 220,
      isOnline: true,
      retriesUsed: 0,
    }),
    false
  );

  // Local offline file or exhausted retries -> do not loop
  assert.equal(
    isPrematureStreamEnded({
      source: 'local',
      currentTime: 75,
      expectedDuration: 220,
      isOnline: true,
      retriesUsed: 0,
    }),
    false
  );
  assert.equal(
    isPrematureStreamEnded({
      source: 'stream',
      currentTime: 75,
      expectedDuration: 220,
      isOnline: true,
      retriesUsed: 2,
    }),
    false
  );
});

test('evaluatePlaybackWatchdog heals suspended AudioContext, spurious pauses, and mid-song stalls', () => {
  const now = 500_000;

  // Suspended Web Audio Context mid-song -> resume_context immediately
  assert.equal(
    evaluatePlaybackWatchdog({
      isPlaying: true,
      isCrossfading: false,
      userPausedAt: 0,
      nowMs: now,
      audioContextState: 'suspended',
      source: 'local',
      isYouTube: false,
      audioPaused: false,
      audioEnded: false,
      currentTime: 42,
      lastProgressAtMs: now - 500,
      isOnline: true,
      nudgeCount: 0,
      recoverCount: 0,
      lastNudgeAtMs: 0,
      lastRecoverAtMs: 0,
    }),
    'resume_context'
  );

  // YouTube unexpectedly enters PAUSED(2) without user click -> nudge_resume
  assert.equal(
    evaluatePlaybackWatchdog({
      isPlaying: true,
      isCrossfading: false,
      userPausedAt: 0,
      nowMs: now,
      source: 'stream',
      isYouTube: true,
      ytPlayerState: 2,
      isIframeFocused: false,
      currentTime: 65,
      lastProgressAtMs: now - 1000,
      isOnline: true,
      nudgeCount: 0,
      recoverCount: 0,
      lastNudgeAtMs: 0,
      lastRecoverAtMs: 0,
    }),
    'nudge_resume'
  );

  // Moderate 7s YouTube freeze while online -> nudge_resume
  assert.equal(
    evaluatePlaybackWatchdog({
      isPlaying: true,
      isCrossfading: false,
      userPausedAt: 0,
      nowMs: now,
      source: 'stream',
      isYouTube: true,
      ytPlayerState: 3,
      currentTime: 90,
      lastProgressAtMs: now - STALL_NUDGE_MS,
      isOnline: true,
      nudgeCount: 0,
      recoverCount: 0,
      lastNudgeAtMs: 0,
      lastRecoverAtMs: 0,
    }),
    'nudge_resume'
  );

  // Severe 15s stream stall after nudges -> recover_stream
  assert.equal(
    evaluatePlaybackWatchdog({
      isPlaying: true,
      isCrossfading: false,
      userPausedAt: 0,
      nowMs: now,
      source: 'stream',
      isYouTube: true,
      ytPlayerState: 3,
      currentTime: 90,
      lastProgressAtMs: now - STALL_RECOVER_MS,
      isOnline: true,
      nudgeCount: 2,
      recoverCount: 0,
      lastNudgeAtMs: now - 6000,
      lastRecoverAtMs: 0,
    }),
    'recover_stream'
  );

  // Severe 15s local audio stall -> reload_audio_at_position
  assert.equal(
    evaluatePlaybackWatchdog({
      isPlaying: true,
      isCrossfading: false,
      userPausedAt: 0,
      nowMs: now,
      audioContextState: 'running',
      source: 'local',
      isYouTube: false,
      audioPaused: false,
      audioEnded: false,
      audioReadyState: 1,
      currentTime: 112,
      lastProgressAtMs: now - STALL_RECOVER_MS,
      isOnline: false,
      nudgeCount: 1,
      recoverCount: 0,
      lastNudgeAtMs: now - 6000,
      lastRecoverAtMs: 0,
    }),
    'reload_audio_at_position'
  );
});



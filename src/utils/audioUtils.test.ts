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
  buildRadioSeedQuery,
  extractYouTubeRelatedResults,
  extractYouTubeSearchResults,
  isIndividualSong,
  mergeAutoplayQueue,
  parseYouTubeArtistAndTitle,
  parseYouTubeDuration,
  parseYouTubeSuggestResponse,
  parseYouTubeViewCount,
  rankYouTubeSearchResults,
  sortStudioQueue,
} from './streamFilter';
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
    assert.ok(manifest.includes('FOREGROUND_SERVICE_MEDIA_PLAYBACK'));
    assert.ok(manifest.includes('POST_NOTIFICATIONS'));
    assert.ok(manifest.includes('android:supportsPictureInPicture="true"'));
    assert.ok(manifest.includes('.KaGoMediaService'));
    assert.ok(manifest.includes('smallestScreenSize'));

    const gradle = fs.readFileSync(path.join(tmpRoot, 'android', 'app', 'build.gradle'), 'utf8');
    assert.equal(gradle.match(/androidx\.media:media:1\.7\.0/g)?.length, 1);
    assert.equal(gradle.match(/JavaVersion\.VERSION_17/g)?.length, 2);

    assert.ok(fs.existsSync(path.join(androidMain, 'java', 'com', 'kagoplay', 'workstation', 'MainActivity.java')));
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

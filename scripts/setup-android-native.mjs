import fs from 'node:fs';
import path from 'node:path';

export function applyAndroidNativeOverrides(rootDir = process.cwd()) {
  const androidMainDir = path.join(rootDir, 'android', 'app', 'src', 'main');
  const packageJavaDir = path.join(androidMainDir, 'java', 'com', 'kagoplay', 'workstation');
  const nativeSrcDir = path.join(rootDir, 'android-native', 'java', 'com', 'kagoplay', 'workstation');

  if (!fs.existsSync(androidMainDir)) {
    throw new Error(`Android project not found at ${androidMainDir}`);
  }

  fs.mkdirSync(packageJavaDir, { recursive: true });
  for (const file of ['MainActivity.java', 'KaGoMediaService.java']) {
    const src = path.join(nativeSrcDir, file);
    const dst = path.join(packageJavaDir, file);
    fs.copyFileSync(src, dst);
  }

  // Patch AndroidManifest.xml idempotently
  const manifestPath = path.join(androidMainDir, 'AndroidManifest.xml');
  let manifest = fs.readFileSync(manifestPath, 'utf8');

  const permissions = [
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  ];

  for (const perm of permissions) {
    const nameMatch = perm.match(/android:name="([^"]+)"/);
    if (nameMatch && !manifest.includes(nameMatch[1])) {
      manifest = manifest.replace('<application', `    ${perm}\n\n    <application`);
    }
  }

  // Enable hardware acceleration for smooth WebView video & PiP playback
  manifest = manifest.replace(/<application([^>]*)>/, (full, attrs) => {
    if (attrs.includes('android:hardwareAccelerated')) return full;
    return `<application${attrs}\n        android:hardwareAccelerated="true">`;
  });

  // Enable Picture-in-Picture and resizeableActivity on MainActivity
  if (!manifest.includes('android:supportsPictureInPicture')) {
    manifest = manifest.replace(
      /<activity([^>]*android:name="(?:\.|com\.kagoplay\.workstation\.)MainActivity"[^>]*)>/,
      (_full, attrs) => {
        let updatedAttrs = attrs;
        if (!updatedAttrs.includes('supportsPictureInPicture')) {
          updatedAttrs += '\n            android:supportsPictureInPicture="true"';
        }
        if (!updatedAttrs.includes('resizeableActivity')) {
          updatedAttrs += '\n            android:resizeableActivity="true"';
        }
        if (updatedAttrs.includes('android:configChanges=')) {
          updatedAttrs = updatedAttrs.replace(
            /android:configChanges="([^"]*)"/,
            (_m, existing) => {
              const parts = new Set(existing.split('|').filter(Boolean));
              parts.add('orientation');
              parts.add('screenSize');
              parts.add('smallestScreenSize');
              parts.add('screenLayout');
              parts.add('keyboardHidden');
              return `android:configChanges="${Array.from(parts).join('|')}"`;
            }
          );
        }
        return `<activity${updatedAttrs}>`;
      }
    );
  }

  // Register KaGoMediaService and MediaButtonReceiver
  if (!manifest.includes('.KaGoMediaService')) {
    const serviceBlock = `
        <service
            android:name=".KaGoMediaService"
            android:exported="true"
            android:stopWithTask="false"
            android:foregroundServiceType="mediaPlayback">
            <intent-filter>
                <action android:name="android.intent.action.MEDIA_BUTTON" />
            </intent-filter>
        </service>

        <receiver
            android:name="androidx.media.session.MediaButtonReceiver"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MEDIA_BUTTON" />
            </intent-filter>
        </receiver>
    </application>`;
    manifest = manifest.replace('</application>', serviceBlock);
  }

  fs.writeFileSync(manifestPath, manifest, 'utf8');

  // Patch android/app/build.gradle to ensure androidx.media:media:1.7.0 and Java 17 compileOptions
  const appGradlePath = path.join(rootDir, 'android', 'app', 'build.gradle');
  if (fs.existsSync(appGradlePath)) {
    let gradle = fs.readFileSync(appGradlePath, 'utf8');
    let changed = false;
    if (!gradle.includes('compileOptions')) {
      gradle = gradle.replace(
        /android\s*\{/,
        'android {\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n    }'
      );
      changed = true;
    }
    if (!gradle.includes('androidx.media:media')) {
      gradle = gradle.replace(
        /dependencies\s*\{/,
        'dependencies {\n    implementation "androidx.media:media:1.7.0"'
      );
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(appGradlePath, gradle, 'utf8');
    }
  }

  // Patch variables.gradle to SDK 34 cleanly
  const varsGradlePath = path.join(rootDir, 'android', 'variables.gradle');
  if (fs.existsSync(varsGradlePath)) {
    let vars = fs.readFileSync(varsGradlePath, 'utf8');
    vars = vars
      .replace(/compileSdkVersion\s*=\s*\d+/g, 'compileSdkVersion = 34')
      .replace(/targetSdkVersion\s*=\s*\d+/g, 'targetSdkVersion = 34');
    fs.writeFileSync(varsGradlePath, vars, 'utf8');
  }

  return {
    manifestPath,
    packageJavaDir,
    appGradlePath,
  };
}

const isCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]));

if (isCli) {
  const res = applyAndroidNativeOverrides(process.cwd());
  console.log('Applied Android native MediaSession, Samsung Now Bar, and PiP config:', res);
}

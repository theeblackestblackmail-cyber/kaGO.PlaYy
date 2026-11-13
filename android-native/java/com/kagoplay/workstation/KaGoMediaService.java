package com.kagoplay.workstation;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class KaGoMediaService extends Service {
    public static final String CHANNEL_ID = "kago_playback_channel";
    public static final int NOTIFICATION_ID = 7401;

    public static final String ACTION_UPDATE_MEDIA = "com.kagoplay.workstation.UPDATE_MEDIA";
    public static final String ACTION_STOP_SERVICE = "com.kagoplay.workstation.STOP_SERVICE";

    public static volatile boolean isCurrentlyPlaying = false;
    private static volatile boolean isServiceRunning = false;

    private MediaSessionCompat mediaSession;
    private PowerManager.WakeLock wakeLock;
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();

    private String currentTitle = "kaGO.PIaY";
    private String currentArtist = "Offline Audio Engine";
    private String currentAlbum = "Workstation";
    private long currentDurationMs = 180000L;
    private long currentPositionMs = 0L;
    private boolean currentIsPlaying = false;
    private String currentArtworkUrl = "";
    private String cachedArtworkUrl = "";
    private Bitmap cachedArtworkBitmap = null;

    public static boolean isRunning() {
        return isServiceRunning;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        isServiceRunning = true;
        createNotificationChannel();

        mediaSession = new MediaSessionCompat(this, "kaGO_PIaY_Session");
        mediaSession.setFlags(
            MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
            MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
        );

        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                MainActivity.dispatchMediaActionToWeb("play", 0L);
            }

            @Override
            public void onPause() {
                MainActivity.dispatchMediaActionToWeb("pause", 0L);
            }

            @Override
            public void onSkipToNext() {
                MainActivity.dispatchMediaActionToWeb("next", 0L);
            }

            @Override
            public void onSkipToPrevious() {
                MainActivity.dispatchMediaActionToWeb("prev", 0L);
            }

            @Override
            public void onSeekTo(long pos) {
                currentPositionMs = Math.max(0L, pos);
                updatePlaybackState();
                MainActivity.dispatchMediaActionToWeb("seek", pos);
            }

            @Override
            public void onStop() {
                isCurrentlyPlaying = false;
                currentIsPlaying = false;
                updatePlaybackState();
                releaseWakeLock();
                stopForegroundCompat(true);
                stopSelf();
            }
        });

        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            MediaButtonReceiver.handleIntent(mediaSession, intent);

            String action = intent.getAction();
            if (ACTION_STOP_SERVICE.equals(action)) {
                isCurrentlyPlaying = false;
                currentIsPlaying = false;
                releaseWakeLock();
                stopForegroundCompat(true);
                stopSelf();
                return START_NOT_STICKY;
            }

            if (ACTION_UPDATE_MEDIA.equals(action)) {
                currentTitle = safeString(intent.getStringExtra("title"), "kaGO.PIaY");
                currentArtist = safeString(intent.getStringExtra("artist"), "Offline Audio Engine");
                currentAlbum = safeString(intent.getStringExtra("album"), "Workstation");
                currentDurationMs = Math.max(0L, intent.getLongExtra("durationMs", 180000L));
                currentPositionMs = Math.max(0L, intent.getLongExtra("positionMs", 0L));
                currentIsPlaying = intent.getBooleanExtra("isPlaying", false);
                currentArtworkUrl = safeString(intent.getStringExtra("artworkUrl"), "");
                isCurrentlyPlaying = currentIsPlaying;

                if (currentIsPlaying) {
                    acquireWakeLock();
                } else {
                    releaseWakeLock();
                }

                updateMediaMetadata();
                updatePlaybackState();
                postForegroundNotification();
                fetchArtworkAsyncIfNeeded(currentArtworkUrl);
            }
        }
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!isCurrentlyPlaying) {
            stopForegroundCompat(true);
            stopSelf();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        isServiceRunning = false;
        isCurrentlyPlaying = false;
        releaseWakeLock();
        artworkExecutor.shutdownNow();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "kaGO.PIaY Media Playback",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Playback controls for Lock Screen and Samsung Now Bar");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void updateMediaMetadata() {
        MediaMetadataCompat.Builder builder = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, currentAlbum)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDurationMs);

        if (cachedArtworkBitmap != null) {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cachedArtworkBitmap);
        }
        mediaSession.setMetadata(builder.build());
    }

    private void updatePlaybackState() {
        int state = currentIsPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
        long actions =
            PlaybackStateCompat.ACTION_PLAY |
            PlaybackStateCompat.ACTION_PAUSE |
            PlaybackStateCompat.ACTION_PLAY_PAUSE |
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
            PlaybackStateCompat.ACTION_SEEK_TO |
            PlaybackStateCompat.ACTION_STOP;

        PlaybackStateCompat playbackState = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(state, currentPositionMs, currentIsPlaying ? 1.0f : 0.0f)
            .build();
        mediaSession.setPlaybackState(playbackState);
    }

    private void postForegroundNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, pendingFlags);

        PendingIntent prevPending = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this,
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        );
        PendingIntent togglePending = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this,
            PlaybackStateCompat.ACTION_PLAY_PAUSE
        );
        PendingIntent nextPending = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this,
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        );

        int toggleIcon = currentIsPlaying
            ? android.R.drawable.ic_media_pause
            : android.R.drawable.ic_media_play;
        String toggleLabel = currentIsPlaying ? "Pause" : "Play";

        int smallIcon = getApplicationInfo().icon != 0
            ? getApplicationInfo().icon
            : android.R.drawable.ic_media_play;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setSubText(currentAlbum)
            .setSmallIcon(smallIcon)
            .setContentIntent(contentIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setOngoing(currentIsPlaying)
            .setShowWhen(false)
            .addAction(android.R.drawable.ic_media_previous, "Previous", prevPending)
            .addAction(toggleIcon, toggleLabel, togglePending)
            .addAction(android.R.drawable.ic_media_next, "Next", nextPending)
            .setStyle(
                new MediaStyle()
                    .setMediaSession(mediaSession.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2)
            );

        if (cachedArtworkBitmap != null) {
            builder.setLargeIcon(cachedArtworkBitmap);
        }

        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void fetchArtworkAsyncIfNeeded(final String url) {
        if (url == null || url.isEmpty() || url.equals(cachedArtworkUrl)) {
            return;
        }
        cachedArtworkUrl = url;
        artworkExecutor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                conn.setDoInput(true);
                conn.connect();
                try (InputStream is = conn.getInputStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(is);
                    if (bmp != null && url.equals(currentArtworkUrl)) {
                        cachedArtworkBitmap = bmp;
                        updateMediaMetadata();
                        postForegroundNotification();
                    }
                }
            } catch (Exception ignored) {
                // Keep notification active without artwork
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kaGOPIaY::AudioEngineWakeLock");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire(4 * 60 * 60 * 1000L);
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {
            }
        }
    }

    private void stopForegroundCompat(boolean removeNotification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(removeNotification ? STOP_FOREGROUND_REMOVE : STOP_FOREGROUND_DETACH);
        } else {
            stopForeground(removeNotification);
        }
    }

    private static String safeString(String val, String fallback) {
        return (val != null && !val.trim().isEmpty()) ? val : fallback;
    }
}

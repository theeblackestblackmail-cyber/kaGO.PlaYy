package com.kagoplay.workstation;

import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {
    private static final int REQ_POST_NOTIFICATIONS = 8801;
    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);

    private volatile boolean isVideoModeActive = false;
    private boolean bridgeAttached = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);
        attachNativeBridge();
    }

    @Override
    public void onStart() {
        super.onStart();
        activeInstance = new WeakReference<>(this);
        attachNativeBridge();
    }

    private void attachNativeBridge() {
        if (bridgeAttached || getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new KaGoNativeBridge(), "KaGoNative");
        bridgeAttached = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        // Keep WebView audio/JS active when minimized or screen-locked while music plays
        if (KaGoMediaService.isCurrentlyPlaying && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onResume();
            getBridge().getWebView().resumeTimers();
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        if (KaGoMediaService.isCurrentlyPlaying && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onResume();
            getBridge().getWebView().resumeTimers();
        }
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            if (isVideoModeActive && KaGoMediaService.isCurrentlyPlaying) {
                enterPipInternal();
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        dispatchJsEvent("kago-native-pip", "{\"active\":" + isInPictureInPictureMode + "}");
    }

    public static void dispatchMediaActionToWeb(String action, long positionMs) {
        MainActivity activity = activeInstance.get();
        if (activity == null) return;
        String detail = "{\"action\":\"" + action + "\",\"positionMs\":" + positionMs + "}";
        activity.dispatchJsEvent("kago-native-media", detail);
    }

    private void dispatchJsEvent(final String eventName, final String detailJson) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final WebView webView = getBridge().getWebView();
        webView.post(() -> {
            String js = "window.dispatchEvent(new CustomEvent('" + eventName + "',{detail:" + detailJson + "}));";
            webView.evaluateJavascript(js, null);
        });
    }

    private void enterPipInternal() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                return;
            }
            PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(16, 9));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(isVideoModeActive);
            }
            try {
                enterPictureInPictureMode(builder.build());
            } catch (Exception ignored) {
            }
        }
    }

    private void updateAutoPipParams(boolean videoActive) {
        isVideoModeActive = videoActive;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                return;
            }
            try {
                PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(16, 9))
                    .setAutoEnterEnabled(videoActive)
                    .build();
                setPictureInPictureParams(params);
            } catch (Exception ignored) {
            }
        }
    }

    private class KaGoNativeBridge {
        @JavascriptInterface
        public void updateNowPlaying(
            final String title,
            final String artist,
            final String album,
            final long durationMs,
            final long positionMs,
            final boolean isPlaying,
            final String artworkUrl
        ) {
            KaGoMediaService.isCurrentlyPlaying = isPlaying;
            Intent intent = new Intent(MainActivity.this, KaGoMediaService.class);
            intent.setAction(KaGoMediaService.ACTION_UPDATE_MEDIA);
            intent.putExtra("title", title);
            intent.putExtra("artist", artist);
            intent.putExtra("album", album);
            intent.putExtra("durationMs", durationMs);
            intent.putExtra("positionMs", positionMs);
            intent.putExtra("isPlaying", isPlaying);
            intent.putExtra("artworkUrl", artworkUrl);

            try {
                if (isPlaying || KaGoMediaService.isRunning()) {
                    ContextCompat.startForegroundService(MainActivity.this, intent);
                }
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void stopBackgroundService() {
            KaGoMediaService.isCurrentlyPlaying = false;
            Intent intent = new Intent(MainActivity.this, KaGoMediaService.class);
            intent.setAction(KaGoMediaService.ACTION_STOP_SERVICE);
            try {
                startService(intent);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void enterPipMode() {
            runOnUiThread(() -> enterPipInternal());
        }

        @JavascriptInterface
        public void setVideoModeActive(final boolean active) {
            runOnUiThread(() -> updateAutoPipParams(active));
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            if (Build.VERSION.SDK_INT >= 33) {
                runOnUiThread(() -> {
                    if (
                        ContextCompat.checkSelfPermission(
                            MainActivity.this,
                            "android.permission.POST_NOTIFICATIONS"
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        ActivityCompat.requestPermissions(
                            MainActivity.this,
                            new String[]{"android.permission.POST_NOTIFICATIONS"},
                            REQ_POST_NOTIFICATIONS
                        );
                    }
                });
            }
        }
    }
}

package com.kagoplay.workstation;

import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Rational;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final int REQ_POST_NOTIFICATIONS = 8801;
    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);

    private volatile boolean isVideoModeActive = false;
    private boolean bridgeAttached = false;
    private final ExecutorService networkExecutor = Executors.newFixedThreadPool(4);

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

    @Override
    public void onDestroy() {
        super.onDestroy();
        networkExecutor.shutdownNow();
    }

    private void attachNativeBridge() {
        if (bridgeAttached || getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        String ua = settings.getUserAgentString();
        if (ua != null && ua.contains("; wv")) {
            settings.setUserAgentString(ua.replace("; wv", ""));
        }
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

    private static String escapeJsonString(String input) {
        if (input == null) return "";
        return input
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "")
            .replace("\r", "");
    }

    private static boolean isAllowedFetchUrl(String urlString) {
        if (urlString == null) return false;
        return urlString.startsWith("https://www.youtube.com/")
            || urlString.startsWith("https://m.youtube.com/")
            || urlString.startsWith("https://suggestqueries.google.com/")
            || urlString.startsWith("https://api.audius.co/");
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

        @JavascriptInterface
        public void fetchUrlAsync(final String requestId, final String urlString) {
            if (!isAllowedFetchUrl(urlString)) {
                String errJson = "{\"requestId\":\"" + escapeJsonString(requestId)
                    + "\",\"ok\":false,\"status\":403,\"bodyBase64\":\"\"}";
                dispatchJsEvent("kago-native-http", errJson);
                return;
            }

            networkExecutor.execute(() -> {
                HttpURLConnection conn = null;
                int status = 0;
                try {
                    URL url = new URL(urlString);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(7000);
                    conn.setReadTimeout(8000);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty(
                        "User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
                    );
                    conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                    conn.setRequestProperty("Cookie", "SOCS=CAI");

                    status = conn.getResponseCode();
                    InputStream stream = (status >= 200 && status < 400)
                        ? conn.getInputStream()
                        : conn.getErrorStream();

                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    if (stream != null) {
                        byte[] chunk = new byte[8192];
                        int total = 0;
                        int read;
                        while ((read = stream.read(chunk)) != -1) {
                            buffer.write(chunk, 0, read);
                            total += read;
                            if (total >= 4 * 1024 * 1024) break;
                        }
                        stream.close();
                    }

                    byte[] rawBytes = buffer.toByteArray();
                    String b64 = Base64.encodeToString(rawBytes, Base64.NO_WRAP);
                    boolean ok = status >= 200 && status < 300;
                    String detail = "{\"requestId\":\"" + escapeJsonString(requestId)
                        + "\",\"ok\":" + ok
                        + ",\"status\":" + status
                        + ",\"bodyBase64\":\"" + b64 + "\"}";
                    dispatchJsEvent("kago-native-http", detail);
                } catch (Exception ex) {
                    String emptyB64 = Base64.encodeToString("".getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                    String detail = "{\"requestId\":\"" + escapeJsonString(requestId)
                        + "\",\"ok\":false,\"status\":" + status
                        + ",\"bodyBase64\":\"" + emptyB64 + "\"}";
                    dispatchJsEvent("kago-native-http", detail);
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            });
        }
    }
}

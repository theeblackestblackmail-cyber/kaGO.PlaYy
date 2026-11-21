package com.kagoplay.workstation;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Rational;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    private static final int REQ_POST_NOTIFICATIONS = 8801;
    private static final int REQ_PICK_FOLDER = 8802;
    private static final int MAX_FOLDER_SCAN_DEPTH = 10;
    private static final int MAX_FOLDER_AUDIO_FILES = 500;
    private static final Pattern AUDIO_EXT_PATTERN =
        Pattern.compile("\\.(mp3|flac|wav|ogg|m4a|aac|opus|webm|wma|aiff)$", Pattern.CASE_INSENSITIVE);

    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);

    private volatile boolean isVideoModeActive = false;
    private boolean bridgeAttached = false;
    private volatile String pendingFolderRequestId = null;
    private final ExecutorService networkExecutor = Executors.newFixedThreadPool(4);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Set<String> allowedDocumentUris =
        Collections.newSetFromMap(new ConcurrentHashMap<>());

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
    public void onResume() {
        super.onResume();
        mainHandler.removeCallbacksAndMessages(null);
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                } catch (Exception ignored) {
                }
            }
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            } catch (Exception ignored) {
            }
        }
        String ua = settings.getUserAgentString();
        if (ua != null && ua.contains("; wv")) {
            settings.setUserAgentString(ua.replace("; wv", ""));
        }
        webView.addJavascriptInterface(new KaGoNativeBridge(), "KaGoNative");
        bridgeAttached = true;
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FOLDER) {
            final String reqId = pendingFolderRequestId;
            pendingFolderRequestId = null;
            if (reqId == null) return;

            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
                emitFolderEvent(reqId, false, true, "", new JSONArray(), "");
                return;
            }

            final Uri treeUri = data.getData();
            try {
                getContentResolver().takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception ignored) {
            }

            networkExecutor.execute(() -> scanDocumentTreeAndEmit(reqId, treeUri));
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void scanDocumentTreeAndEmit(String requestId, Uri treeUri) {
        try {
            String treeDocId = DocumentsContract.getTreeDocumentId(treeUri);
            String rootFolder = "Picked Folder";
            try {
                Uri treeDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId);
                try (Cursor rootCursor = getContentResolver().query(
                    treeDocUri,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                    null,
                    null,
                    null
                )) {
                    if (rootCursor != null && rootCursor.moveToFirst()) {
                        String displayName = rootCursor.getString(0);
                        if (displayName != null && !displayName.trim().isEmpty()) {
                            rootFolder = displayName.trim();
                        }
                    }
                }
            } catch (Exception ignored) {
            }

            if ("Picked Folder".equals(rootFolder) && treeDocId != null) {
                int colon = treeDocId.lastIndexOf(':');
                String rel = colon >= 0 ? treeDocId.substring(colon + 1) : treeDocId;
                if (!rel.isEmpty()) {
                    String[] segs = rel.split("/");
                    for (int i = segs.length - 1; i >= 0; i--) {
                        if (!segs[i].isEmpty()) {
                            rootFolder = segs[i];
                            break;
                        }
                    }
                }
            }

            String[] projection = new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            };

            JSONArray filesArray = new JSONArray();
            Set<String> visitedDocs = new HashSet<>();
            Deque<String[]> queue = new ArrayDeque<>();
            queue.add(new String[]{treeDocId, rootFolder, "0"});

            while (!queue.isEmpty() && filesArray.length() < MAX_FOLDER_AUDIO_FILES) {
                String[] node = queue.poll();
                if (node == null) continue;
                String currentDocId = node[0];
                String currentPath = node[1];
                int depth = Integer.parseInt(node[2]);

                if (currentDocId == null || !visitedDocs.add(currentDocId)) continue;

                Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, currentDocId);
                try (Cursor cursor = getContentResolver().query(childrenUri, projection, null, null, null)) {
                    if (cursor == null) continue;
                    int idxId = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
                    int idxName = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                    int idxMime = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
                    int idxSize = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                    int idxMod = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);

                    while (cursor.moveToNext() && filesArray.length() < MAX_FOLDER_AUDIO_FILES) {
                        String childId = idxId >= 0 ? cursor.getString(idxId) : null;
                        String name = idxName >= 0 ? cursor.getString(idxName) : null;
                        String mime = idxMime >= 0 ? cursor.getString(idxMime) : null;
                        long size = (idxSize >= 0 && !cursor.isNull(idxSize)) ? cursor.getLong(idxSize) : 0L;
                        long lastMod = (idxMod >= 0 && !cursor.isNull(idxMod)) ? cursor.getLong(idxMod) : System.currentTimeMillis();

                        if (childId == null || name == null || name.startsWith(".")) continue;

                        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                            if (depth < MAX_FOLDER_SCAN_DEPTH) {
                                queue.add(new String[]{
                                    childId,
                                    currentPath + "/" + name,
                                    String.valueOf(depth + 1)
                                });
                            }
                            continue;
                        }

                        String lowerMime = mime != null ? mime.toLowerCase(Locale.US) : "";
                        boolean isAudio =
                            lowerMime.startsWith("audio/") ||
                            "application/ogg".equals(lowerMime) ||
                            "application/flac".equals(lowerMime) ||
                            AUDIO_EXT_PATTERN.matcher(name).find();

                        if (!isAudio) continue;

                        Uri childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childId);
                        String uriString = childUri.toString();
                        allowedDocumentUris.add(uriString);

                        JSONObject fileObj = new JSONObject();
                        fileObj.put("uri", uriString);
                        fileObj.put("name", name);
                        fileObj.put("mimeType", lowerMime.isEmpty() ? "audio/mpeg" : lowerMime);
                        fileObj.put("size", size);
                        fileObj.put("lastModified", lastMod);
                        fileObj.put("folderPath", currentPath);
                        filesArray.put(fileObj);
                    }
                } catch (Exception ignored) {
                }
            }

            emitFolderEvent(requestId, true, false, rootFolder, filesArray, "");
        } catch (Exception ex) {
            emitFolderEvent(
                requestId,
                false,
                false,
                "",
                new JSONArray(),
                ex.getMessage() != null ? ex.getMessage() : "Unable to read folder contents."
            );
        }
    }

    private void emitFolderEvent(
        String requestId,
        boolean ok,
        boolean cancelled,
        String rootFolder,
        JSONArray files,
        String error
    ) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("requestId", requestId);
            payload.put("ok", ok);
            payload.put("cancelled", cancelled);
            payload.put("rootFolder", rootFolder);
            payload.put("files", files);
            payload.put("error", error);
            dispatchJsEvent("kago-native-folder", payload.toString());
        } catch (Exception ignored) {
        }
    }

    private boolean isInPipCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            return isInPictureInPictureMode();
        }
        return false;
    }

    private void keepWebViewAwakeNow() {
        if (isFinishing() || isDestroyed()) return;
        if (!KaGoMediaService.isCurrentlyPlaying || getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        WebView webView = getBridge().getWebView();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
            webView.onResume();
            webView.resumeTimers();
            if (!isInPipCompat()) {
                webView.dispatchWindowVisibilityChanged(View.VISIBLE);
            }
        } catch (Exception ignored) {
        }
    }

    private void scheduleBackgroundKeepalive(final String phase) {
        if (isFinishing() || isChangingConfigurations() || !KaGoMediaService.isCurrentlyPlaying) {
            return;
        }
        keepWebViewAwakeNow();
        dispatchJsEvent("kago-native-keepalive", "{\"phase\":\"" + phase + "\"}");

        final long[] delays = new long[]{160L, 520L, 1200L, 2400L};
        for (final long delay : delays) {
            mainHandler.postDelayed(() -> {
                if (isFinishing() || isDestroyed() || !KaGoMediaService.isCurrentlyPlaying) return;
                keepWebViewAwakeNow();
                dispatchJsEvent("kago-native-keepalive", "{\"phase\":\"" + phase + "_retry\"}");
            }, delay);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Keep WebView audio/JS active when minimized or switching apps while music plays
        scheduleBackgroundKeepalive("pause");
    }

    @Override
    public void onStop() {
        super.onStop();
        scheduleBackgroundKeepalive("stop");
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

    public static void pingBackgroundKeepalive() {
        MainActivity activity = activeInstance.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        activity.mainHandler.post(() -> {
            if (!KaGoMediaService.isCurrentlyPlaying) return;
            activity.keepWebViewAwakeNow();
            activity.dispatchJsEvent("kago-native-keepalive", "{\"phase\":\"service_heartbeat\"}");
        });
    }

    private void dispatchJsEvent(final String eventName, final String detailJson) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final WebView webView = getBridge().getWebView();
        final String safeJson = detailJson
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029");
        webView.post(() -> {
            try {
                webView.onResume();
                webView.resumeTimers();
            } catch (Exception ignored) {
            }
            String js = "window.dispatchEvent(new CustomEvent('" + eventName + "',{detail:" + safeJson + "}));";
            webView.evaluateJavascript(js, null);
        });
    }

    private static boolean isAllowedFetchUrl(String urlString) {
        if (urlString == null) return false;
        return urlString.startsWith("https://www.youtube.com/")
            || urlString.startsWith("https://m.youtube.com/")
            || urlString.startsWith("https://music.youtube.com/")
            || urlString.startsWith("https://youtubei.googleapis.com/")
            || urlString.startsWith("https://suggestqueries.google.com/")
            || urlString.startsWith("https://api.audius.co/")
            || urlString.startsWith("https://lrclib.net/");
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
        public void triggerHaptic(final String style) {
            runOnUiThread(() -> {
                try {
                    WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                    int feedbackConst = HapticFeedbackConstants.CLOCK_TICK;
                    long durationMs = 12L;
                    if ("selection".equals(style)) {
                        feedbackConst = HapticFeedbackConstants.CONTEXT_CLICK;
                        durationMs = 15L;
                    } else if ("medium".equals(style)) {
                        feedbackConst = HapticFeedbackConstants.VIRTUAL_KEY;
                        durationMs = 20L;
                    } else if ("reorder".equals(style)) {
                        feedbackConst = HapticFeedbackConstants.LONG_PRESS;
                        durationMs = 24L;
                    } else if ("success".equals(style)) {
                        feedbackConst = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? HapticFeedbackConstants.CONFIRM
                            : HapticFeedbackConstants.VIRTUAL_KEY;
                        durationMs = 22L;
                    }

                    boolean performed = false;
                    if (webView != null) {
                        performed = webView.performHapticFeedback(
                            feedbackConst,
                            HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING
                        );
                    }
                    if (!performed) {
                        Vibrator vibrator = null;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                            if (vm != null) {
                                vibrator = vm.getDefaultVibrator();
                            }
                        } else {
                            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                        }
                        if (vibrator != null && vibrator.hasVibrator()) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE));
                            } else {
                                vibrator.vibrate(durationMs);
                            }
                        }
                    }
                } catch (Exception ignored) {
                }
            });
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
        public void pickFolderNative(final String requestId) {
            pendingFolderRequestId = requestId;
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    intent.addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                    );
                    intent.putExtra("android.provider.extra.SHOW_ADVANCED", true);
                    startActivityForResult(intent, REQ_PICK_FOLDER);
                } catch (Exception ex) {
                    pendingFolderRequestId = null;
                    emitFolderEvent(
                        requestId,
                        false,
                        false,
                        "",
                        new JSONArray(),
                        "Native folder picker unavailable."
                    );
                }
            });
        }

        @JavascriptInterface
        public String readDocumentChunkBase64(
            final String uriString,
            final long offset,
            final int length
        ) {
            if (uriString == null || !allowedDocumentUris.contains(uriString) || length <= 0) {
                return "";
            }
            int safeLength = Math.min(length, 4 * 1024 * 1024);
            try (InputStream stream = getContentResolver().openInputStream(Uri.parse(uriString))) {
                if (stream == null) return "";

                long remaining = Math.max(0L, offset);
                byte[] drain = new byte[8192];
                while (remaining > 0) {
                    long skipped = stream.skip(remaining);
                    if (skipped > 0) {
                        remaining -= skipped;
                    } else {
                        int read = stream.read(drain, 0, (int) Math.min(drain.length, remaining));
                        if (read <= 0) break;
                        remaining -= read;
                    }
                }

                byte[] chunk = new byte[safeLength];
                int totalRead = 0;
                while (totalRead < safeLength) {
                    int n = stream.read(chunk, totalRead, safeLength - totalRead);
                    if (n <= 0) break;
                    totalRead += n;
                }
                if (totalRead <= 0) return "";
                return Base64.encodeToString(chunk, 0, totalRead, Base64.NO_WRAP);
            } catch (Exception ex) {
                return "";
            }
        }

        @JavascriptInterface
        public void fetchUrlAsync(final String requestId, final String urlString) {
            executeHttpRequestAsync(requestId, urlString, "GET", null);
        }

        @JavascriptInterface
        public void fetchUrlPostAsync(
            final String requestId,
            final String urlString,
            final String jsonBody
        ) {
            executeHttpRequestAsync(requestId, urlString, "POST", jsonBody);
        }

        private void executeHttpRequestAsync(
            final String requestId,
            final String urlString,
            final String method,
            final String jsonBody
        ) {
            if (!isAllowedFetchUrl(urlString)) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("requestId", requestId);
                    err.put("ok", false);
                    err.put("status", 403);
                    err.put("bodyBase64", "");
                    dispatchJsEvent("kago-native-http", err.toString());
                } catch (Exception ignored) {
                }
                return;
            }

            networkExecutor.execute(() -> {
                HttpURLConnection conn = null;
                int status = 0;
                try {
                    URL url = new URL(urlString);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(7500);
                    conn.setReadTimeout(9500);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestMethod(method);
                    conn.setRequestProperty(
                        "User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
                    );
                    conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                    conn.setRequestProperty(
                        "Cookie",
                        "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwODE0LjA3X3AwGgJlbiACGgYIgJnPsgY; PREF=hl=en&gl=US&f6=8"
                    );

                    if ("POST".equals(method) && jsonBody != null) {
                        byte[] bodyBytes = jsonBody.getBytes(StandardCharsets.UTF_8);
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                        conn.setRequestProperty("Accept", "application/json");
                        conn.setRequestProperty("Origin", "https://www.youtube.com");
                        conn.setRequestProperty("Referer", "https://www.youtube.com/");
                        conn.setFixedLengthStreamingMode(bodyBytes.length);
                        try (java.io.OutputStream out = conn.getOutputStream()) {
                            out.write(bodyBytes);
                        }
                    }

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
                            if (total >= 8 * 1024 * 1024) break;
                        }
                        stream.close();
                    }

                    byte[] rawBytes = buffer.toByteArray();
                    String b64 = Base64.encodeToString(rawBytes, Base64.NO_WRAP);
                    boolean ok = status >= 200 && status < 300;
                    JSONObject detail = new JSONObject();
                    detail.put("requestId", requestId);
                    detail.put("ok", ok);
                    detail.put("status", status);
                    detail.put("bodyBase64", b64);
                    dispatchJsEvent("kago-native-http", detail.toString());
                } catch (Exception ex) {
                    try {
                        String emptyB64 = Base64.encodeToString(
                            "".getBytes(StandardCharsets.UTF_8),
                            Base64.NO_WRAP
                        );
                        JSONObject detail = new JSONObject();
                        detail.put("requestId", requestId);
                        detail.put("ok", false);
                        detail.put("status", status);
                        detail.put("bodyBase64", emptyB64);
                        dispatchJsEvent("kago-native-http", detail.toString());
                    } catch (Exception ignored) {
                    }
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            });
        }
    }
}

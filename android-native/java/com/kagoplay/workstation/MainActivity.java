package com.kagoplay.workstation;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
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
    private static final int MAX_CHUNK_BYTES = 192 * 1024;
    private static final String PREFS_FOLDER = "kago_folder_prefs";
    private static final String KEY_PENDING_REQ = "pending_folder_req_id";
    private static final Pattern AUDIO_EXT_PATTERN =
        Pattern.compile("\\.(mp3|flac|wav|ogg|oga|m4a|m4b|aac|opus|webm|wma|aiff|amr|3gp|mp2)$", Pattern.CASE_INSENSITIVE);

    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);

    private volatile boolean isVideoModeActive = false;
    private boolean bridgeAttached = false;
    private volatile String pendingFolderRequestId = null;
    private final ExecutorService networkExecutor = Executors.newFixedThreadPool(4);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Set<String> allowedDocumentUris =
        Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final Set<String> allowedTreePrefixes =
        Collections.newSetFromMap(new ConcurrentHashMap<>());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);
        if (savedInstanceState != null && pendingFolderRequestId == null) {
            pendingFolderRequestId = savedInstanceState.getString(KEY_PENDING_REQ);
        }
        if (pendingFolderRequestId == null) {
            pendingFolderRequestId = getSharedPreferences(PREFS_FOLDER, MODE_PRIVATE)
                .getString(KEY_PENDING_REQ, null);
        }
        attachNativeBridge();
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (pendingFolderRequestId != null) {
            outState.putString(KEY_PENDING_REQ, pendingFolderRequestId);
        }
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

    private void savePendingFolderRequestId(String requestId) {
        pendingFolderRequestId = requestId;
        try {
            android.content.SharedPreferences.Editor editor =
                getSharedPreferences(PREFS_FOLDER, MODE_PRIVATE).edit();
            if (requestId == null) {
                editor.remove(KEY_PENDING_REQ);
            } else {
                editor.putString(KEY_PENDING_REQ, requestId);
            }
            editor.apply();
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FOLDER) {
            String reqId = pendingFolderRequestId;
            if (reqId == null) {
                reqId = getSharedPreferences(PREFS_FOLDER, MODE_PRIVATE).getString(KEY_PENDING_REQ, null);
            }
            savePendingFolderRequestId(null);
            if (reqId == null) return;

            final String resolvedReqId = reqId;
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
                emitFolderEvent(resolvedReqId, false, true, "", new JSONArray(), "");
                return;
            }

            final Uri treeUri = data.getData();
            allowedTreePrefixes.add(treeUri.toString());
            try {
                getContentResolver().takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception ignored) {
            }

            networkExecutor.execute(() -> scanDocumentTreeAndEmit(resolvedReqId, treeUri));
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
            boolean anyQuerySucceeded = false;
            String lastQueryError = "";

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
                    anyQuerySucceeded = true;
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
                        fileObj.put("size", Math.max(0L, size));
                        fileObj.put("lastModified", lastMod);
                        fileObj.put("folderPath", currentPath);
                        filesArray.put(fileObj);
                    }
                } catch (Exception qEx) {
                    lastQueryError = qEx.getMessage() != null ? qEx.getMessage() : "Folder permission query error.";
                }
            }

            if (!anyQuerySucceeded && filesArray.length() == 0 && !lastQueryError.isEmpty()) {
                emitFolderEvent(requestId, false, false, rootFolder, new JSONArray(), lastQueryError);
                return;
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
        final String quotedJson = JSONObject.quote(detailJson != null ? detailJson : "{}");
        webView.post(() -> {
            try {
                webView.onResume();
                webView.resumeTimers();
            } catch (Exception ignored) {
            }
            String js = "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(eventName) + ",{detail:JSON.parse(" + quotedJson + ")}));";
            webView.evaluateJavascript(js, null);
        });
    }

    private static boolean isAllowedFetchUrl(String urlString) {
        if (urlString == null) return false;
        if (urlString.startsWith("https://www.youtube.com/")
            || urlString.startsWith("https://m.youtube.com/")
            || urlString.startsWith("https://music.youtube.com/")
            || urlString.startsWith("https://youtubei.googleapis.com/")
            || urlString.startsWith("https://suggestqueries.google.com/")
            || urlString.startsWith("https://api.audius.co/")
            || urlString.startsWith("https://lrclib.net/")
            || urlString.startsWith("https://en.wikipedia.org/")
            || urlString.startsWith("https://itunes.apple.com/")
            || urlString.startsWith("https://musicbrainz.org/")) {
            return true;
        }
        return isAllowedDownloadMediaUrl(urlString);
    }

    private static boolean isAllowedDownloadMediaUrl(String urlString) {
        if (urlString == null || !urlString.startsWith("https://")) return false;
        try {
            Uri uri = Uri.parse(urlString);
            String host = uri.getHost();
            if (host == null) return false;
            String lower = host.toLowerCase(Locale.US);
            if ("localhost".equals(lower)
                || "127.0.0.1".equals(lower)
                || "0.0.0.0".equals(lower)
                || lower.startsWith("10.")
                || lower.startsWith("192.168.")
                || lower.matches("^172\\.(1[6-9]|2\\d|3[0-1])\\..*")) {
                return false;
            }
            return "googlevideo.com".equals(lower)
                || lower.endsWith(".googlevideo.com")
                || "audius.co".equals(lower)
                || lower.endsWith(".audius.co")
                || "audius.org".equals(lower)
                || lower.endsWith(".audius.org")
                || "audiusrules.com".equals(lower)
                || lower.endsWith(".audiusrules.com");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String sanitizeCacheId(String requestId) {
        if (requestId == null) return "dl_default";
        String clean = requestId.replaceAll("[^a-zA-Z0-9_-]", "");
        return clean.isEmpty() ? "dl_default" : clean;
    }

    private static String sanitizePublicFilename(String rawName) {
        String name = (rawName == null ? "kagoplay-media.mp4" : rawName)
            .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", " ")
            .replaceAll("\\s+", " ")
            .trim();
        return name.isEmpty() ? "kagoplay-media.mp4" : name;
    }

    private void emitDownloadProgress(String requestId, long loadedBytes, long totalBytes) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("requestId", requestId);
            payload.put("loadedBytes", Math.max(0L, loadedBytes));
            payload.put("totalBytes", Math.max(0L, totalBytes));
            dispatchJsEvent("kago-native-dl-progress", payload.toString());
        } catch (Exception ignored) {
        }
    }

    private void emitDownloadDone(String requestId, boolean ok, long totalBytes, String error) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("requestId", requestId);
            payload.put("ok", ok);
            payload.put("totalBytes", Math.max(0L, totalBytes));
            payload.put("error", error != null ? error : "");
            dispatchJsEvent("kago-native-dl-done", payload.toString());
        } catch (Exception ignored) {
        }
    }

    private long downloadUrlToFile(
        String urlString,
        File destFile,
        String requestIdForProgress,
        long progressOffset,
        long knownCombinedTotal
    ) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlString);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(25000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestMethod("GET");
            conn.setRequestProperty(
                "User-Agent",
                "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
            );
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new Exception("HTTP " + status + " downloading media");
            }
            long contentLength = -1L;
            String contentLengthHeader = conn.getHeaderField("Content-Length");
            if (contentLengthHeader != null) {
                try {
                    contentLength = Long.parseLong(contentLengthHeader.trim());
                } catch (NumberFormatException ignored) {
                }
            }
            if (contentLength < 0L) {
                contentLength = conn.getContentLength();
            }
            long effectiveTotal = knownCombinedTotal > 0 ? knownCombinedTotal : contentLength;
            long written = 0L;
            long lastEmitMs = 0L;

            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(destFile)) {
                byte[] buf = new byte[32768];
                int read;
                while ((read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                    written += read;
                    if (requestIdForProgress != null) {
                        long now = System.currentTimeMillis();
                        if (now - lastEmitMs >= 180L) {
                            lastEmitMs = now;
                            emitDownloadProgress(requestIdForProgress, progressOffset + written, effectiveTotal);
                        }
                    }
                }
                out.flush();
            }
            if (requestIdForProgress != null) {
                emitDownloadProgress(requestIdForProgress, progressOffset + written, effectiveTotal);
            }
            return written;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void copyExtractorSamples(
        MediaExtractor extractor,
        int sourceTrackIndex,
        MediaMuxer muxer,
        int muxerTrackIndex,
        int bufferSize
    ) {
        extractor.selectTrack(sourceTrackIndex);
        ByteBuffer buffer = ByteBuffer.allocate(Math.max(256 * 1024, bufferSize));
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            info.offset = 0;
            info.size = extractor.readSampleData(buffer, 0);
            if (info.size < 0) {
                break;
            }
            info.presentationTimeUs = Math.max(0L, extractor.getSampleTime());
            info.flags = extractor.getSampleFlags();
            muxer.writeSampleData(muxerTrackIndex, buffer, info);
            extractor.advance();
        }
        extractor.unselectTrack(sourceTrackIndex);
    }

    private void muxMp4Files(File videoFile, File audioFile, File outputFile) throws Exception {
        MediaExtractor videoExtractor = new MediaExtractor();
        MediaExtractor audioExtractor = new MediaExtractor();
        MediaMuxer muxer = null;
        try {
            videoExtractor.setDataSource(videoFile.getAbsolutePath());
            audioExtractor.setDataSource(audioFile.getAbsolutePath());

            int vTrackIdx = -1;
            MediaFormat vFormat = null;
            for (int i = 0; i < videoExtractor.getTrackCount(); i++) {
                MediaFormat fmt = videoExtractor.getTrackFormat(i);
                String mime = fmt.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    vTrackIdx = i;
                    vFormat = fmt;
                    break;
                }
            }

            int aTrackIdx = -1;
            MediaFormat aFormat = null;
            for (int i = 0; i < audioExtractor.getTrackCount(); i++) {
                MediaFormat fmt = audioExtractor.getTrackFormat(i);
                String mime = fmt.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    aTrackIdx = i;
                    aFormat = fmt;
                    break;
                }
            }

            if (vTrackIdx < 0 || vFormat == null || aTrackIdx < 0 || aFormat == null) {
                throw new Exception("Missing video or audio track for MP4 muxing");
            }

            muxer = new MediaMuxer(outputFile.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int muxVIdx = muxer.addTrack(vFormat);
            int muxAIdx = muxer.addTrack(aFormat);
            muxer.start();

            int vBufSize = vFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)
                ? vFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
                : 1024 * 1024;
            int aBufSize = aFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)
                ? aFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
                : 256 * 1024;

            copyExtractorSamples(videoExtractor, vTrackIdx, muxer, muxVIdx, vBufSize);
            copyExtractorSamples(audioExtractor, aTrackIdx, muxer, muxAIdx, aBufSize);
            muxer.stop();
        } finally {
            try {
                videoExtractor.release();
            } catch (Exception ignored) {
            }
            try {
                audioExtractor.release();
            } catch (Exception ignored) {
            }
            if (muxer != null) {
                try {
                    muxer.release();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private long writeFileToPublicDownloads(File sourceFile, String fileName, String mimeType) throws Exception {
        String safeName = sanitizePublicFilename(fileName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType != null && !mimeType.isEmpty() ? mimeType : "application/octet-stream");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/kaGO.PIaY");
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new Exception("Could not create file in Downloads/kaGO.PIaY");
            }
            long copied = 0L;
            try (InputStream in = new FileInputStream(sourceFile);
                 OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) {
                    throw new Exception("Unable to open Downloads output stream");
                }
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    copied += n;
                }
                out.flush();
            }
            ContentValues doneValues = new ContentValues();
            doneValues.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(uri, doneValues, null, null);
            return copied;
        }

        File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        File targetDir = new File(downloadsDir, "kaGO.PIaY");
        if (!targetDir.exists() && !targetDir.mkdirs()) {
            throw new Exception("Unable to create Downloads/kaGO.PIaY directory");
        }
        File targetFile = new File(targetDir, safeName);
        long copied = 0L;
        try (InputStream in = new FileInputStream(sourceFile);
             OutputStream out = new FileOutputStream(targetFile)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                copied += n;
            }
            out.flush();
        }
        return copied;
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
            savePendingFolderRequestId(requestId);
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
                    savePendingFolderRequestId(null);
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

        private boolean isAuthorizedDocumentUri(String uriString) {
            if (uriString == null || uriString.isEmpty()) return false;
            if (allowedDocumentUris.contains(uriString)) return true;
            for (String prefix : allowedTreePrefixes) {
                if (uriString.startsWith(prefix)) return true;
            }
            try {
                for (android.content.UriPermission perm : getContentResolver().getPersistedUriPermissions()) {
                    if (perm.isReadPermission() && uriString.startsWith(perm.getUri().toString())) {
                        return true;
                    }
                }
            } catch (Exception ignored) {
            }
            return false;
        }

        @JavascriptInterface
        public String readDocumentChunkBase64(
            final String uriString,
            final long offset,
            final int length
        ) {
            if (!isAuthorizedDocumentUri(uriString) || length <= 0) {
                return "";
            }
            // Keep Base64 + UTF-16 JNI Binder payload strictly well below Android's 1MB Binder limit
            int safeLength = Math.min(length, MAX_CHUNK_BYTES);
            Uri uri = Uri.parse(uriString);

            // Fast seek path via ParcelFileDescriptor FileChannel
            try (ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(uri, "r")) {
                if (pfd != null) {
                    try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor())) {
                        fis.getChannel().position(Math.max(0L, offset));
                        byte[] chunk = new byte[safeLength];
                        int totalRead = 0;
                        while (totalRead < safeLength) {
                            int n = fis.read(chunk, totalRead, safeLength - totalRead);
                            if (n <= 0) break;
                            totalRead += n;
                        }
                        if (totalRead <= 0) return "";
                        return Base64.encodeToString(chunk, 0, totalRead, Base64.NO_WRAP);
                    }
                }
            } catch (Throwable ignored) {
                // Fall back to standard InputStream below for virtual SAF providers
            }

            try (InputStream stream = getContentResolver().openInputStream(uri)) {
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
            } catch (Throwable ex) {
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
                    conn.setConnectTimeout(9000);
                    conn.setReadTimeout(12000);
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
                        boolean isPlayerCall = urlString.contains("/youtubei/v1/player");
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                        conn.setRequestProperty("Accept", "application/json");
                        if (isPlayerCall) {
                            conn.setRequestProperty(
                                "User-Agent",
                                "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
                            );
                        } else {
                            conn.setRequestProperty("X-YouTube-Client-Name", "1");
                            conn.setRequestProperty("X-YouTube-Client-Version", "2.20250218.01.00");
                        }
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

        @JavascriptInterface
        public void downloadMediaToCacheAsync(final String requestId, final String urlString) {
            if (!isAllowedDownloadMediaUrl(urlString)) {
                emitDownloadDone(requestId, false, 0L, "URL host not permitted.");
                return;
            }
            networkExecutor.execute(() -> {
                File cacheFile = new File(getCacheDir(), "kago_dl_" + sanitizeCacheId(requestId));
                try {
                    long total = downloadUrlToFile(urlString, cacheFile, requestId, 0L, 0L);
                    emitDownloadDone(requestId, true, total, "");
                } catch (Exception ex) {
                    if (cacheFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        cacheFile.delete();
                    }
                    emitDownloadDone(
                        requestId,
                        false,
                        0L,
                        ex.getMessage() != null ? ex.getMessage() : "Native cache download failed."
                    );
                }
            });
        }

        @JavascriptInterface
        public String readCachedDownloadChunkBase64(
            final String requestId,
            final long offset,
            final int length
        ) {
            if (length <= 0) return "";
            File cacheFile = new File(getCacheDir(), "kago_dl_" + sanitizeCacheId(requestId));
            if (!cacheFile.exists() || !cacheFile.isFile()) return "";
            int safeLength = Math.min(length, MAX_CHUNK_BYTES);
            try (RandomAccessFile raf = new RandomAccessFile(cacheFile, "r")) {
                long fileLen = raf.length();
                if (offset < 0 || offset >= fileLen) return "";
                raf.seek(offset);
                int toRead = (int) Math.min(safeLength, fileLen - offset);
                byte[] buf = new byte[toRead];
                int readTotal = 0;
                while (readTotal < toRead) {
                    int n = raf.read(buf, readTotal, toRead - readTotal);
                    if (n <= 0) break;
                    readTotal += n;
                }
                if (readTotal <= 0) return "";
                return Base64.encodeToString(buf, 0, readTotal, Base64.NO_WRAP);
            } catch (Exception ignored) {
                return "";
            }
        }

        @JavascriptInterface
        public void clearCachedDownload(final String requestId) {
            File cacheFile = new File(getCacheDir(), "kago_dl_" + sanitizeCacheId(requestId));
            if (cacheFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                cacheFile.delete();
            }
        }

        @JavascriptInterface
        public void saveMediaToPublicDownloadsAsync(
            final String requestId,
            final String primaryUrl,
            final String secondaryAudioUrl,
            final String fileName,
            final String mimeType
        ) {
            if (!isAllowedDownloadMediaUrl(primaryUrl)) {
                emitDownloadDone(requestId, false, 0L, "Download URL host not permitted.");
                return;
            }
            if (secondaryAudioUrl != null && !secondaryAudioUrl.trim().isEmpty() && !isAllowedDownloadMediaUrl(secondaryAudioUrl)) {
                emitDownloadDone(requestId, false, 0L, "Audio stream URL host not permitted.");
                return;
            }

            networkExecutor.execute(() -> {
                String safeId = sanitizeCacheId(requestId);
                File vTmp = new File(getCacheDir(), "kago_pub_v_" + safeId + ".tmp");
                File aTmp = new File(getCacheDir(), "kago_pub_a_" + safeId + ".tmp");
                File muxTmp = new File(getCacheDir(), "kago_pub_mux_" + safeId + ".mp4");
                try {
                    boolean hasSecondary = secondaryAudioUrl != null && !secondaryAudioUrl.trim().isEmpty();
                    File readyFile;
                    if (hasSecondary) {
                        long vBytes = downloadUrlToFile(primaryUrl, vTmp, requestId, 0L, 0L);
                        downloadUrlToFile(secondaryAudioUrl, aTmp, requestId, vBytes, 0L);
                        muxMp4Files(vTmp, aTmp, muxTmp);
                        readyFile = muxTmp;
                    } else {
                        downloadUrlToFile(primaryUrl, vTmp, requestId, 0L, 0L);
                        readyFile = vTmp;
                    }
                    long savedBytes = writeFileToPublicDownloads(readyFile, fileName, mimeType);
                    emitDownloadDone(requestId, true, savedBytes, "");
                } catch (Exception ex) {
                    emitDownloadDone(
                        requestId,
                        false,
                        0L,
                        ex.getMessage() != null ? ex.getMessage() : "Unable to save to Downloads folder."
                    );
                } finally {
                    if (vTmp.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        vTmp.delete();
                    }
                    if (aTmp.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        aTmp.delete();
                    }
                    if (muxTmp.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        muxTmp.delete();
                    }
                }
            });
        }
    }
}

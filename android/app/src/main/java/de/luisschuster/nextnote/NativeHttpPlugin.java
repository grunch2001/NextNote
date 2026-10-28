package de.luisschuster.nextnote;

import android.util.Base64;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;
import okio.BufferedSource;
import okio.Okio;

/**
 * HTTP client for the web layer. Unlike Capacitor's built-in HTTP plugin (HttpURLConnection)
 * this supports the WebDAV methods Nextcloud needs (PROPFIND, MKCOL, MOVE …) and is not subject to CORS.
 *
 * Bodies cross the bridge as base64 strings, which takes several copies of the data at once. Large
 * bodies (PDFs of 80 MB ran the app out of memory) therefore go through a file in the cache instead:
 * a response is streamed into a file the web layer reads via Capacitor's file URL, a request body is
 * appended to a file piece by piece ({@link #append}) and streamed from there.
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    /** Responses up to this size are returned inline (keep in sync with INLINE_MAX in src/platform/index.ts). */
    private static final long INLINE_MAX = 2 * 1024 * 1024;

    private OkHttpClient client;
    private File dir;

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(180, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .retryOnConnectionFailure(true)
            .build();
        dir = new File(getContext().getCacheDir(), "http");
        // left over when the app was closed during a transfer
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        dir.mkdirs();
    }

    private static boolean needsBody(String method) {
        switch (method) {
            case "POST":
            case "PUT":
            case "PATCH":
            case "PROPPATCH":
            case "REPORT":
                return true;
            default:
                return false;
        }
    }

    /** A transfer file of this plugin; never any other file of the app. */
    private File own(String path) throws IOException {
        File f = new File(path).getCanonicalFile();
        if (!dir.getCanonicalFile().equals(f.getParentFile())) throw new IOException("Ungültige Datei");
        return f;
    }

    /** Appends base64 data to a request body file (a new one without "file"); returns its path. */
    @PluginMethod
    public void append(final PluginCall call) {
        String path = call.getString("file");
        String data = call.getString("bodyBase64", "");
        try {
            File f = path != null ? own(path) : File.createTempFile("req", ".bin", dir);
            try (OutputStream out = new FileOutputStream(f, true)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            JSObject ret = new JSObject();
            ret.put("file", f.getAbsolutePath());
            call.resolve(ret);
        } catch (IOException | RuntimeException e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    /** Deletes a transfer file once it is not needed any more. */
    @PluginMethod
    public void release(final PluginCall call) {
        String path = call.getString("file");
        try {
            if (path != null) own(path).delete();
        } catch (IOException e) {
            // not ours: nothing to delete
        }
        call.resolve();
    }

    @PluginMethod
    public void request(final PluginCall call) {
        final String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        final String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("Ungültige Adresse");
            return;
        }
        try {
            Request.Builder builder = new Request.Builder().url(url);
            JSObject headers = call.getObject("headers", new JSObject());
            String contentType = null;
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = headers.getString(key);
                if (value == null) continue;
                if (key.equalsIgnoreCase("content-type")) contentType = value;
                builder.header(key, value);
            }
            MediaType mediaType = contentType != null ? MediaType.parse(contentType) : null;
            String bodyBase64 = call.getString("bodyBase64");
            String bodyFile = call.getString("bodyFile");
            RequestBody body = null;
            if (bodyFile != null) {
                body = RequestBody.create(own(bodyFile), mediaType);
            } else if (bodyBase64 != null) {
                body = RequestBody.create(Base64.decode(bodyBase64, Base64.DEFAULT), mediaType);
            } else if (needsBody(method)) {
                body = RequestBody.create(new byte[0], mediaType);
            }
            builder.method(method, body);

            OkHttpClient c = client;
            Integer timeoutMs = call.getInt("timeoutMs");
            if (timeoutMs != null && timeoutMs > 0) {
                c = client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build();
            }
            c.newCall(builder.build()).enqueue(new Callback() {
                @Override
                public void onFailure(@NonNull Call c, @NonNull IOException e) {
                    call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
                }

                @Override
                public void onResponse(@NonNull Call c, @NonNull Response response) {
                    File file = null;
                    try (ResponseBody responseBody = response.body()) {
                        JSObject h = new JSObject();
                        for (String name : response.headers().names()) {
                            h.put(name.toLowerCase(Locale.ROOT), response.header(name));
                        }
                        JSObject ret = new JSObject();
                        ret.put("status", response.code());
                        ret.put("headers", h);
                        BufferedSource source = responseBody != null ? responseBody.source() : null;
                        if (source != null && source.request(INLINE_MAX + 1)) {
                            file = File.createTempFile("res", ".bin", dir);
                            try (BufferedSink sink = Okio.buffer(Okio.sink(file))) {
                                sink.writeAll(source);
                            }
                            ret.put("bodyFile", file.getAbsolutePath());
                        } else {
                            byte[] bytes = source != null ? source.readByteArray() : new byte[0];
                            ret.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                        }
                        call.resolve(ret);
                    } catch (IOException | RuntimeException e) {
                        if (file != null) file.delete();
                        call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
                    }
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }
}

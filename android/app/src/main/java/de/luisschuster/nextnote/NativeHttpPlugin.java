package de.luisschuster.nextnote;

import android.util.Base64;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
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

/**
 * HTTP client for the web layer. Unlike Capacitor's built-in HTTP plugin (HttpURLConnection)
 * this supports the WebDAV methods Nextcloud needs (PROPFIND, MKCOL, MOVE …) and is not subject to CORS.
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private OkHttpClient client;

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
            RequestBody body = null;
            if (bodyBase64 != null) {
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
                    try (ResponseBody responseBody = response.body()) {
                        byte[] bytes = responseBody != null ? responseBody.bytes() : new byte[0];
                        JSObject h = new JSObject();
                        for (String name : response.headers().names()) {
                            h.put(name.toLowerCase(Locale.ROOT), response.header(name));
                        }
                        JSObject ret = new JSObject();
                        ret.put("status", response.code());
                        ret.put("headers", h);
                        ret.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                        call.resolve(ret);
                    } catch (IOException e) {
                        call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
                    }
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }
}

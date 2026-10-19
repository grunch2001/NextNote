package de.luisschuster.nextnote;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * System clipboard access for pasting. {@link #info} only looks at the clip description
 * (time of the last copy), so it neither reads the content nor triggers Android's
 * "pasted from clipboard" notice.
 */
@CapacitorPlugin(name = "NativeClipboard")
public class NativeClipboardPlugin extends Plugin {

    private static final int MAX_IMAGE_BYTES = 25 * 1024 * 1024;

    private ClipboardManager manager() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject ret = new JSObject();
        ClipboardManager cm = manager();
        if (cm == null || !cm.hasPrimaryClip()) {
            ret.put("hasClip", false);
            ret.put("timestamp", 0);
            call.resolve(ret);
            return;
        }
        ClipDescription d = cm.getPrimaryClipDescription();
        ret.put("hasClip", true);
        long ts = 0;
        if (d != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ts = d.getTimestamp();
        ret.put("timestamp", ts);
        call.resolve(ret);
    }

    @PluginMethod
    public void read(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ClipboardManager cm = manager();
            ClipData clip = cm != null ? cm.getPrimaryClip() : null;
            if (clip == null || clip.getItemCount() == 0) {
                call.resolve(ret);
                return;
            }
            ClipData.Item item = clip.getItemAt(0);
            Uri uri = item.getUri();
            if (uri != null) {
                String type = getContext().getContentResolver().getType(uri);
                if (type != null && type.startsWith("image/")) {
                    try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                        if (in != null) {
                            ByteArrayOutputStream out = new ByteArrayOutputStream();
                            byte[] buf = new byte[65536];
                            int n;
                            int total = 0;
                            while ((n = in.read(buf)) > 0) {
                                total += n;
                                if (total > MAX_IMAGE_BYTES) break;
                                out.write(buf, 0, n);
                            }
                            if (total <= MAX_IMAGE_BYTES) {
                                ret.put("imageBase64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                                ret.put("imageType", type);
                                call.resolve(ret);
                                return;
                            }
                        }
                    }
                }
            }
            CharSequence text = item.coerceToText(getContext());
            if (text != null) ret.put("text", text.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        ClipboardManager cm = manager();
        if (cm == null) {
            call.reject("Zwischenablage nicht verfügbar");
            return;
        }
        cm.setPrimaryClip(ClipData.newPlainText("NextNote", call.getString("text", "")));
        call.resolve();
    }
}

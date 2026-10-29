package de.luisschuster.nextnote;

import android.graphics.Color;
import android.graphics.RectF;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;

/** Connects the page (src/ink/nativeInk.ts) with the low-latency ink layer {@link NativeInk}. */
@CapacitorPlugin(name = "NativeInk")
public class NativeInkPlugin extends Plugin {

    @Override
    public void load() {
        NativeInk.listener = (seq, pts, count) -> {
            JSONArray arr = new JSONArray();
            try {
                for (int i = 0; i < count * 3; i++) arr.put(Math.round(pts[i] * 1000) / 1000.0);
            } catch (org.json.JSONException e) {
                return;
            }
            JSObject data = new JSObject();
            data.put("seq", seq);
            data.put("pts", arr);
            notifyListeners("stroke", data);
        };
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject res = new JSObject();
        res.put("available", NativeInk.current != null);
        call.resolve(res);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        JSObject d = call.getData();
        NativeInk.Config c = new NativeInk.Config();
        c.enabled = d.optBoolean("enabled", false);
        c.auto = d.optBoolean("auto", false);
        try {
            c.color = Color.parseColor(d.optString("color", "#000000"));
        } catch (IllegalArgumentException e) {
            c.color = Color.BLACK;
        }
        c.size = d.optDouble("size", c.size);
        c.widthBase = d.optDouble("widthBase", c.widthBase);
        c.widthPressure = d.optDouble("widthPressure", c.widthPressure);
        c.uniform = d.optBoolean("uniform", false);
        c.zoom = (float) d.optDouble("zoom", 1);
        c.dpr = (float) d.optDouble("dpr", 1);
        rect(d.optJSONArray("rect"), c.rect);
        JSONArray ex = d.optJSONArray("exclude");
        if (ex != null) {
            for (int i = 0; i < ex.length(); i++) {
                RectF r = new RectF();
                if (rect(ex.optJSONArray(i), r)) c.exclude.add(r);
            }
        }
        run(ink -> ink.configure(c));
        call.resolve();
    }

    @PluginMethod
    public void reject(PluginCall call) {
        float x = (float) call.getData().optDouble("x", Double.NaN);
        float y = (float) call.getData().optDouble("y", Double.NaN);
        run(ink -> ink.reject(x, y));
        call.resolve();
    }

    @PluginMethod
    public void shown(PluginCall call) {
        int seq = call.getData().optInt("seq", -1);
        run(ink -> ink.shown(seq));
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        run(NativeInk::clear);
        call.resolve();
    }

    private static boolean rect(JSONArray a, RectF out) {
        if (a == null || a.length() != 4) return false;
        out.set((float) a.optDouble(0), (float) a.optDouble(1), (float) a.optDouble(2), (float) a.optDouble(3));
        return true;
    }

    private interface InkAction {
        void run(NativeInk ink);
    }

    /** The layer lives on the UI thread; plugin calls arrive on the plugin thread. */
    private void run(InkAction action) {
        getBridge().executeOnMainThread(() -> {
            NativeInk ink = NativeInk.current;
            if (ink != null) action.run(ink);
        });
    }
}

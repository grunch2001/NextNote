package de.luisschuster.nextnote;

import android.os.Bundle;
import android.view.MotionEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Holding the S Pen side button erases (app setting, see {@link NativePenPlugin}). */
    static volatile boolean penButtonErases = true;

    // older Samsung devices report the side button as the secondary button
    private static final int SIDE_BUTTON = MotionEvent.BUTTON_STYLUS_PRIMARY | MotionEvent.BUTTON_SECONDARY;

    /** The current stylus contact began with the side button held. */
    private boolean erasing;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeHttpPlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        registerPlugin(NativeSecureStoragePlugin.class);
        registerPlugin(NativePenPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // The WebView does not tell web pages about the side button of a stylus that touches the
    // screen (Chromium always reports buttons = 1) and turns it into a long press instead, which
    // opens menus and selects text. A stroke with the side button held therefore reaches the
    // WebView as the eraser end of the pen, which the page sees as buttons = 32.

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        boolean stylus = penButtonErases && hasStylus(ev);
        int action = ev.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) erasing = stylus && (ev.getButtonState() & SIDE_BUTTON) != 0;
        if (!stylus || (!erasing && (ev.getButtonState() & SIDE_BUTTON) == 0)) return super.dispatchTouchEvent(ev);
        // a side button pressed only during the stroke is dropped, so it does not become a long press
        MotionEvent out = convert(ev, erasing);
        try {
            return super.dispatchTouchEvent(out);
        } finally {
            out.recycle();
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) erasing = false;
        }
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent ev) {
        if (!penButtonErases || !hasStylus(ev)) return super.dispatchGenericMotionEvent(ev);
        int action = ev.getActionMasked();
        // the WebView would turn these into mouse clicks
        if ((action == MotionEvent.ACTION_BUTTON_PRESS || action == MotionEvent.ACTION_BUTTON_RELEASE) && (ev.getActionButton() & SIDE_BUTTON) != 0) {
            return true;
        }
        if ((ev.getButtonState() & SIDE_BUTTON) == 0) return super.dispatchGenericMotionEvent(ev);
        // hovering with the side button held: the eraser end hovers
        MotionEvent out = convert(ev, true);
        try {
            return super.dispatchGenericMotionEvent(out);
        } finally {
            out.recycle();
        }
    }

    private static boolean hasStylus(MotionEvent ev) {
        for (int i = 0; i < ev.getPointerCount(); i++) {
            if (ev.getToolType(i) == MotionEvent.TOOL_TYPE_STYLUS) return true;
        }
        return false;
    }

    /** Copy of the event (with its batched samples) without the side button, the stylus optionally as eraser. */
    private static MotionEvent convert(MotionEvent ev, boolean eraser) {
        int n = ev.getPointerCount();
        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[n];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[n];
        for (int i = 0; i < n; i++) {
            props[i] = new MotionEvent.PointerProperties();
            ev.getPointerProperties(i, props[i]);
            if (eraser && props[i].toolType == MotionEvent.TOOL_TYPE_STYLUS) props[i].toolType = MotionEvent.TOOL_TYPE_ERASER;
            coords[i] = new MotionEvent.PointerCoords();
        }
        int history = ev.getHistorySize();
        MotionEvent out = null;
        for (int h = 0; h <= history; h++) {
            for (int i = 0; i < n; i++) {
                if (h < history) ev.getHistoricalPointerCoords(i, h, coords[i]);
                else ev.getPointerCoords(i, coords[i]);
            }
            long time = h < history ? ev.getHistoricalEventTime(h) : ev.getEventTime();
            if (out == null) {
                out = MotionEvent.obtain(
                    ev.getDownTime(),
                    time,
                    ev.getAction(),
                    n,
                    props,
                    coords,
                    ev.getMetaState(),
                    ev.getButtonState() & ~SIDE_BUTTON,
                    ev.getXPrecision(),
                    ev.getYPrecision(),
                    ev.getDeviceId(),
                    ev.getEdgeFlags(),
                    ev.getSource(),
                    ev.getFlags()
                );
            } else {
                out.addBatch(time, coords, ev.getMetaState());
            }
        }
        return out;
    }
}

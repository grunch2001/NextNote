package de.luisschuster.nextnote;

import android.app.Activity;
import android.graphics.BlendMode;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.RecordingCanvas;
import android.graphics.RenderNode;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Low-latency live ink for the stylus (Android 10+).
 *
 * A transparent front-buffered layer above the WebView draws the stroke being written right from
 * the input events, without the delay of the WebView's rendering pipeline. Strokes are drawn like
 * direct strokes on the page (src/ink/direct.ts): a disc per point, joined by tangents, so a new
 * point only adds to what is drawn. The page (src/ink/nativeInk.ts) still decides what a pen contact
 * does and stores the stroke from the points this layer sends when the pen lifts. Finished strokes
 * stay on the layer until the page reports that it shows them itself, then the layer is cleared.
 *
 * Input and bookkeeping run on the UI thread, drawing on the renderer's thread: a {@link Frame}
 * carries everything the drawing needs, and the point array of a stroke is only ever appended to.
 */
@RequiresApi(Build.VERSION_CODES.Q)
final class NativeInk implements CanvasFrontBufferedRenderer.Callback<NativeInk.Frame> {

    /** The layer of the running activity, used by {@link NativeInkPlugin}. */
    static volatile NativeInk current;
    /** Receives finished strokes, set by {@link NativeInkPlugin}. */
    static volatile StrokeListener listener;

    interface StrokeListener {
        /** Points as x, y (client CSS pixels of the WebView), pressure triples. */
        void onStroke(int seq, double[] pts, int count);
    }

    /** What the page sends, see NativeInkConfig in src/platform/types.ts. */
    static final class Config {
        boolean enabled;
        boolean auto;
        int color = Color.BLACK;
        /** Pen size in page units; the width is size * (widthBase + widthPressure * pressure). */
        double size = 2.5;
        double widthBase = 0.5;
        double widthPressure = 1.2;
        boolean uniform;
        float zoom = 1;
        float dpr = 1;
        final RectF rect = new RectF();
        final List<RectF> exclude = new ArrayList<>();
    }

    // the same as in src/ink/controller.ts
    private static final double MIN_DIST_CSS = 0.35;
    private static final double TAP_SLOP_CSS = 6;
    private static final long TAP_MS = 450;
    /** The page shows a stroke a few frames after it reports it; keep it here a bit longer. */
    private static final long CLEAR_DELAY_MS = 150;
    /** A finished stroke the page never confirms (or rejects) is dropped after this. */
    private static final long STALE_MS = 3000;
    /** Distance (CSS px) within which the page's pointer position names a stroke start. */
    private static final float MATCH_CSS = 2;
    private static final int SIDE_BUTTON = MotionEvent.BUTTON_STYLUS_PRIMARY | MotionEvent.BUTTON_SECONDARY;

    private final WebView webView;
    private final SurfaceView surfaceView;
    private final CanvasFrontBufferedRenderer<Frame> renderer;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final int[] loc = new int[2];

    // ------------------------------------------------------------------ UI thread state

    private Config config = new Config();
    private Stroke live;
    /** Finished strokes on the layer that the page has not confirmed yet. */
    private final List<Stroke> pending = new ArrayList<>();
    private int seq;
    private int frameNo;
    /** Increases whenever the layer is cleared; older frames are not drawn. */
    private int generation;
    private boolean hasContent;
    private final Runnable clearRunnable = this::clearIfIdle;

    // ------------------------------------------------------------------ render thread state

    private final List<Stroke> scene = new ArrayList<>();
    private int renderGeneration;
    private Stroke renderLive;
    private final Path path = new Path();
    private RenderNode offscreen;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint blitPaint = new Paint();
    private final Rect dirty = new Rect();
    private final RectF region = new RectF();
    private final RectF box = new RectF();

    private static final class Stroke {
        final int seq;
        final int pointerId;
        final long downTime;
        final int color;
        final double half;
        final double widthBase;
        final double widthPressure;
        final boolean uniform;
        final float zoom;
        final float dpr;
        /** Window position of the WebView, for CSS coordinates. */
        final float winX;
        final float winY;
        /** Page units (CSS px / zoom) to surface pixels. */
        final double scale;
        final double offX;
        final double offY;
        final float downX;
        final float downY;
        /** Points in page units relative to the WebView origin: x, y, pressure. Only appended to. */
        double[] pts = new double[3 * 512];
        int n;
        double lastX;
        double lastY;
        double maxMove;
        /** Drawn on the layer: in "auto" mode only once it moves (a tap is a click). */
        boolean visible;
        volatile boolean removed;
        volatile int latestFrame;

        // render thread: what is drawn of the stroke
        double[] drawnPts;
        int drawnN;
        final RectF bounds = new RectF();

        Stroke(int seq, int pointerId, long downTime, Config c, float winX, float winY, float offX, float offY, float downX, float downY) {
            this.seq = seq;
            this.pointerId = pointerId;
            this.downTime = downTime;
            this.color = c.color;
            this.half = c.size / 2;
            this.widthBase = c.widthBase;
            this.widthPressure = c.widthPressure;
            this.uniform = c.uniform;
            this.zoom = c.zoom;
            this.dpr = c.dpr;
            this.winX = winX;
            this.winY = winY;
            this.scale = c.zoom * c.dpr;
            this.offX = offX;
            this.offY = offY;
            this.downX = downX;
            this.downY = downY;
        }

        /** Radius in surface pixels, like directRadius() in src/ink/direct.ts. */
        double radius(double pressure) {
            return half * (uniform ? 1 : widthBase + widthPressure * pressure) * scale;
        }
    }

    /** One drawing request for the renderer thread. */
    static final class Frame {
        static final int LIVE = 0;
        static final int FINAL = 1;
        static final int REMOVE = 2;
        /** The layer was cleared (or just created); this frame only makes it visible. */
        static final int CLEAR = 3;

        final int type;
        final Stroke stroke;
        final double[] pts;
        final int n;
        final int no;
        final int generation;

        Frame(int type, Stroke stroke, int no, int generation) {
            this.type = type;
            this.stroke = stroke;
            this.pts = stroke == null ? null : stroke.pts;
            this.n = stroke == null ? 0 : stroke.n;
            this.no = no;
            this.generation = generation;
        }
    }

    private NativeInk(Activity activity, WebView webView) {
        this.webView = webView;
        surfaceView = new SurfaceView(activity);
        surfaceView.setZOrderOnTop(true);
        surfaceView.getHolder().setFormat(PixelFormat.TRANSLUCENT);
        surfaceView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        ((ViewGroup) webView.getParent()).addView(surfaceView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        renderer = new CanvasFrontBufferedRenderer<>(surfaceView, this);
        // after the renderer's own callback: show the (empty) layer as soon as there is a surface,
        // so the first stroke does not wait for the layer to appear
        surfaceView.getHolder().addCallback(
            new SurfaceHolder.Callback() {
                @Override
                public void surfaceCreated(@NonNull SurfaceHolder holder) {}

                @Override
                public void surfaceChanged(@NonNull SurfaceHolder holder, int format, int width, int height) {
                    show();
                }

                @Override
                public void surfaceDestroyed(@NonNull SurfaceHolder holder) {}
            }
        );
        blitPaint.setBlendMode(BlendMode.SRC);
    }

    /** Puts the layer above the WebView. */
    static NativeInk attach(Activity activity, WebView webView) {
        NativeInk ink = new NativeInk(activity, webView);
        current = ink;
        return ink;
    }

    void release() {
        if (current == this) current = null;
        handler.removeCallbacksAndMessages(null);
        renderer.release(true);
    }

    // ------------------------------------------------------------------ page requests (UI thread)

    void configure(Config c) {
        config = c;
    }

    /** The pen contact that started at (x, y) is not a stroke (a click, a button, text selection …). */
    void reject(float x, float y) {
        Stroke s = live;
        if (s != null && near(s, x, y)) {
            if (!s.removed) remove(s);
            return;
        }
        for (int i = pending.size() - 1; i >= 0; i--) {
            s = pending.get(i);
            if (near(s, x, y)) {
                pending.remove(i);
                remove(s);
                scheduleClear();
                return;
            }
        }
    }

    /** The page shows the stroke now. */
    void shown(int strokeSeq) {
        for (int i = 0; i < pending.size(); i++) {
            if (pending.get(i).seq == strokeSeq) {
                pending.remove(i);
                scheduleClear();
                return;
            }
        }
    }

    /** Removes everything at once (the page scrolled, zoomed or changed). */
    void clear() {
        handler.removeCallbacks(clearRunnable);
        pending.clear();
        if (live != null) live.removed = true;
        if (!hasContent) return;
        hasContent = false;
        generation++;
        // cancel() empties the front buffer (and the renderer's list of frames) but also hides it
        renderer.cancel();
        show();
    }

    /** Makes the layer visible with what it holds; a hidden layer only shows a frame later. */
    private void show() {
        renderer.renderFrontBufferedLayer(new Frame(Frame.CLEAR, null, ++frameNo, generation));
    }

    private static boolean near(Stroke s, float x, float y) {
        return Math.abs(s.downX - x) < MATCH_CSS && Math.abs(s.downY - y) < MATCH_CSS;
    }

    private void remove(Stroke s) {
        s.removed = true;
        if (!s.visible) return;
        int no = ++frameNo;
        s.latestFrame = no;
        renderer.renderFrontBufferedLayer(new Frame(Frame.REMOVE, s, no, generation));
    }

    private void scheduleClear() {
        handler.removeCallbacks(clearRunnable);
        if (live == null && pending.isEmpty() && hasContent) handler.postDelayed(clearRunnable, CLEAR_DELAY_MS);
    }

    private void clearIfIdle() {
        if (live == null && pending.isEmpty()) clear();
    }

    // ------------------------------------------------------------------ input (UI thread)

    /** Every touch event of the activity, before the WebView gets it. */
    void onTouchEvent(MotionEvent ev) {
        int action = ev.getActionMasked();
        Stroke s = live;
        if (s == null) {
            if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) start(ev, ev.getActionIndex());
            return;
        }
        if (action == MotionEvent.ACTION_CANCEL) {
            finish(s);
            return;
        }
        int idx = ev.findPointerIndex(s.pointerId);
        if (idx < 0) return;
        // deliver the following events of this stroke right away instead of once per frame
        webView.requestUnbufferedDispatch(ev);
        addSamples(s, ev, idx);
        boolean up = action == MotionEvent.ACTION_UP || (action == MotionEvent.ACTION_POINTER_UP && ev.getActionIndex() == idx);
        if (up) finish(s);
        else if (action == MotionEvent.ACTION_MOVE) draw(s, ev);
    }

    private void start(MotionEvent ev, int idx) {
        Config c = config;
        if (!c.enabled || ev.getToolType(idx) != MotionEvent.TOOL_TYPE_STYLUS) return;
        // with the side button held the stroke erases (see MainActivity)
        if (MainActivity.penButtonErases && (ev.getButtonState() & SIDE_BUTTON) != 0) return;
        webView.getLocationInWindow(loc);
        float winX = loc[0];
        float winY = loc[1];
        float x = (ev.getX(idx) - winX) / c.dpr;
        float y = (ev.getY(idx) - winY) / c.dpr;
        if (!c.rect.contains(x, y)) return;
        for (RectF r : c.exclude) if (r.contains(x, y)) return;
        surfaceView.getLocationInWindow(loc);
        handler.removeCallbacks(clearRunnable);
        Stroke s = new Stroke(++seq, ev.getPointerId(idx), ev.getEventTime(), c, winX, winY, winX - loc[0], winY - loc[1], x, y);
        s.visible = !c.auto;
        live = s;
        webView.requestUnbufferedDispatch(ev);
        addSamples(s, ev, idx);
        if (s.visible) post(Frame.LIVE, s);
    }

    private void addSamples(Stroke s, MotionEvent ev, int idx) {
        int history = ev.getHistorySize();
        for (int h = 0; h <= history; h++) {
            boolean cur = h == history;
            addPoint(
                s,
                cur ? ev.getX(idx) : ev.getHistoricalX(idx, h),
                cur ? ev.getY(idx) : ev.getHistoricalY(idx, h),
                cur ? ev.getPressure(idx) : ev.getHistoricalPressure(idx, h)
            );
        }
    }

    private void addPoint(Stroke s, float wx, float wy, float pressure) {
        double x = (wx - s.winX) / s.dpr;
        double y = (wy - s.winY) / s.dpr;
        s.maxMove = Math.max(s.maxMove, Math.hypot(x - s.downX, y - s.downY));
        if (s.n > 0 && Math.hypot(x - s.lastX, y - s.lastY) < MIN_DIST_CSS) return;
        s.lastX = x;
        s.lastY = y;
        if ((s.n + 1) * 3 > s.pts.length) {
            // a new array: frames still in flight keep the old one
            s.pts = java.util.Arrays.copyOf(s.pts, s.pts.length * 2);
        }
        int k = s.n * 3;
        s.pts[k] = x / s.zoom;
        s.pts[k + 1] = y / s.zoom;
        s.pts[k + 2] = pressureOf(pressure);
        s.n++;
    }

    private static double pressureOf(float p) {
        return p > 0 ? Math.round(Math.min(p, 1f) * 100) / 100.0 : 0.5;
    }

    private void draw(Stroke s, MotionEvent ev) {
        if (s.removed) return;
        if (!s.visible) {
            if (s.maxMove < TAP_SLOP_CSS && ev.getEventTime() - s.downTime < TAP_MS) return;
            s.visible = true;
        }
        post(Frame.LIVE, s);
    }

    private void finish(Stroke s) {
        live = null;
        if (!s.removed) {
            if (s.visible) {
                post(Frame.FINAL, s);
                pending.add(s);
                handler.postDelayed(
                    () -> {
                        if (pending.remove(s)) scheduleClear();
                    },
                    STALE_MS
                );
            }
            StrokeListener l = listener;
            if (l != null) {
                double[] css = new double[s.n * 3];
                for (int i = 0; i < s.n * 3; i += 3) {
                    css[i] = s.pts[i] * s.zoom;
                    css[i + 1] = s.pts[i + 1] * s.zoom;
                    css[i + 2] = s.pts[i + 2];
                }
                l.onStroke(s.seq, css, s.n);
            }
        }
        scheduleClear();
    }

    private void post(int type, Stroke s) {
        int no = ++frameNo;
        s.latestFrame = no;
        hasContent = true;
        renderer.renderFrontBufferedLayer(new Frame(type, s, no, generation));
    }

    // ------------------------------------------------------------------ drawing (render thread)

    @Override
    public void onDrawFrontBufferedLayer(@NonNull Canvas canvas, int width, int height, @NonNull Frame f) {
        if (f.generation != renderGeneration) {
            if (f.generation < renderGeneration) return;
            // the layer was cleared
            scene.clear();
            renderLive = null;
            renderGeneration = f.generation;
        }
        if (f.type == Frame.CLEAR) return;
        ensureOffscreen(width, height);
        Stroke s = f.stroke;
        if (f.type == Frame.REMOVE) {
            scene.remove(s);
            if (renderLive == s) renderLive = null;
            if (!s.bounds.isEmpty()) redraw(canvas, s.bounds);
            return;
        }
        // skip a frame that a newer one of the same stroke replaces
        if (s.removed || (f.type == Frame.LIVE && f.no != s.latestFrame)) return;
        // only the points added since the last frame change the picture
        region.setEmpty();
        unionShapes(region, s, f.pts, Math.max(0, s.drawnN - 1), f.n);
        s.drawnPts = f.pts;
        s.drawnN = f.n;
        s.bounds.union(region);
        if (f.type == Frame.FINAL) {
            scene.add(s);
            if (renderLive == s) renderLive = null;
        } else {
            renderLive = s;
        }
        redraw(canvas, region);
    }

    @Override
    public void onDrawMultiBufferedLayer(@NonNull Canvas canvas, int width, int height, @NonNull Collection<? extends Frame> params) {
        // never committed: everything stays in the front buffer until it is cleared
    }

    private void ensureOffscreen(int width, int height) {
        if (offscreen != null && offscreen.getWidth() == width && offscreen.getHeight() == height) return;
        offscreen = new RenderNode("NativeInk-offscreen");
        offscreen.setPosition(0, 0, width, height);
        offscreen.setHasOverlappingRendering(true);
        // the region drawn into the front buffer replaces what is there
        offscreen.setUseCompositingLayer(true, blitPaint);
    }

    /**
     * Redraws a region of the front buffer. The region is composed off screen and copied in one
     * operation, so the display never shows it half cleared (Jetpack Ink does the same).
     */
    private void redraw(Canvas canvas, RectF area) {
        area.roundOut(dirty);
        dirty.inset(-2, -2);
        box.set(dirty);
        offscreen.setClipRect(dirty);
        RecordingCanvas rc = offscreen.beginRecording();
        rc.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
        for (Stroke s : scene) drawStroke(rc, s);
        if (renderLive != null) drawStroke(rc, renderLive);
        offscreen.endRecording();
        canvas.save();
        canvas.clipRect(dirty);
        canvas.drawRenderNode(offscreen);
        canvas.restore();
        offscreen.setClipRect(null);
    }

    /** The shapes of a stroke inside {@link #box}. */
    private void drawStroke(Canvas canvas, Stroke s) {
        if (!RectF.intersects(s.bounds, box)) return;
        path.rewind();
        double[] p = s.drawnPts;
        double px = 0;
        double py = 0;
        double pr = 0;
        for (int i = 0; i < s.drawnN; i++) {
            double x = p[i * 3] * s.scale + s.offX;
            double y = p[i * 3 + 1] * s.scale + s.offY;
            double r = s.radius(p[i * 3 + 2]);
            if (x + r >= box.left && x - r <= box.right && y + r >= box.top && y - r <= box.bottom) path.addCircle((float) x, (float) y, (float) r, Path.Direction.CCW);
            if (i > 0 && Math.max(x + r, px + pr) >= box.left && Math.min(x - r, px - pr) <= box.right && Math.max(y + r, py + pr) >= box.top && Math.min(y - r, py - pr) <= box.bottom) {
                addQuad(path, px, py, pr, x, y, r);
            }
            px = x;
            py = y;
            pr = r;
        }
        paint.setColor(s.color);
        canvas.drawPath(path, paint);
    }

    /** The tangents joining two discs, like directShapes() in src/ink/direct.ts (counter-clockwise like the discs). */
    private static void addQuad(Path path, double x1, double y1, double r1, double x2, double y2, double r2) {
        double len = Math.hypot(x2 - x1, y2 - y1);
        if (len <= Math.abs(r1 - r2)) return; // one disc contains the other
        double ux = (x2 - x1) / len;
        double uy = (y2 - y1) / len;
        double k = (r1 - r2) / len;
        double s = Math.sqrt(1 - k * k);
        double ax = k * ux - s * uy;
        double ay = k * uy + s * ux;
        double bx = k * ux + s * uy;
        double by = k * uy - s * ux;
        path.moveTo((float) (x1 + r1 * ax), (float) (y1 + r1 * ay));
        path.lineTo((float) (x2 + r2 * ax), (float) (y2 + r2 * ay));
        path.lineTo((float) (x2 + r2 * bx), (float) (y2 + r2 * by));
        path.lineTo((float) (x1 + r1 * bx), (float) (y1 + r1 * by));
        path.close();
    }

    /** Adds the bounds (surface pixels) of points from..to (exclusive). */
    private static void unionShapes(RectF out, Stroke s, double[] p, int from, int to) {
        for (int i = from; i < to; i++) {
            double x = p[i * 3] * s.scale + s.offX;
            double y = p[i * 3 + 1] * s.scale + s.offY;
            double r = s.radius(p[i * 3 + 2]);
            out.union((float) (x - r), (float) (y - r), (float) (x + r), (float) (y + r));
        }
    }
}

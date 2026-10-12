package rust.cute_pet;

import android.app.Service;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * cute-pet · Android 悬浮窗壳
 *
 * 与 Electron 壳共用**同一份 Web 内容层**（src/ + assets/），差别只在这个薄壳：
 *   Electron : BrowserWindow(transparent) + pet:// 自定义协议 + setIgnoreMouseEvents
 *   Android  : TYPE_APPLICATION_OVERLAY + WebView + shouldInterceptRequest + FLAG_NOT_TOUCHABLE
 * 路径约定完全一致（/src、/assets、/vendor），index.html 一行都不用改，
 * 只是 base URL 从 pet://app/ 变成 http://pet.local/。
 */
public final class OverlayService extends Service {
    private static final String TAG = "cute-pet";
    private static final String BASE = "http://pet.local/";
    private static volatile OverlayService INSTANCE;

    private WindowManager wm;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView web;
    private WindowManager.LayoutParams params;
    private volatile boolean passthrough = false;
    private volatile boolean dragging = false;   // 桥线程写、UI 线程读
    private float downX, downY;
    private int winX, winY;

    public static boolean isRunning() { return INSTANCE != null; }

    public static void setPassthroughStatic(boolean v) {
        OverlayService s = INSTANCE;
        if (s != null) s.setPassthrough(v);
    }

    public static void stopStatic() {
        OverlayService s = INSTANCE;
        if (s != null) s.stopSelf();
    }

    /** 同步完素材后刷新正在运行的桌宠：换掉当前包。 */
    public static void reloadPack() {
        OverlayService s = INSTANCE;
        if (s == null) return;
        final String now = PackFetcher.pickPack(s);
        s.ui.post(new Runnable() {
            @Override public void run() {
                s.loadPack(now);
            }
        });
    }

    private void loadPack(String packId) {
        if (packId == null) {
            web.loadUrl(BASE + "src/index.html");
            Log.i(TAG, "reload pack=null（回落内置 chibi）");
            return;
        }
        web.loadUrl(BASE + "src/index.html?pack=/assets/packs/" + packId + "/pack.json");
        Log.i(TAG, "reload pack=" + packId);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        INSTANCE = this;
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);

        web = new WebView(this);
        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setAllowFileAccess(false);
        st.setMediaPlaybackRequiresUserGesture(false);
        // 关掉 WebView 的「宽视口/概览缩放」：桌宠画布必须按 CSS 像素 1:1 落位
        st.setUseWideViewPort(false);
        st.setLoadWithOverviewMode(false);
        st.setSupportZoom(false);
        st.setBuiltInZoomControls(false);

        web.setBackgroundColor(Color.TRANSPARENT);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.addJavascriptInterface(new Bridge(), "PetBridge");
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, "[page] " + m.message());
                return true;
            }
        });
        web.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent ev) {
                switch (ev.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = ev.getRawX(); downY = ev.getRawY();
                        winX = params.x; winY = params.y;
                        break;
                    case MotionEvent.ACTION_MOVE:
                        // 只有 JS 命中不透明像素并调了 dragStart 时才真的搬窗口
                        if (dragging) {
                            params.x = winX + (int) (ev.getRawX() - downX);
                            params.y = winY + (int) (ev.getRawY() - downY);
                            if (web.isAttachedToWindow()) wm.updateViewLayout(web, params);
                        }
                        break;
                    default: break;
                }
                return false;   // 交回 WebView，页面才能收到 touchstart/touchmove 做命中测试
            }
        });

        // 不用 WRAP_CONTENT：WebView 没有固有尺寸，WRAP_CONTENT 会让它塌成 0 或乱量。
        // 先给个合理初值，页面起来后会用桥里的 resize 精确对齐到画布尺寸 * dpr。
        float dpr = getResources().getDisplayMetrics().density;
        params = new WindowManager.LayoutParams(
                (int) (128 * dpr),
                (int) (128 * dpr),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 200;
        params.y = 500;

        wm.addView(web, params);
        loadPack(PackFetcher.pickPack(this));

        // 后台拉取素材包（版权素材不随 APK 分发，改成按需下载），不阻塞悬浮窗显示。
        // 拉完后：若拿到了新的角色包、而当前还在用内置 chibi，就换成它；
        // 无论换没换，都调 reloadPack() 让正在运行的服务重新按 pickPack() 选包。
        PackFetcher.sync(this, new PackFetcher.Log() {
            @Override public void log(String s) {
                Log.i(TAG, "[packs] " + s);
            }
        }, new PackFetcher.Done() {
            @Override public void run(String result) {
                Log.i(TAG, "素材同步结束: " + result);
                reloadPack();
            }
        });
    }

    // 注意：@JavascriptInterface 的方法跑在 WebView 的 JS 桥线程上，不是 UI 线程。
    // 直接改 WindowManager.LayoutParams 并 updateViewLayout 会抛 CalledFromWrongThreadException
    // 把整个进程打崩（实测：桌宠一启动就崩、服务被系统重启、日志刷满 AndroidRuntime）。
    // 所有窗口操作必须先 post 回主线程。
    private void setPassthrough(final boolean v) {
        ui.post(new Runnable() {
            @Override public void run() {
                if (v == passthrough) return;
                passthrough = v;
                if (v) {
                    params.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                } else {
                    params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                    params.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                }
                if (web != null && web.isAttachedToWindow()) wm.updateViewLayout(web, params);
                Log.i(TAG, "passthrough=" + v);
            }
        });
    }

    private void resize(final int w, final int h) {
        if (w <= 0 || h <= 0) return;
        ui.post(new Runnable() {
            @Override public void run() {
                params.width = w;
                params.height = h;
                if (web != null && web.isAttachedToWindow()) wm.updateViewLayout(web, params);
                Log.i(TAG, "resize=" + w + "x" + h);
            }
        });
    }

    @Override public void onDestroy() {
        INSTANCE = null;
        if (web != null && wm != null) {
            try { wm.removeView(web); } catch (Exception ignored) { }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** JS -> Native：window.PetBridge.postMessage(JSON.stringify({id, method, params})) */
    private final class Bridge {
        @JavascriptInterface public void postMessage(String json) {
            Log.i(TAG, "[bridge] " + json);
            String method = str(json, "method");
            if (method == null) return;
            if (method.equals("setClickThrough")) setPassthrough(bool(json, "value"));
            else if (method.equals("dragStart")) dragging = true;
            else if (method.equals("dragEnd")) dragging = false;
            else if (method.equals("resize")) resize((int) num(json, "width"), (int) num(json, "height"));
            else if (method.equals("quit")) ui.post(new Runnable() { @Override public void run() { stopSelf(); } });
            else if (method.equals("log")) Log.i(TAG, "[renderer] " + str(json, "line"));
        }
    }

    /** 极简 JSON 取值：本壳刻意零第三方依赖，不值得为取两个字段引 Gson。 */
    private static String str(String json, String key) {
        String k = "\"" + key + "\"";
        int i = json.indexOf(k);
        if (i < 0) return null;
        i = json.indexOf(':', i + k.length());
        if (i < 0) return null;
        i++;
        while (i < json.length() && json.charAt(i) == ' ') i++;
        if (i >= json.length()) return null;
        if (json.charAt(i) == '"') {
            int j = json.indexOf('"', i + 1);
            return j < 0 ? null : json.substring(i + 1, j);
        }
        int j = i;
        while (j < json.length() && ",}".indexOf(json.charAt(j)) < 0) j++;
        return json.substring(i, j).trim();
    }

    private static double num(String json, String key) {
        String s = str(json, key);
        try { return s == null ? 0 : Double.parseDouble(s); } catch (Exception e) { return 0; }
    }

    private static boolean bool(String json, String key) {
        String s = str(json, key);
        return s != null && s.startsWith("true");
    }

    /** shouldInterceptRequest 把 http://pet.local/ 映射到 APK assets/web/，零依赖、零 androidx。 */
    private static final class LocalClient extends WebViewClient {
        private static final Map<String, String> MIME = new HashMap<String, String>();
        static {
            MIME.put("html", "text/html");
            MIME.put("js", "application/javascript");
            MIME.put("mjs", "application/javascript");
            MIME.put("json", "application/json");
            MIME.put("css", "text/css");
            MIME.put("png", "image/png");
            MIME.put("jpg", "image/jpeg");
            MIME.put("svg", "image/svg+xml");
        }

        static String mimeOf(String path) {
            String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase() : "";
            return MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String path = request.getUrl().getPath();
            if (path == null || path.equals("/")) path = "/src/index.html";
            // 先看「已下载 / 用户投放」的目录，再回落到 APK 内置 assets。
            // 顺序不能反：内置的只有自绘 chibi，第三方素材是运行时拉下来的。
            if (path.startsWith("/assets/packs/")) {
                String rel = path.substring("/assets/packs/".length());
                // 顺序不能反：先看「已下载 / 用户投放」的目录，再回落 APK 内置 assets。
                // 内置的只有自绘 chibi，第三方素材是运行时拉下来的。
                File f = new File(PackFetcher.packRoot(view.getContext()), rel);
                if (f.isFile()) {
                    try {
                        return new WebResourceResponse(mimeOf(path), "utf-8", new FileInputStream(f));
                    } catch (IOException e) {
                        // 外部文件存在但读取失败（被回收/并发写）：记到 logcat，
                        // 不吞异常，继续往下走回落内置 assets。
                        Log.w(TAG, "pack 文件读取失败: " + f + " -> " + e.getMessage());
                    }
                }
                // 落到内置 assets：APK 里也烘了一份 chibi，未同步时不至于白屏。
                // 只放行 chibi 子目录，避免把用户下载的别的东西顶替掉。
                if (rel.startsWith("chibi/")) {
                    String builtin = "web/assets/packs/" + rel;
                    try (InputStream in = view.getContext().getAssets().open(builtin)) {
                        return new WebResourceResponse(mimeOf(path), "utf-8", in);
                    } catch (IOException ignored) { }
                }
            }
            String rel = "web" + path;
            try {
                InputStream in = view.getContext().getAssets().open(rel);
                return new WebResourceResponse(mimeOf(path), "utf-8", in);
            } catch (IOException e) {
                Log.w(TAG, "asset 缺失: " + rel);
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), null);
            }
        }
    }
}

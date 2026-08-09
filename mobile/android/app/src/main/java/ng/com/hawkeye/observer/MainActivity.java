package ng.com.hawkeye.observer;

import android.os.Bundle;
import android.os.Handler;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

/**
 * HOLD THE SYSTEM SPLASH UNTIL THE PAGE HAS ACTUALLY PAINTED.
 *
 * The Android 12+ system splash (values-v31/styles.xml: green field +
 * windowSplashScreenAnimatedIcon) is the ONLY thing that has ever drawn the hawk
 * correctly. Its problem was never how it looks, it is how long it lasts: the
 * platform dismisses it the moment the activity draws its first frame, which
 * happens long before the WebView has any content in it.
 *
 * On a RELAUNCH the web assets are warm, the page paints almost immediately, and
 * the splash is still what you see — which is why it "worked". On a FIRST INSTALL
 * nothing is cached, the WebView takes seconds, and the splash is long gone by
 * then, leaving a bare field. Same code, different timing.
 *
 * Setting the activity theme's windowBackground was not enough on its own:
 * Capacitor's WebView paints its own opaque background as soon as it is laid
 * out, so it covers the window before the page has anything to show.
 *
 * setKeepOnScreenCondition is the supported way to extend the real splash, so
 * the thing that already renders correctly simply stays until there is something
 * worth swapping to.
 *
 * THE CAP IS NOT OPTIONAL. A splash held on a condition that never flips is an
 * app that never starts, so the deadline below is armed unconditionally and
 * releases the splash regardless of what the WebView is doing.
 */
public class MainActivity extends BridgeActivity {

    /** Flipped when the page is ready, or when the deadline fires — whichever first. */
    private volatile boolean readyToDraw = false;

    private static final long MAX_HOLD_MS = 6000;
    private static final long POLL_MS = 100;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be installed BEFORE super.onCreate for the platform to hand the
        // splash over to us rather than dismissing it on first draw.
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        splash.setKeepOnScreenCondition(() -> !readyToDraw);

        final Handler handler = new Handler(getMainLooper());
        handler.postDelayed(() -> readyToDraw = true, MAX_HOLD_MS);

        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (readyToDraw) return;
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.getProgress() >= 100) {
                    readyToDraw = true;
                    return;
                }
                handler.postDelayed(this, POLL_MS);
            }
        }, POLL_MS);
    }
}

package ng.com.hawkeye.observer;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * THE SPLASH STAYS UNTIL THE PAGE HAS DRAWN, as on iPhone.
 *
 * Released at first frame, the system splash (green + hawk) gave way to the
 * activity's plain green window for a split second before the WebView painted:
 * hawk, blank green, page. It is now held until the first page has loaded AND
 * been drawn (postVisualStateCallback), capped at 6 s.
 *
 * EXCEPT on the first launch of each build. Android 12+ omits the icon on the
 * first launch after an install (issuetracker.google.com/205021357). An earlier
 * hold kept that icon-less splash up and hid the web layer's hawk, which is why
 * it was removed. So the first launch of every versionCode is never held: it
 * goes straight to the page's own green + hawk (index.html), as before.
 */
public class MainActivity extends BridgeActivity {
    private volatile boolean ready = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        if (firstLaunchOfThisBuild()) return;
        splash.setKeepOnScreenCondition(() -> !ready);
        new Handler(Looper.getMainLooper()).postDelayed(() -> ready = true, 6000);
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                webView.postVisualStateCallback(1, new WebView.VisualStateCallback() {
                    @Override
                    public void onComplete(long requestId) { ready = true; }
                });
            }
        });
    }

    private boolean firstLaunchOfThisBuild() {
        try {
            long code = PackageInfoCompat.getLongVersionCode(
                getPackageManager().getPackageInfo(getPackageName(), 0));
            SharedPreferences p = getSharedPreferences("hk_launch", MODE_PRIVATE);
            boolean first = p.getLong("build", -1) != code;
            if (first) p.edit().putLong("build", code).apply();
            return first;
        } catch (Exception e) {
            return true; // unsure: behave as before (no hold)
        }
    }
}

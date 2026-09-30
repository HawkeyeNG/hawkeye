package ng.com.hawkeye.observer;

import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * DEVICE SIGNALS for the server's "count devices, not accounts" rule
 * (backend services/clusters.js; app/device.js getDeviceSignals).
 *
 * Answers ONE question: is the native Hawkeye app (ng.com.hawkeye.observer)
 * installed on this phone? A yes/no sent with a report — nothing about that
 * app's account or ids is ever read. Package visibility (Android 11+) hides
 * every other app anyway; the <queries> entry in AndroidManifest.xml names
 * this one package and no other.
 *
 * Registered in MainActivity. Feature-detected in the web layer: builds
 * before this plugin simply have no Capacitor.Plugins.HawkeyeDevice.
 *
 * NOTE the Java package is ng.com.hawkeye.observer for historical reasons
 * (build.gradle namespace); this app's applicationId is ng.com.hawkeye.lite.
 * The package asked about below is the OTHER app's applicationId.
 */
@CapacitorPlugin(name = "HawkeyeDevice")
public class HawkeyeDevicePlugin extends Plugin {
    private static final String NATIVE_APP = "ng.com.hawkeye.observer";

    @PluginMethod
    public void signals(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("sibling", isInstalled(NATIVE_APP));
        call.resolve(ret);
    }

    @SuppressWarnings("deprecation")
    private boolean isInstalled(String pkg) {
        PackageManager pm = getContext().getPackageManager();
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0));
            } else {
                pm.getPackageInfo(pkg, 0);
            }
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
}

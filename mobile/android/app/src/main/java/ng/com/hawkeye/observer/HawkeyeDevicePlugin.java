package ng.com.hawkeye.observer;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

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
 *
 * Also `androidId`: Settings.Secure.ANDROID_ID, for one phone = one counting
 * account per election (backend services/deviceClaims.js). One value per
 * (Lite's signing key, user, phone); an uninstall/reinstall keeps it, a factory
 * reset changes it. No permission needed; the server keeps only a peppered
 * hash. Omitted when Android gives none.
 *
 * And `callPermission` / `placeCall`: the missed-call sign-up dials our number
 * itself once CALL_PHONE is granted (asked when the observer PICKS Call — app.js
 * — with Android's own prompt, no pre-prompt). Anything short of a grant leaves
 * the web layer on its tel: link, i.e. the dialler with our number typed in.
 */
@CapacitorPlugin(
    name = "HawkeyeDevice",
    permissions = { @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE }) }
)
public class HawkeyeDevicePlugin extends Plugin {
    private static final String NATIVE_APP = "ng.com.hawkeye.observer";

    @PluginMethod
    public void callPermission(PluginCall call) {
        if (getPermissionState("phone") == PermissionState.GRANTED) {
            callPermissionResult(call);
            return;
        }
        requestPermissionForAlias("phone", call, "callPermissionResult");
    }

    @PermissionCallback
    private void callPermissionResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("phone") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    /** Dials `tel` (tel:+234…) directly. Rejects without the grant, so the caller falls back to tel:. */
    @PluginMethod
    public void placeCall(PluginCall call) {
        String tel = call.getString("tel", "");
        if (tel == null || !tel.matches("^tel:\\+?\\d{6,15}$")) {
            call.reject("bad_number");
            return;
        }
        if (getPermissionState("phone") != PermissionState.GRANTED) {
            call.reject("not_allowed");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse(tel));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("failed");
        }
    }

    @PluginMethod
    public void signals(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("sibling", isInstalled(NATIVE_APP));
        String aid = androidId();
        if (aid != null && !aid.isEmpty()) ret.put("androidId", aid);
        call.resolve(ret);
    }

    private String androidId() {
        try {
            return Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Exception e) {
            return null;
        }
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

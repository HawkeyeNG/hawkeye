package expo.modules.hawkeyedevice

import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Is the OTHER Hawkeye app installed on this phone? (src/lib/device-signals.ts)
 *
 * Answers only for the packages listed in ALLOWED, which is also the only
 * package this module's manifest declares in <queries> — Android 11+ hides
 * every other app from getPackageInfo anyway. A yes/no; nothing else about the
 * other app is read.
 */
class HawkeyeDeviceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HawkeyeDevice")

    Function("isPackageInstalled") { pkg: String ->
      isInstalled(pkg)
    }
  }

  private fun isInstalled(pkg: String): Boolean {
    if (pkg !in ALLOWED) return false
    val pm = appContext.reactContext?.packageManager ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= 33) {
        pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(pkg, 0)
      }
      true
    } catch (e: PackageManager.NameNotFoundException) {
      false
    }
  }

  companion object {
    private val ALLOWED = setOf("ng.com.hawkeye.lite")
  }
}

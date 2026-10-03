package ng.com.hawkeye.callgate

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network

/** Sends anything still queued when the process starts and whenever the network comes back. */
class GateApp : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) = Hook.flush(this@GateApp)
                },
            )
        } catch (_: Exception) { /* the 30 s retry still runs */ }
        Hook.flush(this)
    }
}

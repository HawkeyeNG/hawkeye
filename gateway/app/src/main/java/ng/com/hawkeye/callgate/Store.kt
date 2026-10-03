package ng.com.hawkeye.callgate

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray

/**
 * Settings. The server URL and the keep-awake switch are plain preferences.
 * THE HOOK SECRET AND THE QUEUE OF CALLER NUMBERS ARE ENCRYPTED AT REST
 * (EncryptedSharedPreferences, key in the Android Keystore): the secret signs
 * every hook, and a queued number is a phone number until it is sent.
 */
object Store {
    const val DEFAULT_SERVER = "https://hawkeye.com.ng"
    /** The server refuses a shorter secret, so the app does too. */
    const val MIN_SECRET_LEN = 16

    private const val PLAIN = "callgate"
    private const val SECURE = "callgate_secure"
    private var secure: SharedPreferences? = null

    fun plain(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PLAIN, Context.MODE_PRIVATE)

    @Synchronized
    fun secure(ctx: Context): SharedPreferences {
        secure?.let { return it }
        val app = ctx.applicationContext
        val key = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        val prefs = EncryptedSharedPreferences.create(
            app, SECURE, key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        secure = prefs
        return prefs
    }

    fun server(ctx: Context): String =
        plain(ctx).getString("server", null)?.takeIf { it.isNotBlank() } ?: DEFAULT_SERVER

    fun setServer(ctx: Context, url: String) {
        plain(ctx).edit().putString("server", url.trim().trimEnd('/')).apply()
    }

    /**
     * As the server folds it: spaces and dashes out, upper-cased. The owner's
     * script shows 24 base32 characters as XXXX-XXXX-…, and that is what gets typed.
     */
    fun normalizeSecret(typed: String): String = typed.replace(Regex("[\\s-]"), "").uppercase()

    fun secret(ctx: Context): String = secure(ctx).getString("secret", "") ?: ""

    fun setSecret(ctx: Context, value: String) {
        secure(ctx).edit().putString("secret", normalizeSecret(value)).commit()
    }

    /**
     * THE GATEWAY SIM. On a dual-SIM phone only calls arriving on this SIM are
     * rejected and reported; -1 = none chosen, and then nothing is rejected.
     */
    fun simSubId(ctx: Context): Int = plain(ctx).getInt("simSubId", -1)
    fun simHandle(ctx: Context): String = plain(ctx).getString("simHandle", "") ?: ""
    fun simLabel(ctx: Context): String = plain(ctx).getString("simLabel", "") ?: ""

    fun setSim(ctx: Context, subId: Int, handleKey: String, label: String) {
        plain(ctx).edit().putInt("simSubId", subId).putString("simHandle", handleKey).putString("simLabel", label).commit()
    }

    fun keepAwake(ctx: Context): Boolean = plain(ctx).getBoolean("keepAwake", false)

    fun setKeepAwake(ctx: Context, on: Boolean) {
        plain(ctx).edit().putBoolean("keepAwake", on).apply()
    }
}

/**
 * Events waiting for the server, oldest first, in the encrypted store. commit(),
 * not apply(): a call is written down before anything tries to send it, so a
 * process killed mid-send loses nothing.
 */
object Queue {
    @Synchronized
    fun add(ctx: Context, ev: Event) {
        val list = load(ctx)
        list.add(ev)
        save(ctx, list)
    }

    @Synchronized
    fun remove(ctx: Context, id: String) {
        save(ctx, load(ctx).filterNot { it.id == id })
    }

    /** Drops what is too old to prove anything, returns what is left. */
    @Synchronized
    fun prune(ctx: Context, now: Long): List<Event> {
        val list = load(ctx)
        val (old, live) = list.partition { now - it.at > Event.MAX_AGE_MS }
        if (old.isNotEmpty()) {
            save(ctx, live)
            old.forEach { EventLog.update(ctx, it.id, "dropped: over 10 min old") }
        }
        return live
    }

    @Synchronized
    fun size(ctx: Context): Int = load(ctx).size

    private fun load(ctx: Context): MutableList<Event> {
        val raw = Store.secure(ctx).getString("queue", "[]") ?: "[]"
        val out = mutableListOf<Event>()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) Event.fromJson(arr.getJSONObject(i))?.let { out.add(it) }
        } catch (_: Exception) { /* unreadable: start empty */ }
        return out
    }

    private fun save(ctx: Context, list: List<Event>) {
        val arr = JSONArray()
        list.forEach { arr.put(it.toJson()) }
        Store.secure(ctx).edit().putString("queue", arr.toString()).commit()
    }
}

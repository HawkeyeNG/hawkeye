package ng.com.hawkeye.callgate

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The last 20 events for the screen: time, LAST THREE DIGITS ONLY, and what the
 * server said. Never a whole number — this is what someone glancing at the
 * gateway phone can read.
 */
object EventLog {
    const val KEY = "log"
    private const val MAX = 20

    @Synchronized
    fun add(ctx: Context, id: String, at: Long, tail: String, status: String) {
        val list = load(ctx)
        list.add(0, JSONObject().put("id", id).put("t", at).put("tail", tail).put("status", status))
        while (list.size > MAX) list.removeAt(list.size - 1)
        save(ctx, list)
    }

    @Synchronized
    fun update(ctx: Context, id: String, status: String) {
        val list = load(ctx)
        val hit = list.firstOrNull { it.optString("id") == id } ?: return
        hit.put("status", status)
        save(ctx, list)
    }

    /** "14:02:31  …567  sent (200)", newest first. */
    @Synchronized
    fun lines(ctx: Context): List<String> {
        val fmt = SimpleDateFormat("dd MMM HH:mm:ss", Locale.getDefault())
        return load(ctx).map { o ->
            "${fmt.format(Date(o.optLong("t")))}  …${o.optString("tail")}  ${o.optString("status")}"
        }
    }

    private fun load(ctx: Context): MutableList<JSONObject> {
        val out = mutableListOf<JSONObject>()
        try {
            val arr = JSONArray(Store.plain(ctx).getString(KEY, "[]") ?: "[]")
            for (i in 0 until arr.length()) out.add(arr.getJSONObject(i))
        } catch (_: Exception) { /* unreadable: start empty */ }
        return out
    }

    private fun save(ctx: Context, list: List<JSONObject>) {
        val arr = JSONArray()
        list.forEach { arr.put(it) }
        Store.plain(ctx).edit().putString(KEY, arr.toString()).apply()
    }
}

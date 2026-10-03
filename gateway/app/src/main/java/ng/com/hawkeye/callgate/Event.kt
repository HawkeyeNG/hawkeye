package ng.com.hawkeye.callgate

import org.json.JSONObject
import java.util.UUID

/**
 * One rejected call, as the server's /api/observers/call-hook takes it:
 * { from, at, id, vs } — or { from: "", at, id, test: true } for "send test event".
 * `vs` is the network's STIR/SHAKEN verdict on the caller ID where it gives one;
 * the server never accepts a call marked "failed".
 */
data class Event(
    val id: String,
    val from: String,
    val at: Long,
    val vs: String? = null,
    val test: Boolean = false,
) {
    /** The exact bytes that are signed and sent. */
    fun body(): String = toJson().toString()

    fun toJson(): JSONObject = JSONObject().apply {
        put("from", from)
        put("at", at)
        put("id", id)
        if (vs != null) put("vs", vs)
        if (test) put("test", true)
    }

    companion object {
        /** Older than this, a call proves nothing on the server either: dropped. */
        const val MAX_AGE_MS = 10 * 60_000L

        fun newId(): String = UUID.randomUUID().toString().replace("-", "")

        fun test(): Event = Event(newId(), "", System.currentTimeMillis(), null, true)

        /** The last three digits — ALL the log ever shows of a number. */
        fun tail(number: String): String = number.filter { it.isDigit() }.takeLast(3).ifEmpty { "---" }

        fun fromJson(o: JSONObject): Event? = try {
            Event(
                id = o.getString("id"),
                from = o.optString("from", ""),
                at = o.getLong("at"),
                vs = if (o.has("vs")) o.getString("vs") else null,
                test = o.optBoolean("test", false),
            )
        } catch (_: Exception) {
            null
        }
    }
}

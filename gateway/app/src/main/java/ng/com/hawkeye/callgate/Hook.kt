package ng.com.hawkeye.callgate

import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Sends events to <server>/api/observers/call-hook, signed:
 *   X-Callgate-Timestamp: unix seconds
 *   X-Callgate-Signature: hex HMAC-SHA256(secret, "<timestamp>.<body>")
 * Re-signed on every attempt, so a retry minutes later is never stale.
 *
 * ONE THREAD sends, oldest event first. A failure is retried a few times with
 * backoff; still failing, the event waits in the encrypted queue and is tried
 * again every 30 s, on the next call, when the network returns and when the app
 * opens — until it is sent or is 10 minutes old.
 */
object Hook {
    private const val PATH = "/api/observers/call-hook"
    private val BACKOFF_MS = longArrayOf(0, 2_000, 5_000, 10_000)
    private const val LATER_MS = 30_000L
    private val exec = Executors.newSingleThreadScheduledExecutor()
    private var laterScheduled = false // touched only on `exec`

    private enum class Outcome { DONE, DROP, RETRY, HOLD }
    private data class Result(val outcome: Outcome, val label: String)

    /** A call was rejected: write it down (on disk) first, then send. */
    fun submit(ctx: Context, ev: Event) {
        val app = ctx.applicationContext
        Queue.add(app, ev)
        exec.execute { flushNow(app) }
    }

    fun flush(ctx: Context) {
        val app = ctx.applicationContext
        exec.execute { flushNow(app) }
    }

    /** "Send test event": one signed post, not queued; `done` gets the server's answer. */
    fun sendTest(ctx: Context, done: (String) -> Unit) {
        val app = ctx.applicationContext
        exec.execute {
            val ev = Event.test()
            EventLog.add(app, ev.id, ev.at, "test", "test: sending…")
            val r = post(app, ev)
            val label = if (r.outcome == Outcome.DONE) "test OK — server accepted the signature" else "test failed: ${r.label}"
            EventLog.update(app, ev.id, label)
            done(label)
        }
    }

    private fun flushNow(app: Context) {
        while (true) {
            val ev = Queue.prune(app, System.currentTimeMillis()).firstOrNull() ?: return
            val r = deliver(app, ev)
            when (r.outcome) {
                Outcome.DONE, Outcome.DROP -> {
                    Queue.remove(app, ev.id)
                    EventLog.update(app, ev.id, r.label)
                }
                Outcome.RETRY, Outcome.HOLD -> {
                    EventLog.update(app, ev.id, "queued: ${r.label}")
                    later(app)
                    return
                }
            }
        }
    }

    private fun later(app: Context) {
        if (laterScheduled) return
        laterScheduled = true
        exec.schedule({ laterScheduled = false; flushNow(app) }, LATER_MS, TimeUnit.MILLISECONDS)
    }

    /** One event, with backoff for what a retry can fix (offline, 5xx, 429). */
    private fun deliver(app: Context, ev: Event): Result {
        var last = Result(Outcome.RETRY, "not sent")
        for (wait in BACKOFF_MS) {
            if (wait > 0) Thread.sleep(wait)
            if (System.currentTimeMillis() - ev.at > Event.MAX_AGE_MS) return Result(Outcome.DROP, "dropped: over 10 min old")
            last = post(app, ev)
            if (last.outcome != Outcome.RETRY) return last
        }
        return last
    }

    private fun post(app: Context, ev: Event): Result {
        val secret = Store.secret(app)
        if (secret.length < Store.MIN_SECRET_LEN) return Result(Outcome.HOLD, "no secret set on this phone")
        val body = ev.body()
        val ts = (System.currentTimeMillis() / 1000).toString()
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(Store.server(app) + PATH).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 15_000
                doOutput = true
                // A redirect would turn the POST into a GET somewhere else: never follow one.
                instanceFollowRedirects = false
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("User-Agent", "HawkeyeCallGate/1.0")
                setRequestProperty("X-Callgate-Timestamp", ts)
                setRequestProperty("X-Callgate-Signature", hmacHex(secret, "$ts.$body"))
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val text = try {
                (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText().take(300) } ?: ""
            } catch (_: IOException) { "" }
            val error = try { JSONObject(text).optString("error") } catch (_: Exception) { "" }
            when {
                code in 200..299 -> Result(Outcome.DONE, "sent ($code)")
                code == 400 -> Result(Outcome.DROP, "refused (400 ${error.ifEmpty { "bad request" }})")
                code == 401 && error == "stale_timestamp" -> Result(Outcome.HOLD, "401: this phone's clock is off — set automatic time")
                code == 401 -> Result(Outcome.HOLD, "401: wrong secret — check it matches the server")
                code == 503 && error == "call_unavailable" -> Result(Outcome.HOLD, "503: missed-call sign-in is not set up on the server")
                code == 429 || code >= 500 -> Result(Outcome.RETRY, "server busy ($code)")
                code in 300..399 -> Result(Outcome.HOLD, "redirect ($code) — check the server URL")
                else -> Result(Outcome.HOLD, "HTTP $code ${error}".trim())
            }
        } catch (e: IOException) {
            Result(Outcome.RETRY, "offline (${e.javaClass.simpleName})")
        } catch (e: Exception) {
            Result(Outcome.HOLD, "error (${e.javaClass.simpleName}) — check the server URL")
        } finally {
            conn?.disconnect()
        }
    }

    private fun hmacHex(secret: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(message.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}

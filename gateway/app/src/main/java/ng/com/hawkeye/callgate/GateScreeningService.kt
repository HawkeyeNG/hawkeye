package ng.com.hawkeye.callgate

import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import android.telecom.Connection
import android.telecom.TelecomManager

/**
 * Every incoming call ON THE GATEWAY SIM is REJECTED — it never connects, so it
 * costs the caller nothing — and its number is posted to the server, which
 * marks that number's pending sign-up proved. The rejection comes first: the
 * system gives a screening app only a few seconds to answer.
 */
class GateScreeningService : CallScreeningService() {

    override fun onScreenCall(details: Call.Details) {
        // THE OWNER'S OWN LINE MAY SHARE THIS PHONE. Outgoing calls, calls on any
        // other SIM, no SIM chosen, or a SIM that cannot be told: the call goes
        // through untouched and is never logged or reported (fail open).
        val gateway = try {
            android.util.Log.i("Callgate", "onScreenCall: direction=${details.callDirection}")
            details.callDirection == Call.Details.DIRECTION_INCOMING && Sims.isGatewaySim(this, details.accountHandle)
        } catch (e: Exception) {
            android.util.Log.w("Callgate", "screen failed: $e")
            false
        }
        android.util.Log.i("Callgate", "decision: reject=$gateway")
        if (!gateway) {
            respondToCall(details, CallResponse.Builder().build())
            return
        }
        respondToCall(
            details,
            CallResponse.Builder()
                .setDisallowCall(true)
                .setRejectCall(true)
                .setSkipCallLog(true) // the app keeps its own log; the phone's call history stays clean
                .setSkipNotification(true)
                .build(),
        )

        val at = System.currentTimeMillis()
        val id = Event.newId()
        val number = if (details.handlePresentation == TelecomManager.PRESENTATION_ALLOWED) {
            details.handle?.schemeSpecificPart.orEmpty()
        } else ""
        if (number.isBlank()) {
            // A withheld number proves nothing; nothing is sent.
            EventLog.add(this, id, at, "---", "rejected: number withheld, not sent")
            return
        }
        EventLog.add(this, id, at, Event.tail(number), "rejected, sending…")
        Hook.submit(this, Event(id, number, at, verification(details)))
    }

    /** The network's STIR/SHAKEN verdict on the caller ID (Android 11+); most Nigerian calls are "not_verified". */
    private fun verification(details: Call.Details): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "not_verified"
        return when (details.callerNumberVerificationStatus) {
            Connection.VERIFICATION_STATUS_PASSED -> "passed"
            Connection.VERIFICATION_STATUS_FAILED -> "failed"
            else -> "not_verified"
        }
    }
}

package ng.com.hawkeye.callgate

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager

/**
 * Which SIM a call came in on. The gateway may share a dual-SIM phone with
 * the owner's own line, so only calls on the CHOSEN SIM are rejected — and
 * anything that cannot be matched FAILS OPEN: the call rings, nothing is sent.
 */
object Sims {
    data class Line(val subId: Int, val label: String, val handleKey: String)

    fun handleKey(h: PhoneAccountHandle): String = "${h.componentName.flattenToString()}|${h.id}"

    fun canRead(ctx: Context): Boolean =
        ctx.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED

    /** The active SIMs, slot order; null without READ_PHONE_STATE. */
    @SuppressLint("MissingPermission")
    fun list(ctx: Context): List<Line>? {
        if (!canRead(ctx)) return null
        val sm = ctx.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
        val infos = try { sm.activeSubscriptionInfoList } catch (_: Exception) { null } ?: return emptyList()
        val accounts = callAccounts(ctx)
        return infos.sortedBy { it.simSlotIndex }.map { info ->
            val subId = info.subscriptionId
            val carrier = (info.carrierName ?: info.displayName ?: "").toString().trim().ifEmpty { "SIM" }
            val last4 = number(ctx, sm, info).filter { it.isDigit() }.takeLast(4)
            val label = "SIM ${info.simSlotIndex + 1} · $carrier" + if (last4.length == 4) " · …$last4" else ""
            val iccid = try { info.iccId.orEmpty() } catch (_: Exception) { "" }
            val handle = accounts.firstOrNull { subIdOf(ctx, it) == subId }
                ?: accounts.firstOrNull { it.id == subId.toString() || (iccid.isNotEmpty() && it.id.startsWith(iccid)) }
            Line(subId, label, handle?.let { handleKey(it) } ?: "")
        }
    }

    /** The line's own number where the phone will say it (often it will not). */
    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private fun number(ctx: Context, sm: SubscriptionManager, info: SubscriptionInfo): String = try {
        when {
            ctx.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) != PackageManager.PERMISSION_GRANTED -> ""
            Build.VERSION.SDK_INT >= 33 -> sm.getPhoneNumber(info.subscriptionId)
            else -> info.number.orEmpty()
        }
    } catch (_: Exception) {
        ""
    }

    @SuppressLint("MissingPermission")
    private fun callAccounts(ctx: Context): List<PhoneAccountHandle> = try {
        ctx.getSystemService(TelecomManager::class.java)?.callCapablePhoneAccounts ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    /** The subscription a phone account belongs to (Android 11+), or null when the phone will not say. */
    @SuppressLint("MissingPermission")
    fun subIdOf(ctx: Context, h: PhoneAccountHandle): Int? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return try {
            val id = ctx.getSystemService(TelephonyManager::class.java)?.getSubscriptionId(h)
                ?: return null
            if (id == SubscriptionManager.INVALID_SUBSCRIPTION_ID) null else id
        } catch (_: Exception) {
            null
        }
    }

    /** Subscriptions whose line is ringing now (Android 12+, READ_PHONE_STATE); empty when unknown. */
    @SuppressLint("MissingPermission")
    fun ringingSubs(ctx: Context): List<Int> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !canRead(ctx)) return emptyList()
        return try {
            val sm = ctx.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
            val tm = ctx.getSystemService(TelephonyManager::class.java) ?: return emptyList()
            (sm.activeSubscriptionInfoList ?: emptyList()).map { it.subscriptionId }.filter { sub ->
                tm.createForSubscriptionId(sub).callStateForSubscription == TelephonyManager.CALL_STATE_RINGING
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Did this call arrive on the gateway SIM? No SIM chosen, or no way to tell: false. */
    fun isGatewaySim(ctx: Context, h: PhoneAccountHandle?): Boolean {
        val chosen = Store.simSubId(ctx)
        if (chosen < 0) return false
        // NO HANDLE IS THE NORM, NOT THE EXCEPTION. A screening app that is not
        // the dialer gets Call.Details with accountHandle == null (seen on a Z Fold 5,
        // Android 16), so ask telephony which SIM is RINGING right now instead —
        // the modem reports the call before Telecom asks us to screen it.
        if (h == null) {
            val ringing = ringingSubs(ctx)
            android.util.Log.i("Callgate", "screen: no handle; ringing=$ringing chosen=$chosen")
            return ringing.size == 1 && ringing[0] == chosen
        }
        // The handle saved when the SIM was chosen is the exact identity Telecom
        // hands us — compare it FIRST. (On a Z Fold 5 the call arrived on the
        // saved handle yet was let through, so the sub-id path is not trusted
        // to veto an exact handle match.)
        val key = Store.simHandle(ctx)
        val sub = subIdOf(ctx, h)
        android.util.Log.i("Callgate", "screen: handle=${handleKey(h)} saved=$key sub=$sub chosen=$chosen")
        if (key.isNotEmpty() && key == handleKey(h)) return true
        sub?.let { return it == chosen }
        // Older Android: a SIM's phone account id is commonly its subscription id.
        return h.id == chosen.toString()
    }
}

package ng.com.hawkeye.callgate

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.SharedPreferences
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * The one screen: the call-screening role, the gateway SIM, the server URL, the
 * shared secret (never shown back), a test event, keep-awake, and the last 20 events.
 */
class MainActivity : Activity() {
    private val bg = Executors.newSingleThreadExecutor()
    private lateinit var roleStatus: TextView
    private lateinit var roleButton: Button
    private lateinit var simStatus: TextView
    private lateinit var server: EditText
    private lateinit var secretStatus: TextView
    private lateinit var secret: EditText
    private lateinit var queueStatus: TextView
    private lateinit var log: TextView

    private val logListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == EventLog.KEY) runOnUiThread { refreshLog() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        roleStatus = findViewById(R.id.role_status)
        roleButton = findViewById(R.id.role_button)
        simStatus = findViewById(R.id.sim_status)
        server = findViewById(R.id.server)
        secretStatus = findViewById(R.id.secret_status)
        secret = findViewById(R.id.secret)
        queueStatus = findViewById(R.id.queue_status)
        log = findViewById(R.id.log)

        server.setText(Store.server(this))
        roleButton.setOnClickListener { requestRole() }
        findViewById<Button>(R.id.sim_button).setOnClickListener { chooseSim() }
        findViewById<Button>(R.id.save).setOnClickListener { save() }
        findViewById<Button>(R.id.test).setOnClickListener {
            Toast.makeText(this, "Sending test event…", Toast.LENGTH_SHORT).show()
            Hook.sendTest(this) { label -> runOnUiThread { Toast.makeText(this, label, Toast.LENGTH_LONG).show() } }
        }
        val awake = findViewById<Switch>(R.id.keep_awake)
        awake.isChecked = Store.keepAwake(this)
        applyKeepAwake(awake.isChecked)
        awake.setOnCheckedChangeListener { _, on ->
            Store.setKeepAwake(this, on)
            applyKeepAwake(on)
        }
    }

    override fun onResume() {
        super.onResume()
        Store.plain(this).registerOnSharedPreferenceChangeListener(logListener)
        refreshRole()
        refreshSim()
        refreshSecret()
        refreshLog()
        Hook.flush(this)
    }

    override fun onPause() {
        Store.plain(this).unregisterOnSharedPreferenceChangeListener(logListener)
        super.onPause()
    }

    @Deprecated("Activity result API without androidx")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_ROLE) refreshRole()
    }

    private fun requestRole() {
        val rm = getSystemService(RoleManager::class.java)
        if (rm == null || !rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) {
            Toast.makeText(this, "This phone does not offer call screening to apps.", Toast.LENGTH_LONG).show()
            return
        }
        @Suppress("DEPRECATION")
        startActivityForResult(rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING), REQ_ROLE)
    }

    private fun refreshRole() {
        val held = getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
        roleStatus.text = if (held) "✓ Call screening: ON — calls to the gateway SIM are rejected and reported"
        else "✗ Call screening: OFF — calls ring normally and nothing is reported"
        roleButton.isEnabled = !held
    }

    /** READ_PHONE_STATE lists the SIMs; READ_PHONE_NUMBERS shows each line's last four digits. */
    private fun chooseSim() {
        val want = arrayOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_PHONE_NUMBERS)
        if (want.any { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }) {
            requestPermissions(want, REQ_PHONE)
            return
        }
        showSimPicker()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PHONE) return
        if (Sims.canRead(this)) showSimPicker()
        else Toast.makeText(this, "Without the phone permission this app cannot tell your SIMs apart, so it rejects nothing.", Toast.LENGTH_LONG).show()
        refreshSim()
    }

    private fun showSimPicker() {
        val lines = Sims.list(this).orEmpty()
        if (lines.isEmpty()) {
            Toast.makeText(this, "No active SIM found.", Toast.LENGTH_LONG).show()
            return
        }
        // "Every SIM" is for a phone kept only as a gateway, with a gateway number
        // in each slot: every incoming call is verified, whichever SIM it rings.
        val items = lines.map { it.label } + "Every SIM in this phone" + "None — reject nothing"
        AlertDialog.Builder(this)
            .setTitle("Which SIM is the gateway?")
            .setItems(items.toTypedArray()) { _, i ->
                when {
                    i < lines.size -> Store.setSim(this, lines[i].subId, lines[i].handleKey, lines[i].label)
                    i == lines.size -> Store.setSim(this, Store.ALL_SIMS, "", "Every SIM in this phone")
                    else -> Store.setSim(this, -1, "", "")
                }
                refreshSim()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun refreshSim() {
        val chosen = Store.simSubId(this)
        simStatus.text = when {
            chosen == Store.ALL_SIMS -> "✓ Gateway SIMs: every SIM in this phone (${Sims.list(this)?.size ?: 0} active) — every incoming call is verified"
            chosen < 0 ->"✗ Gateway SIM: none chosen — every call rings normally, nothing is rejected"
            !Sims.canRead(this) -> "✗ Gateway SIM: ${Store.simLabel(this)} — but the phone permission is off, so nothing is rejected. Tap \"Choose the gateway SIM\"."
            Sims.list(this)?.none { it.subId == chosen } == true ->
                "✗ Gateway SIM: ${Store.simLabel(this)} is not in this phone now — choose again; until then nothing is rejected"
            else -> "✓ Gateway SIM: ${Store.simLabel(this)}"
        }
    }

    private fun save() {
        val url = server.text.toString().trim().trimEnd('/')
        // CLEARTEXT WOULD PUT CALLER NUMBERS ON THE WIRE: https only.
        if (!url.startsWith("https://") || url.length < 12) {
            Toast.makeText(this, "The server must start with https://", Toast.LENGTH_LONG).show()
            return
        }
        // Typed as XXXX-XXXX-…: dashes and spaces out, upper-cased — exactly as the server folds it.
        val typed = Store.normalizeSecret(secret.text.toString())
        if (typed.isNotEmpty() && typed.length < Store.MIN_SECRET_LEN) {
            Toast.makeText(this, "The secret is at least ${Store.MIN_SECRET_LEN} characters (it is usually 24).", Toast.LENGTH_LONG).show()
            return
        }
        // The owner's script makes 24 base32 characters: A–Z and 2–7, never 0, 1, 8 or 9.
        if (typed.length == 24 && !typed.matches(Regex("[A-Z2-7]{24}"))) {
            Toast.makeText(this, "That has a 0, 1, 8, 9 or a symbol. The secret uses only letters A–Z and digits 2–7 (letter O, not zero; letter I, not one).", Toast.LENGTH_LONG).show()
            return
        }
        Store.setServer(this, url)
        bg.execute {
            if (typed.isNotEmpty()) Store.setSecret(this, typed)
            runOnUiThread {
                secret.setText("")
                refreshSecret()
                Toast.makeText(this, "Saved. Tap \"Send test event\" to check it.", Toast.LENGTH_LONG).show()
            }
            Hook.flush(this)
        }
    }

    private fun refreshSecret() {
        bg.execute {
            val len = Store.secret(this).length
            runOnUiThread {
                secretStatus.text = if (len >= Store.MIN_SECRET_LEN) "Shared secret: saved ($len characters)"
                else "Shared secret: NOT SET — nothing can be sent"
            }
        }
    }

    private fun refreshLog() {
        val lines = EventLog.lines(this)
        log.text = if (lines.isEmpty()) "No calls yet." else lines.joinToString("\n")
        bg.execute {
            val n = Queue.size(this)
            runOnUiThread { queueStatus.text = if (n == 0) "Last 20 events (nothing waiting)" else "Last 20 events ($n waiting to send)" }
        }
    }

    private fun applyKeepAwake(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    companion object {
        private const val REQ_ROLE = 1
        private const val REQ_PHONE = 2
    }
}

# Hawkeye call gate

A small Android app that turns a spare phone into the receiving end of
Hawkeye's **"give us a missed call"** sign-up — the free way to prove a phone
number for people who have neither Telegram nor WhatsApp.

## What it does

1. A new observer signing up to Hawkeye is shown our number and dials it from the
   phone they are verifying.
2. This app, holding Android's **call-screening role**, **rejects the call**
   before it connects. A rejected call is never answered, so it costs the
   caller nothing.
3. It posts the caller's number to `https://hawkeye.com.ng/api/observers/call-hook`,
   signed with a shared secret (HMAC-SHA256 over `timestamp.body`, re-signed on
   every try). The server marks that number's pending sign-up as proved, and the
   observer's app carries on by itself.

If the phone is offline it retries with backoff, keeps the call in an encrypted
on-phone queue, and sends it when the network returns. A call more than
10 minutes old is dropped: the sign-up it belonged to has expired anyway.

The screen shows the last 20 events with the time, **the last three digits
only** and what the server said. Whole numbers are never shown, and they are
never kept anywhere unencrypted.

No secret is in this repository. The owner types the secret into the phone, and
the app stores it encrypted with a key held in the phone's Keystore.

## What you need

- An Android phone, **Android 10 or newer**. A spare phone is best. A
  **dual-SIM phone can share** with your own line: only calls to the SIM you
  choose as the gateway are rejected (see below).
- A Nigerian SIM for the gateway. Its number is the one observers dial, so it
  goes into the server's `CALL_VERIFY_NUMBER`.
- A charger and Wi-Fi. Mobile data works too, but Wi-Fi keeps the SIM free for
  calls.
- The shared secret, which must match the server's `CALL_HOOK_SECRET`.
  - The owner makes it with `bash scripts/set_call_hook_secret.sh`, in his own
    terminal. The script writes it to production's `.env` (without restarting)
    and prints it once as 24 characters, `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`.
  - Type it exactly as shown. Dashes, spaces and upper or lower case do not
    matter.
  - Never send it by SMS or email.

## Build

From the repo root, in WSL or Linux. The build reuses the JDK 21 and Android SDK
already used for `mobile/android`, plus the same Gradle wrapper (8.14.3):

```bash
bash gateway/build.sh
```

The output is `gateway/build-out/hawkeye-callgate.apk`, signed with the debug
key. That is fine for a phone you install by hand, and it is not a Play build.

## Set up the gateway phone

1. **Prepare the SIM.**
   - **Turn off all call forwarding.** Dial `##002#`, or go to Phone app →
     Settings → Calls → Call forwarding.
   - **Turn off voicemail.** If a rejected call is forwarded to voicemail, the
     caller is connected and **pays**.
   - Keep some airtime on the SIM so the line stays active.
2. **Install the APK.** Copy `hawkeye-callgate.apk` to the phone and open it.
   Allow "install unknown apps" for your file manager when asked. Or, from a
   computer: `adb install gateway/build-out/hawkeye-callgate.apk`.
3. **Open "Hawkeye call gate".** Tap **Make this the call-screening app** and
   choose it in the system dialog. The screen should then say **Call screening:
   ON**.
   - This replaces any other call-screening or spam-ID app. On a Samsung that
     is usually Smart Call, so spam warnings stop on your own line too.
4. **Choose the gateway SIM.** Tap **Choose the gateway SIM** and allow the
   phone permission.
   - Each SIM is listed by slot and carrier, with the last four digits of its
     number when the phone will tell the app.
   - Pick the gateway SIM. The screen then says **✓ Gateway SIM: …**.
   - **Only calls to this SIM are rejected.** Calls to any other SIM ring
     normally, and are never logged or reported.
   - Until a SIM is chosen, nothing is rejected. The same applies if the chosen
     SIM is taken out, or the app cannot tell which SIM a call came in on. Your
     own line always rings.
5. **Enter the server and the secret.**
   - The server is `https://hawkeye.com.ng`, which is filled in by default.
   - Type the shared secret as the script printed it, for example
     `ABCD-EFGH-…`, and tap **Save**. It is visible while you type and never
     shown again.
   - The app refuses `0`, `1`, `8` and `9`, which the secret never contains (`O`
     and `I` are letters).
   - To change the secret, type a new one and tap Save.
6. **Check the setup.** Tap **Send test event**. You should see
   *"test OK — server accepted the signature"*. Otherwise the message tells you
   what to fix:
   - a wrong secret;
   - the phone's clock is off (turn on automatic date and time);
   - the server has not set up missed-call sign-up yet, or has not been
     restarted since the secret was set.
7. **Make a real call.**
   - Ring the **gateway SIM's number** from another phone that is **not in this
     phone's contacts**. The call should be rejected at once, with no charge to
     the caller. A new line should appear in the log, showing the last three
     digits and **sent (200)**.
   - On a dual-SIM phone, also ring **your own number**. It must ring normally,
     with nothing new in the log.

## Keep it running

- **Keep it charging and on Wi-Fi**, and leave the app open on screen. Turn on
  **Keep the screen on** if the phone tends to put apps to sleep.
- **Battery:** Settings → Apps → Hawkeye call gate → Battery → **Unrestricted**
  (the name varies by brand: "No restrictions", "Don't optimise"). Some brands
  (Tecno, Infinix, Xiaomi) also have an "auto-start" or "app launch" list. Allow
  this app there.
- **Lock screen:** after a restart the app cannot read its encrypted secret
  until the phone has been unlocked once. Use no lock screen, or unlock it after
  every restart.
- **Contacts.** Android may skip call screening for callers saved in Contacts,
  so a contact who calls the gateway SIM may simply ring. On a dedicated phone,
  keep no contacts. On a shared dual-SIM phone, test the gateway from numbers
  you have not saved.
- **Turn off "Do not disturb" exceptions and call-blocking apps** that might
  handle calls before this app does.
- **Outgoing calls** from the gateway phone, such as checking airtime, are not
  touched. Only incoming calls to the gateway SIM are rejected.

## Capacity

- **One SIM handles calls one at a time.** Each call is rejected within a second
  or two, so one gateway handles a steady trickle. While it is rejecting one
  call, other callers may hear "busy" and need to redial.
- **For election week, add phones and SIMs.** Every gateway posts to the same
  hook with the same secret. List all their numbers, comma-separated, in the
  server's `CALL_VERIFY_NUMBER`. Each sign-up is given one of them at random,
  which spreads the load. The server does not care which gateway a call
  reached.
- **Use SIMs from different networks** (MTN, Airtel, Glo, 9mobile), so an
  outage on one network does not take the whole route down.

## How the server checks the hook

- Two headers come with every request:
  - `X-Callgate-Timestamp`: unix seconds.
  - `X-Callgate-Signature`: hex HMAC-SHA256 of `"<timestamp>.<raw body>"`,
    keyed with the shared secret after both ends remove dashes and spaces and
    upper-case it.
- The body is `{"from": "<caller as the network gave it>", "at": <ms>, "id": "<random>", "vs": "<STIR/SHAKEN verdict>"}`.
- The server refuses the request in these cases:
  - the signature is wrong;
  - the timestamp is more than 5 minutes from the server's clock;
  - an event id has already been seen. In that case the server answers 200 and
    ignores the event.
- Every authentic hook gets `200 {"ok":true}`, whether or not a sign-up was
  waiting for that number, so the hook reveals nothing about who is signing up.
- Caller ID can be forged by some international routes, so a missed call **only
  ever creates a new account**. It never signs in to an existing account, revives
  a deleted one or resets a password. A call that the network marks as
  **failed** verification never counts.

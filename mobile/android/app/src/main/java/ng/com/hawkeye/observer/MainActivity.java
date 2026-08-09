package ng.com.hawkeye.observer;

import com.getcapacitor.BridgeActivity;

/**
 * Deliberately plain — the splash-hold experiment was removed, and should not
 * come back.
 *
 * The green-screen-on-first-install is a documented Android 12+ platform bug
 * (issuetracker.google.com/205021357): on the first launch after installation
 * the system splash draws only the background colour and OMITS the icon. Every
 * later launch draws it. Nothing at the activity/theme/plugin level can fix
 * that — the icon-less splash is on screen before any app code runs, which is
 * why three successive in-app fixes changed nothing.
 *
 * A setKeepOnScreenCondition hold here made it WORSE: it kept that icon-less
 * splash up until the WebView finished loading, hiding the web layer's boot
 * splash (native.js #hk-boot-splash), which is the only surface that CAN show
 * the mark on a first launch. The system splash must release at first frame so
 * the WebView — and the hawk it draws — appears as early as possible.
 */
public class MainActivity extends BridgeActivity {}

import Foundation
import Capacitor
import VisionKit
import UIKit
// For setBadge below: UNUserNotificationCenter.setBadgeCount is the iOS 16+
// replacement for applicationIconBadgeNumber, which is deprecated.
import UserNotifications

/// The Capacitor bridge for HawkeyeVision.
///
/// Method names and result shapes deliberately mirror @capacitor-mlkit's
/// document-scanner and text-recognition plugins, so app/native.js can pick
/// whichever is registered without a second code path. On iOS the ML Kit pods
/// are not linked at all; on Android this plugin does not exist.
@objc(HawkeyeVisionPlugin)
public class HawkeyeVisionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HawkeyeVisionPlugin"
    public let jsName = "HawkeyeVision"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "processImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise)
    ]

    private let implementation = HawkeyeVision()

    /// Lets the web layer ask before offering the control, instead of finding
    /// out by failing. `isSupported` is false on the simulator and on hardware
    /// without the capability.
    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve([
            "scanner": VNDocumentCameraViewController.isSupported,
            "ocr": true
        ])
    }

    /// Set (or clear) the number on the app icon.
    ///
    /// WHY IT LIVES IN THE VISION PLUGIN, which is otherwise about the scanner:
    /// neither @capacitor/push-notifications nor @capacitor-firebase/messaging
    /// exposes the badge — they can clear the notification SHADE but not the
    /// icon — and on iOS the badge is a separate store that only
    /// `applicationIconBadgeNumber` touches. The alternative was a third-party
    /// pod for four lines of UIKit. This plugin is already this app's one
    /// iOS-native surface, already built, signed and size-gated, so the badge
    /// goes here rather than into another dependency. If a third unrelated
    /// method ever lands, rename the plugin instead of stretching this one.
    ///
    /// iOS only by construction: on Android the launcher derives its badge from
    /// active notifications, so removing delivered ones is the whole job there
    /// and this plugin does not exist.
    @objc func setBadge(_ call: CAPPluginCall) {
        let count = max(0, call.getInt("count") ?? 0)
        DispatchQueue.main.async {
            if #available(iOS 16.0, *) {
                UNUserNotificationCenter.current().setBadgeCount(count) { _ in call.resolve() }
            } else {
                UIApplication.shared.applicationIconBadgeNumber = count
                call.resolve()
            }
        }
    }

    @objc func scanDocument(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let presenter = self.bridge?.viewController else {
                call.reject(HawkeyeVisionError.noPresenter.localizedDescription)
                return
            }
            self.implementation.scan(presentingOn: presenter) { result in
                switch result {
                case .success(let paths):
                    // `scannedImages` as an array of { path } — the same shape
                    // native.js already unwraps for the ML Kit scanner, which
                    // reads either imgs[0].path or imgs[0].
                    call.resolve(["scannedImages": paths.map { ["path": $0] }])
                case .failure(let error):
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    @objc func processImage(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return
        }
        // Off the main thread: OCR on a full-resolution EC8A sheet takes long
        // enough to visibly stall the WebView, and this runs fire-and-forget
        // right after capture while the observer is still typing.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let result = try self.implementation.recognizeText(atPath: path)
                call.resolve(result)
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}

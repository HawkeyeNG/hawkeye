import Foundation
import Capacitor
import Security
import DeviceCheck

/// DEVICE SIGNALS for the server's "count devices, not accounts" rule
/// (backend services/clusters.js; app/device.js getDeviceSignals).
///
/// A SEPARATE PLUGIN, not a method on HawkeyeVision: that class's own note says
/// to stop stretching it with unrelated methods. It only shares the pod, which
/// is already Lite's one built, signed, size-gated iOS-native surface. The
/// Capacitor CLI registers the FIRST objc-name annotation it finds in each
/// Swift file (@capacitor/cli dist/util/iosplugin.js), so no comment in this
/// file may spell one out before the class below.
///
/// `signals()` resolves { shared }: a random 64-hex id kept in the keychain
/// access group G99KD9RW94.ng.com.hawkeye.shared, which the native Hawkeye app
/// (same Apple team) reads too — so one iPhone running both apps is ONE device
/// to the server, which keeps only a keyed hash of it.
///
/// Byte-for-byte the item expo-secure-store writes in the native app
/// (native/src/lib/device-signals.ts: keychainService 'hawkeye.shared', key
/// 'device', AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY): service "hawkeye.shared:no-auth",
/// account and generic = the UTF-8 bytes of "device". ThisDeviceOnly: never
/// synced to iCloud, never restored onto another phone.
///
/// Needs the keychain-access-groups entitlement, added to App.entitlements by
/// .github/workflows/ios-lite-release.yml. Without it the keychain refuses the
/// group and this resolves {} — the web layer then simply sends no id.
///
/// `deviceCheck()` resolves { token }: a FRESH Apple DeviceCheck token (base64)
/// for one phone = one counting account per election (backend
/// services/deviceClaims.js), or {} where DeviceCheck is unsupported or the
/// token could not be made. Not an id — every token is new — and the server
/// only passes it to Apple, which keeps two bits per iPhone for our team (the
/// native app shares them). DCDevice needs NO entitlement and no capability.
@objc(HawkeyeDevicePlugin)
public class HawkeyeDevicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HawkeyeDevicePlugin"
    public let jsName = "HawkeyeDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signals", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceCheck", returnType: CAPPluginReturnPromise)
    ]

    private static let group = "G99KD9RW94.ng.com.hawkeye.shared"
    private static let service = "hawkeye.shared:no-auth"
    private static let key = Data("device".utf8)

    @objc func signals(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .utility).async {
            if let id = HawkeyeDevicePlugin.sharedId() {
                call.resolve(["shared": id])
            } else {
                call.resolve([:])
            }
        }
    }

    @objc func deviceCheck(_ call: CAPPluginCall) {
        let device = DCDevice.current
        guard device.isSupported else {
            call.resolve([:])
            return
        }
        device.generateToken { data, error in
            if let data = data, error == nil {
                call.resolve(["token": data.base64EncodedString()])
            } else {
                call.resolve([:])
            }
        }
    }

    private static func baseQuery() -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrGeneric as String: key,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: group
        ]
    }

    private static func read() -> String? {
        var q = baseQuery()
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        q[kSecReturnData as String] = kCFBooleanTrue
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let s = String(data: data, encoding: .utf8),
              isHex64(s) else { return nil }
        return s
    }

    private static func isHex64(_ s: String) -> Bool {
        return s.count == 64 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    private static func sharedId() -> String? {
        if let have = read() { return have }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let fresh = bytes.map { String(format: "%02x", $0) }.joined()
        var add = baseQuery()
        add[kSecValueData as String] = Data(fresh.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        // errSecDuplicateItem: the native app wrote it a moment ago — use theirs.
        guard status == errSecSuccess || status == errSecDuplicateItem else { return nil }
        return read()
    }
}

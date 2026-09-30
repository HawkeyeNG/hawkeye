import ExpoModulesCore
import DeviceCheck

/**
 Apple DeviceCheck for the server's soft lock: one phone, one counting account
 per election (backend services/deviceClaims.js + services/devicecheck.js;
 src/lib/device-signals.ts sends the token with a result report).

 `deviceCheckToken()` resolves a FRESH DCDevice token as base64, or null where
 DeviceCheck is unsupported (the simulator) or the token could not be made.
 The token is not an id — every call makes a new one — and this app never sees
 the two bits Apple keeps for the phone: only the server can read or set them,
 with its own DeviceCheck key. Both Hawkeye apps are one Apple team, so they
 share the same two bits.

 NO ENTITLEMENT, NO CAPABILITY. DCDevice needs neither (App Attest is the part
 of DeviceCheck that does, and this is not App Attest). DeviceCheck ships with
 iOS: nothing is added to the binary beyond this file.

 The Android half of this module (android/) answers isPackageInstalled and
 androidId instead; each platform's JS feature-detects the function it needs.
 */
public class HawkeyeDeviceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HawkeyeDevice")

    AsyncFunction("deviceCheckToken") { (promise: Promise) in
      let device = DCDevice.current
      guard device.isSupported else {
        promise.resolve(nil)
        return
      }
      device.generateToken { data, error in
        if let data = data, error == nil {
          promise.resolve(data.base64EncodedString())
        } else {
          promise.resolve(nil)
        }
      }
    }
  }
}

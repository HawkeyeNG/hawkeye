Pod::Spec.new do |s|
  s.name           = 'HawkeyeVision'
  s.version        = '1.0.0'
  s.summary        = 'On-device text recognition via Apple Vision.'
  s.description    = 'Reads EC8A result sheets using the Vision framework, which ships with iOS, ' \
                     'so no recognition model is bundled into the app.'
  s.license        = 'MIT'
  s.author         = 'IniXien, LLC'
  s.homepage       = 'https://hawkeye.com.ng'
  # Matches the deployment target the Expo SDK 57 modules in this app declare
  # (see expo-haptics). A lower floor here would not help - the app cannot run
  # below its own target - and a higher one would fail to install.
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Vision and UIKit ship with iOS: nothing is vendored, downloaded, or added to
  # the binary. That is the entire point of this module.
  s.frameworks     = 'Vision', 'UIKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end

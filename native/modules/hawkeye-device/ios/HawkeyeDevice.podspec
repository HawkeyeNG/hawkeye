Pod::Spec.new do |s|
  s.name           = 'HawkeyeDevice'
  s.version        = '1.0.0'
  s.summary        = 'Apple DeviceCheck token for the one-phone-one-account rule.'
  s.description    = 'Makes a DCDevice token the Hawkeye server passes to Apple, so an iPhone that ' \
                     'already reported for one account this election is recognised after a reinstall.'
  s.license        = 'MIT'
  s.author         = 'IniXien, LLC'
  s.homepage       = 'https://hawkeye.com.ng'
  # Same floor as modules/hawkeye-vision (the Expo SDK 57 modules' target).
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # DeviceCheck ships with iOS: nothing vendored, nothing downloaded.
  s.frameworks     = 'DeviceCheck'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end

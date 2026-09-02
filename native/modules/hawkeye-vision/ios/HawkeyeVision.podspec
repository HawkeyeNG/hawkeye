Pod::Spec.new do |s|
  s.name           = 'HawkeyeVision'
  s.version        = '1.0.0'
  s.summary        = 'On-device text recognition via Apple Vision.'
  s.description    = 'Reads EC8A result sheets using the Vision framework, which ships with iOS, ' \
                     'so no recognition model is bundled into the app.'
  s.author         = 'IniXien, LLC'
  s.homepage       = 'https://hawkeye.com.ng'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Vision and UIKit are system frameworks — nothing is vendored or downloaded.
  s.frameworks     = 'Vision', 'UIKit'

  # Matches the flags Expo's own module template uses.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'HawkeyeVision'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://hawkeye.com.ng'
  s.author = 'IniXien Limited'
  s.source = { :git => 'https://github.com/HawkeyeNG/hawkeye.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'

  # VisionKit's VNDocumentCameraViewController and Vision's text recogniser are
  # both part of iOS. NO third-party dependency — that is the entire point:
  # GoogleMLKit's static text-recognition framework linked 42 MB into the app
  # binary, on an app whose reason for existing is being small.
  s.dependency 'Capacitor'
  s.frameworks = 'VisionKit', 'Vision', 'UIKit'

  s.ios.deployment_target = '16.0'
  s.swift_version = '5.1'
end

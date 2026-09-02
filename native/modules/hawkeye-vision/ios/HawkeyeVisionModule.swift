import ExpoModulesCore
import UIKit
import Vision

/**
 On-device text recognition using Apple's Vision framework.

 WHY THIS EXISTS. The app previously read result sheets through
 @react-native-ml-kit/text-recognition, which links five GoogleMLKit
 recognisers — Latin, Chinese, Devanagari, Japanese and Korean — each carrying
 its own model into the binary. Vision is part of iOS, so it costs nothing to
 ship, and the sibling Hawkeye Lite app has read EC8A sheets with exactly this
 code in production. ML Kit stays on Android, where there is no equivalent.

 Ported from mobile/plugins/hawkeye-vision/ios/Plugin/HawkeyeVision.swift. The
 two non-obvious decisions there are kept deliberately and explained below.
 */
public class HawkeyeVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HawkeyeVision")

    AsyncFunction("recognize") { (uri: String) -> [String: Any] in
      try HawkeyeVisionModule.recognizeText(atPath: uri)
    }
  }

  // MARK: - implementation

  static func recognizeText(atPath path: String) throws -> [String: Any] {
    guard let image = loadImage(path) else {
      throw Exception(name: "ERR_LOAD_IMAGE", description: "Could not read an image at \(path)")
    }
    // ORIENTATION IS BAKED IN FIRST. Vision reports geometry in the space of the
    // image it was handed. An EXIF-rotated photo would otherwise return boxes in
    // a rotated frame while width and height came from the unrotated one, so
    // every box would be silently wrong rather than visibly broken.
    guard let cg = upright(image).cgImage else {
      throw Exception(name: "ERR_LOAD_IMAGE", description: "Could not decode the image at \(path)")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    // OFF, deliberately. This reads party codes and vote counts off a form.
    // Language correction exists to turn unlikely strings into likely words,
    // which is exactly the wrong instinct for "APC" or "PDP" beside a column of
    // digits.
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try handler.perform([request])

    let width = CGFloat(cg.width)
    let height = CGFloat(cg.height)
    var lines: [[String: Any]] = []
    var whole: [String] = []

    for observation in (request.results ?? []) {
      guard let candidate = observation.topCandidates(1).first else { continue }
      whole.append(candidate.string)

      // Vision: normalised 0-1, origin BOTTOM-left, y increasing upward.
      // What every other reader in this project produces (ML Kit, Tesseract):
      // pixels, origin TOP-left, y increasing downward. Converted here so a
      // future row-matcher does not have to know which reader it is talking to.
      let box = observation.boundingBox
      lines.append([
        "text": candidate.string,
        "boundingBox": [
          "left": box.minX * width,
          "right": box.maxX * width,
          "top": (1 - box.maxY) * height,
          "bottom": (1 - box.minY) * height,
        ],
      ])
    }

    // Vision returns lines, not blocks. One block holding them all keeps the
    // shape the ML Kit path already returns, so the JS side is identical on
    // both platforms.
    return [
      "text": whole.joined(separator: "\n"),
      "blocks": [["lines": lines]],
    ]
  }

  /// Accepts both "file:///…" (what expo-camera and the scanner hand back) and
  /// a bare "/var/…" path.
  private static func loadImage(_ path: String) -> UIImage? {
    if let url = URL(string: path), url.isFileURL {
      return UIImage(contentsOfFile: url.path)
    }
    return UIImage(contentsOfFile: path)
  }

  private static func upright(_ image: UIImage) -> UIImage {
    if image.imageOrientation == .up { return image }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = image.scale
    let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }
}

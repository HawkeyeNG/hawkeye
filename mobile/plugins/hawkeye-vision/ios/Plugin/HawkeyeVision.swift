import Foundation
import UIKit
import VisionKit
import Vision

enum HawkeyeVisionError: LocalizedError {
    case scannerUnsupported
    case alreadyScanning
    case noPresenter
    case cancelled
    case loadImageFailed(String)

    var errorDescription: String? {
        switch self {
        case .scannerUnsupported: return "The document scanner is not available on this device."
        case .alreadyScanning: return "A scan is already in progress."
        case .noPresenter: return "No view controller to present the scanner from."
        // native.js matches /cancel/i to tell a deliberate back-out from a real
        // failure — a genuine cancel aborts capture, anything else falls
        // through to the plain camera. This wording has to keep matching.
        case .cancelled: return "cancelled"
        case .loadImageFailed(let p): return "Could not load an image at \(p)"
        }
    }
}

final class HawkeyeVision: NSObject, VNDocumentCameraViewControllerDelegate {

    private var completion: ((Result<[String], Error>) -> Void)?

    // MARK: - Scanning (VisionKit)

    /// Presents the system document scanner: live edge detection, auto-capture
    /// and perspective correction, all built into iOS. This is the same control
    /// the React Native app uses, reached directly instead of through a bridge
    /// that drops most of its options.
    func scan(presentingOn presenter: UIViewController,
              completion: @escaping (Result<[String], Error>) -> Void) {
        guard VNDocumentCameraViewController.isSupported else {
            completion(.failure(HawkeyeVisionError.scannerUnsupported))
            return
        }
        guard self.completion == nil else {
            completion(.failure(HawkeyeVisionError.alreadyScanning))
            return
        }
        self.completion = completion

        let scanner = VNDocumentCameraViewController()
        scanner.delegate = self
        presenter.present(scanner, animated: true)
    }

    private func finish(_ result: Result<[String], Error>) {
        let done = completion
        completion = nil
        done?(result)
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                      didFinishWith scan: VNDocumentCameraScan) {
        controller.dismiss(animated: true)
        var paths: [String] = []
        for index in 0..<scan.pageCount {
            let page = scan.imageOfPage(at: index)
            if let path = write(page, index: index) { paths.append(path) }
        }
        if paths.isEmpty {
            // Empty is how a back-out reads to the caller, and native.js would
            // treat it as a cancel. Say which it was.
            finish(.failure(HawkeyeVisionError.loadImageFailed("scanned pages could not be written")))
        } else {
            finish(.success(paths))
        }
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true)
        finish(.failure(HawkeyeVisionError.cancelled))
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                      didFailWithError error: Error) {
        controller.dismiss(animated: true)
        finish(.failure(error))
    }

    /// Writes a page to a temp file and returns a file:// URL string.
    ///
    /// A `file://` URL specifically, not a bare path: app/native.js passes this
    /// straight to Capacitor.convertFileSrc(), which rewrites file:// into the
    /// capacitor:// form the WebView can actually fetch. A bare path is not
    /// converted and the fetch fails.
    private func write(_ image: UIImage, index: Int) -> String? {
        guard let data = image.jpegData(compressionQuality: 0.92) else { return nil }
        let name = "hawkeye-scan-\(Int(Date().timeIntervalSince1970 * 1000))-\(index).jpg"
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
            return url.absoluteString
        } catch {
            return nil
        }
    }

    // MARK: - Text recognition (Vision)

    /// On-device OCR, shaped to match what app/native.js already consumes from
    /// the ML Kit plugin: `{ text, blocks: [{ lines: [{ text, boundingBox }] }] }`.
    func recognizeText(atPath path: String) throws -> [String: Any] {
        guard let image = loadImage(path) else {
            throw HawkeyeVisionError.loadImageFailed(path)
        }
        // ORIENTATION IS BAKED IN FIRST. Vision reports geometry in the space of
        // the image it was handed; an EXIF-rotated photo would otherwise return
        // boxes in a rotated frame while width/height came from the unrotated
        // one, and every row-match in app.js would be silently wrong rather
        // than visibly broken.
        guard let cg = upright(image).cgImage else {
            throw HawkeyeVisionError.loadImageFailed(path)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        // OFF, deliberately. This reads party codes and vote counts off a form.
        // Language correction exists to turn unlikely strings into likely words,
        // which is exactly the wrong instinct for "APC" or "PDP" next to a
        // column of digits.
        request.usesLanguageCorrection = false

        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        try handler.perform([request])

        let width = CGFloat(cg.width)
        let height = CGFloat(cg.height)
        var lines: [[String: Any]] = []
        var whole: [String] = []

        for observation in (request.results ?? []) {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string
            whole.append(text)

            // Vision: normalised 0-1, origin BOTTOM-left, y increasing upward.
            // What app.js's row matcher expects (ML Kit and Tesseract both):
            // pixels, origin TOP-left, y increasing downward. Without this flip
            // `top` would exceed `bottom`, and the same-visual-row test
            // (l.top <= midY && l.bottom >= midY) would reject the very line it
            // is looking for — no error, just counts that never auto-fill.
            let box = observation.boundingBox
            lines.append([
                "text": text,
                "boundingBox": [
                    "left": box.minX * width,
                    "right": box.maxX * width,
                    "top": (1 - box.maxY) * height,
                    "bottom": (1 - box.minY) * height
                ]
            ])
        }

        // Vision returns lines, not blocks. One block holding them all keeps the
        // shape native.js already iterates.
        return [
            "text": whole.joined(separator: "\n"),
            "blocks": [["lines": lines]]
        ]
    }

    private func loadImage(_ path: String) -> UIImage? {
        // Accepts both "file:///…" (what scanDocument hands back, and what
        // @capacitor/camera returns) and a bare "/var/…" path.
        if let url = URL(string: path), url.isFileURL {
            return UIImage(contentsOfFile: url.path)
        }
        return UIImage(contentsOfFile: path)
    }

    private func upright(_ image: UIImage) -> UIImage {
        if image.imageOrientation == .up { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }
}

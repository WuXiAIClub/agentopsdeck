import Foundation
import UniformTypeIdentifiers

enum DownloadFileName {
    static func make(suggested: String, mimeType: String?) -> String {
        let forbidden = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\:*?\"<>|"))
        let cleaned = suggested.components(separatedBy: forbidden).joined(separator: "_")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        let filename = cleaned.isEmpty ? "download" : cleaned
        let originalExtension = (filename as NSString).pathExtension
        let mime = mimeType?.components(separatedBy: ";").first?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let preferredExtension = mime.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension }
        let suffix: String
        if !originalExtension.isEmpty, originalExtension.utf8.count <= 20, originalExtension.lowercased() != "bin" {
            suffix = originalExtension
        } else if let preferredExtension, preferredExtension != "bin", preferredExtension != "data" {
            suffix = preferredExtension
        } else {
            suffix = "bin"
        }
        let originalStem = originalExtension.isEmpty ? filename : (filename as NSString).deletingPathExtension
        var stem = ""
        for character in originalStem {
            if stem.utf8.count + String(character).utf8.count > 200 { break }
            stem.append(character)
        }
        return (stem.isEmpty ? "download" : stem) + "." + suffix
    }
}

import Foundation

enum ServerAddress {
    static func normalize(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) == nil {
            text = "https://" + text
        }
        guard let parts = URLComponents(string: text),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil
        else { return nil }
        return URL(string: origin(scheme: "https", host: host, port: parts.port) + "/")
    }

    static func origin(of url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(),
              let host = parts.host, !host.isEmpty
        else { return nil }
        return origin(scheme: scheme, host: host, port: parts.port)
    }

    private static func origin(scheme: String, host: String, port: Int?) -> String {
        var name = host.lowercased()
        if name.contains(":") && !name.hasPrefix("[") { name = "[\(name)]" }
        let standard: Int? = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
        if let port, port != standard { return "\(scheme)://\(name):\(port)" }
        return "\(scheme)://\(name)"
    }
}

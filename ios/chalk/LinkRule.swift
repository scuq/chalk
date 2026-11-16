import Foundation

enum LinkAction: Equatable {
    case inApp
    case child
    case external
    case deny
}

enum LinkRule {
    static func classify(_ target: String, serverOrigin: String?) -> LinkAction {
        if target.isEmpty || target == "about:blank" { return .child }
        guard let url = URL(string: target), let scheme = url.scheme?.lowercased() else {
            return .deny
        }
        if scheme == "http" || scheme == "https" {
            guard let origin = ServerAddress.origin(of: url) else { return .deny }
            if let serverOrigin, origin == serverOrigin { return .inApp }
            return .external
        }
        if scheme == "mailto" { return .external }
        return .deny
    }
}

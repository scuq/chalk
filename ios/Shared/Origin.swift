import WebKit

/// Returns the origin of a frame as scheme, lowercase host, and port. If the port is 0, the string has no port.
func originString(_ origin: WKSecurityOrigin) -> String {
    let port = origin.port == 0 ? "" : ":\(origin.port)"
    return "\(origin.protocol)://\(origin.host.lowercased())\(port)"
}

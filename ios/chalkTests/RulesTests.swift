import Foundation
import Testing
@testable import chalk

@MainActor
struct ServerAddressTests {
    private func normalized(_ input: String) -> String? {
        ServerAddress.normalize(input)?.absoluteString
    }

    @Test func bareHostBecomesHTTPSOrigin() {
        #expect(normalized("chat.example.org") == "https://chat.example.org/")
        #expect(normalized("  chat.example.org:8443  ") == "https://chat.example.org:8443/")
    }

    @Test func pathQueryAndFragmentAreDropped() {
        #expect(normalized("https://chat.example.org/join/abc?x=1#frag") == "https://chat.example.org/")
    }

    @Test func defaultPortAndCaseAreNormalized() {
        #expect(normalized("https://chat.example.org:443") == "https://chat.example.org/")
        #expect(normalized("HTTPS://Chat.Example.ORG") == "https://chat.example.org/")
    }

    @Test func plainHTTPIsRejectedEvenForLoopback() {
        #expect(normalized("http://chat.example.org") == nil)
        #expect(normalized("http://127.0.0.1:8080/") == nil)
        #expect(normalized("http://localhost:8080") == nil)
    }

    @Test func otherSchemesCredentialsAndGarbageAreRejected() {
        #expect(normalized("ftp://chat.example.org") == nil)
        #expect(normalized("file:///etc/passwd") == nil)
        #expect(normalized("https://user:pw@chat.example.org") == nil)
        #expect(normalized("") == nil)
        #expect(normalized("   ") == nil)
        #expect(normalized("https://") == nil)
        #expect(normalized("not a host") == nil)
    }
}

@MainActor
struct LinkRuleTests {
    private let server = "https://chat.example.org"

    @Test func sameOriginStaysInApp() {
        #expect(LinkRule.classify("https://chat.example.org/join/abc", serverOrigin: server) == .inApp)
        #expect(LinkRule.classify("https://chat.example.org/admin?x=1", serverOrigin: server) == .inApp)
        #expect(LinkRule.classify("https://CHAT.example.org:443/", serverOrigin: server) == .inApp)
    }

    @Test func otherOriginsAndPortsGoToSafari() {
        #expect(LinkRule.classify("https://example.com/", serverOrigin: server) == .external)
        #expect(LinkRule.classify("http://chat.example.org/", serverOrigin: server) == .external)
        #expect(LinkRule.classify("https://chat.example.org:8443/", serverOrigin: server) == .external)
        #expect(LinkRule.classify("mailto:someone@example.org", serverOrigin: server) == .external)
    }

    @Test func aboutBlankWindowsAreChildren() {
        #expect(LinkRule.classify("about:blank", serverOrigin: server) == .child)
        #expect(LinkRule.classify("", serverOrigin: server) == .child)
    }

    @Test func everythingElseIsDenied() {
        #expect(LinkRule.classify("file:///etc/passwd", serverOrigin: server) == .deny)
        #expect(LinkRule.classify("javascript:alert(1)", serverOrigin: server) == .deny)
        #expect(LinkRule.classify("chrome://settings", serverOrigin: server) == .deny)
        #expect(LinkRule.classify("blob:https://chat.example.org/1234", serverOrigin: server) == .deny)
        #expect(LinkRule.classify("not a url", serverOrigin: server) == .deny)
    }

    @Test func withNoServerNothingIsInApp() {
        #expect(LinkRule.classify("https://chat.example.org/", serverOrigin: nil) == .external)
    }
}

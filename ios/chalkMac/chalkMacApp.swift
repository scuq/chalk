import SwiftUI

// 138-1: the macOS app. One window shows the server screen or the page of the home server.
@main
struct chalkMacApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        Window("chalk", id: "main") {
            MacContentView(model: model)
                .frame(minWidth: 480, minHeight: 360)
        }
        .defaultSize(width: 1200, height: 800)
        .commands {
            CommandGroup(after: .appSettings) {
                Button("Switch Server…") { model.chooseServer() }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
            }
        }
    }
}

struct MacContentView: View {
    @Bindable var model: AppModel

    var body: some View {
        if let server = model.server {
            MacWebView(server: server) { reason in
                model.loadFailed(reason)
            }
            .id(server)
        } else {
            ServerScreen(model: model)
        }
    }
}

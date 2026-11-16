import SwiftUI

struct ContentView: View {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if let server = model.server {
                ChalkWebView(server: server) { reason in
                    model.loadFailed(reason)
                }
                .id(server)
                .ignoresSafeArea(.container)
            } else {
                ServerScreen(model: model)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.applySettingsToggle() }
        }
    }
}

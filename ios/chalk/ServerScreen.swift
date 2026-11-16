import SwiftUI

struct ServerScreen: View {
    @Bindable var model: AppModel
    @State private var address = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("chalk")
                .font(.largeTitle.bold())
            Text("Server address")
                .font(.headline)
            TextField("chat.example.org", text: $address)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { model.connect(address) }
                .textFieldStyle(.roundedBorder)
            if let message = model.message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            Button("Connect") { model.connect(address) }
                .buttonStyle(.borderedProminent)
                .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
            Spacer()
        }
        .padding(24)
        .onAppear {
            if address.isEmpty, let last = model.lastServer {
                address = last.host() ?? ""
                if let port = last.port { address += ":\(port)" }
            }
        }
    }
}

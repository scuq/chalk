import SwiftUI

private enum Palette {
    static let ground = Color(red: 0x05 / 255, green: 0x08 / 255, blue: 0x05 / 255)
    static let card = Color(red: 0x0a / 255, green: 0x11 / 255, blue: 0x0b / 255)
    static let raised = Color(red: 0x0f / 255, green: 0x1c / 255, blue: 0x11 / 255)
    static let accent = Color(red: 0x24 / 255, green: 0xf0 / 255, blue: 0x77 / 255)
    static let text = Color(red: 0x8c / 255, green: 0xff / 255, blue: 0xa8 / 255)
    static let dim = Color(red: 0x74 / 255, green: 0xb0 / 255, blue: 0x8a / 255)
    static let muted = Color(red: 0x3c / 255, green: 0x6b / 255, blue: 0x52 / 255)
    static let border = Color(red: 0x14 / 255, green: 0x3a / 255, blue: 0x25 / 255)
    static let error = Color(red: 0xff / 255, green: 0x52 / 255, blue: 0x52 / 255)
}

struct ServerScreen: View {
    @Bindable var model: AppModel
    @State private var address = ""
    @FocusState private var focused: Bool

    private var empty: Bool { address.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        ZStack {
            Palette.ground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("chalk")
                        .font(.system(size: 28, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Palette.accent)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("server address")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Palette.dim)
                        TextField("", text: $address,
                                  prompt: Text("chat.example.org").foregroundStyle(Palette.muted))
                            .font(.system(size: 16, design: .monospaced))
                            .foregroundStyle(Palette.accent)
                            .tint(Palette.accent)
                            #if os(iOS)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            #else
                            // 138-1: without this, macOS draws its own field border inside the frame below.
                            .textFieldStyle(.plain)
                            #endif
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .focused($focused)
                            .onSubmit { if !empty { model.connect(address) } }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Palette.ground)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(focused ? Palette.accent : Palette.border, lineWidth: 1))
                    }
                    if let message = model.message {
                        Text(message)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(Palette.error)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Palette.error.opacity(0.08))
                            .overlay(Rectangle().stroke(Palette.error, lineWidth: 1))
                    }
                    Button { model.connect(address) } label: {
                        Text("connect")
                            .font(.system(size: 15, design: .monospaced))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .foregroundStyle(empty ? Palette.muted : Palette.accent)
                            .background(Palette.raised)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(empty ? Palette.border : Palette.accent, lineWidth: 1))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .disabled(empty)
                }
                .padding(24)
                .background(Palette.card)
                .overlay(Rectangle().stroke(Palette.accent, lineWidth: 1))
                #if os(macOS)
                // 138-1: a desktop window is wide, so the card keeps a phone width.
                .frame(maxWidth: 420)
                #endif
                .padding(16)
                .padding(.top, 48)
            }
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
        }
        .preferredColorScheme(.dark)
        .onAppear {
            if address.isEmpty, let last = model.lastServer {
                address = last.host() ?? ""
                if let port = last.port { address += ":\(port)" }
            }
        }
    }
}

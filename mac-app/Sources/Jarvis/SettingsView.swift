import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Verbindung").font(.headline)

            VStack(alignment: .leading, spacing: 4) {
                Text("Server-URL").font(.caption).foregroundColor(.secondary)
                TextField("https://192.168.178.x:3333", text: $state.serverURL)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Benutzername").font(.caption).foregroundColor(.secondary)
                TextField("MONITOR_USER", text: $state.username)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Passwort").font(.caption).foregroundColor(.secondary)
                SecureField("MONITOR_PASS", text: $state.password)
                    .textFieldStyle(.roundedBorder)
            }

            if let err = state.lastError {
                Text(err)
                    .font(.caption)
                    .foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            HStack {
                Button("Verbindung testen") {
                    Task { await state.loadHistory() }
                }
                .disabled(!state.isConfigured)

                Spacer()

                Button("Schließen") {
                    state.showingSettings = false
                }
                .disabled(!state.isConfigured)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(12)
    }
}

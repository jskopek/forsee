import SwiftUI

/// The phone's own screen. It only has to tell you which address to open on
/// the computer; everything else is driven from the controller page.
struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Eye Capture")
                .font(.largeTitle)
                .bold()

            if model.addresses.isEmpty {
                Text("No network address found. Join the same Wi-Fi network as your computer.")
            } else {
                Text("On your computer, open:")
                ForEach(model.addresses, id: \.self) { address in
                    Text(address)
                        .font(.system(.title3, design: .monospaced))
                        .textSelection(.enabled)
                }
            }

            Text(model.statusLine)
                .font(.callout)
                .foregroundColor(.secondary)

            if model.isRecording {
                Label("Recording", systemImage: "record.circle.fill")
                    .foregroundColor(.red)
            }

            if let image = model.preview {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .cornerRadius(8)
            }

            if let error = model.lastError {
                Text(error)
                    .foregroundColor(.red)
            }

            Spacer()
        }
        .padding()
    }
}

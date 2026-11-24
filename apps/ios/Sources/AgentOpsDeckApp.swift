import SwiftUI
import UIKit

@main
struct AgentOpsDeckApp: App {
    var body: some Scene {
        WindowGroup {
            ClientView().ignoresSafeArea()
        }
    }
}

private struct ClientView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UINavigationController {
        UINavigationController(rootViewController: WebViewController())
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}

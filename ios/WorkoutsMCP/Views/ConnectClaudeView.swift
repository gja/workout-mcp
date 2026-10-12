// How an athlete with only this app gets Claude writing their plan. A custom connector is
// added on claude.ai, once, and is then there in Claude's iPhone app too.

import SwiftUI
import UIKit

struct ConnectClaudeView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    private static let mcpURL = AppServer.url.appendingPathComponent("mcp").absoluteString
    private static let connectors = URL(string: "https://claude.ai/settings/connectors")!

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Claude plans your training; this app puts each workout on your watch and sends back what you ran.")
                        .foregroundStyle(.secondary)
                }

                Section("Add the connector") {
                    Step(number: 1, text: "Copy the connector URL.")
                    HStack {
                        Text(Self.mcpURL).font(.callout.monospaced()).textSelection(.enabled)
                        Spacer()
                        Button(copied ? "Copied" : "Copy") {
                            UIPasteboard.general.string = Self.mcpURL
                            copied = true
                        }
                        .buttonStyle(.bordered)
                    }
                    Step(number: 2, text: "Open Claude's connector settings and sign in to claude.ai.")
                    Link(destination: Self.connectors) {
                        Label("Open claude.ai connectors", systemImage: "safari")
                    }
                    Step(number: 3, text: "Tap Add custom connector, name it Workouts, paste the URL and tap Add.")
                    Step(number: 4, text: "Tap Connect and sign in with the same Apple or Google account you use here.")
                }

                Section("Then, in the Claude iPhone app") {
                    Step(number: 5, text: "Start a chat and check Workouts is switched on in its connectors.")
                    Step(number: 6, text: "Ask: \u{201C}Set me up and plan my next two weeks.\u{201D}")
                    Step(number: 7, text: "Come back here: the plan syncs to Apple Fitness on its own.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Connect to Claude")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

private struct Step: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
            Text(text)
        }
    }
}

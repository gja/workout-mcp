// Pair a Bluetooth strap or power meter to the phone and watch its numbers. Debug builds only;
// nothing here is recorded. See docs/ios.md.
#if SENSOR_LAB
import CoreBluetooth
import SwiftUI

struct SensorLabView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var lab = SensorLab()

    var body: some View {
        NavigationStack {
            List {
                Section("Readings") {
                    reading("Heart rate", lab.heartRate.map { "\($0) bpm" })
                    reading("Power", lab.power.map { "\($0) W" })
                    reading("Cadence", lab.cadence.map { "\(Int($0.rounded())) rpm" })
                }

                Section {
                    if let problem = Self.problem(lab.state) {
                        Text(problem).foregroundStyle(.secondary)
                    } else if lab.nearby.isEmpty {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Looking for sensors…").foregroundStyle(.secondary)
                        }
                    }
                    ForEach(sensors) { sensor in
                        Button { lab.toggle(sensor) } label: { row(sensor) }
                    }
                } header: {
                    Text("Nearby")
                } footer: {
                    Text(
                        "Anything on the standard heart rate, cycling power or speed and cadence "
                            + "profile. A WHOOP needs Heart Rate Broadcast turned on in its app."
                    )
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Sensors")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { lab.start() }
            .onDisappear { lab.stop() }
        }
    }

    private var sensors: [NearbySensor] {
        lab.nearby.values.sorted { ($0.rssi ?? -999) > ($1.rssi ?? -999) }
    }

    private func reading(_ label: String, _ value: String?) -> some View {
        LabeledContent(label) {
            Text(value ?? "—").font(.title2.monospacedDigit()).foregroundStyle(.primary)
        }
    }

    private func row(_ sensor: NearbySensor) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(sensor.name).foregroundStyle(.primary)
                Text(sensor.profiles.map(\.rawValue).joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if lab.connecting.contains(sensor.id) {
                ProgressView()
            } else if lab.connected.contains(sensor.id) {
                Text("Connected").font(.caption).foregroundStyle(.green)
            } else {
                Text("Connect").font(.caption)
            }
        }
    }

    private static func problem(_ state: CBManagerState) -> String? {
        switch state {
        case .poweredOn, .unknown, .resetting: nil
        case .poweredOff: "Bluetooth is off."
        case .unauthorized: "Bluetooth is not allowed for this app. Turn it on in Settings › Privacy › Bluetooth."
        case .unsupported: "This device has no Bluetooth LE."
        @unknown default: nil
        }
    }
}
#endif

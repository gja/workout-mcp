// Bluetooth heart rate, cycling power and cadence read straight off the standard GATT
// profiles, with HealthKit nowhere in the loop. Debug builds only. See docs/ios.md.
#if SENSOR_LAB
import CoreBluetooth
import Foundation

/// The three Bluetooth SIG services this screen speaks, and the one characteristic of each.
enum SensorProfile: String, CaseIterable {
    case heartRate = "Heart rate"
    case cyclingPower = "Power"
    case speedCadence = "Speed and cadence"

    var service: CBUUID {
        switch self {
        case .heartRate: CBUUID(string: "180D")
        case .cyclingPower: CBUUID(string: "1818")
        case .speedCadence: CBUUID(string: "1816")
        }
    }

    var measurement: CBUUID {
        switch self {
        case .heartRate: CBUUID(string: "2A37")
        case .cyclingPower: CBUUID(string: "2A63")
        case .speedCadence: CBUUID(string: "2A5B")
        }
    }

    init?(service: CBUUID) {
        guard let profile = Self.allCases.first(where: { $0.service == service }) else { return nil }
        self = profile
    }

    static let services = allCases.map(\.service)
}

struct NearbySensor: Identifiable {
    let peripheral: CBPeripheral
    var name: String
    var profiles: [SensorProfile]
    var rssi: Int?

    var id: UUID { peripheral.identifier }
}

/// Cumulative crank revolutions and the event time of the last one, as both profiles send them.
private struct CrankEvent {
    let revolutions: UInt16
    /// In 1/1024 s, wrapping every 64 s.
    let time: UInt16
}

/// Delegate calls arrive on the main queue and are handled in place: a hop through `Task`
/// would reorder them, and a crank delta taken out of order is a cadence in the thousands.
@MainActor
final class SensorLab: NSObject, ObservableObject {
    @Published private(set) var state: CBManagerState = .unknown
    @Published private(set) var nearby: [UUID: NearbySensor] = [:]
    @Published private(set) var connected: Set<UUID> = []
    @Published private(set) var connecting: Set<UUID> = []
    @Published private(set) var heartRate: Int?
    @Published private(set) var power: Int?
    @Published private(set) var cadence: Double?
    @Published private(set) var lastReading: Date?

    private var central: CBCentralManager?
    private var lastCrank: CrankEvent?
    private var lastCrankChange: Date?

    /// A pedal stroke every 3 s is 20 rpm; with no new crank event for longer, they have stopped.
    private static let cadenceTimeout: TimeInterval = 3

    /// Creating the manager is what puts up the Bluetooth permission prompt, so it waits for the screen.
    func start() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func stop() {
        central?.stopScan()
        for sensor in nearby.values where connected.contains(sensor.id) || connecting.contains(sensor.id) {
            central?.cancelPeripheralConnection(sensor.peripheral)
        }
        central = nil
        connected = []
        connecting = []
    }

    func toggle(_ sensor: NearbySensor) {
        guard let central else { return }
        if connected.contains(sensor.id) || connecting.contains(sensor.id) {
            central.cancelPeripheralConnection(sensor.peripheral)
        } else {
            connecting.insert(sensor.id)
            central.connect(sensor.peripheral)
        }
    }

    private func poweredOn() {
        guard let central else { return }
        // A strap already held by another app, or by iOS itself, does not advertise.
        for peripheral in central.retrieveConnectedPeripherals(withServices: SensorProfile.services) {
            remember(peripheral, profiles: [], rssi: nil)
        }
        central.scanForPeripherals(
            withServices: SensorProfile.services,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    private func remember(_ peripheral: CBPeripheral, profiles: [SensorProfile], rssi: Int?) {
        var sensor = nearby[peripheral.identifier]
            ?? NearbySensor(peripheral: peripheral, name: peripheral.name ?? "Unnamed sensor", profiles: [], rssi: nil)
        if let name = peripheral.name { sensor.name = name }
        for profile in profiles where !sensor.profiles.contains(profile) { sensor.profiles.append(profile) }
        if let rssi { sensor.rssi = rssi }
        nearby[peripheral.identifier] = sensor
    }

    private func read(_ profile: SensorProfile, _ data: Data) {
        let bytes = [UInt8](data)
        switch profile {
        case .heartRate:
            if let bpm = Self.heartRate(bytes) { heartRate = bpm }
        case .cyclingPower:
            guard let (watts, crank) = Self.cyclingPower(bytes) else { return }
            power = watts
            if let crank { took(crank) }
        case .speedCadence:
            if let crank = Self.speedCadence(bytes) { took(crank) }
        }
        lastReading = Date()
        if let lastCrankChange, Date().timeIntervalSince(lastCrankChange) > Self.cadenceTimeout { cadence = 0 }
    }

    private func took(_ crank: CrankEvent) {
        defer { lastCrank = crank }
        guard let last = lastCrank else { return }
        // Both counters are UInt16 and wrap; subtracting with overflow gives the true delta.
        let revolutions = crank.revolutions &- last.revolutions
        let ticks = crank.time &- last.time
        guard ticks > 0, revolutions > 0 else { return }
        cadence = Double(revolutions) * 60 * 1024 / Double(ticks)
        lastCrankChange = Date()
    }

    // --- The wire formats, from the Bluetooth SIG's GATT specification -------------------

    /// Heart Rate Measurement: flags, then a UInt8 or, with bit 0 set, a little-endian UInt16.
    static func heartRate(_ b: [UInt8]) -> Int? {
        guard b.count >= 2 else { return nil }
        if b[0] & 0x01 == 0 { return Int(b[1]) }
        guard b.count >= 3 else { return nil }
        return Int(UInt16(b[1]) | UInt16(b[2]) << 8)
    }

    /// Cycling Power Measurement: UInt16 flags, Int16 watts, then optional fields in flag order.
    fileprivate static func cyclingPower(_ b: [UInt8]) -> (Int, CrankEvent?)? {
        guard b.count >= 4 else { return nil }
        let flags = UInt16(b[0]) | UInt16(b[1]) << 8
        let watts = Int(Int16(bitPattern: UInt16(b[2]) | UInt16(b[3]) << 8))
        var i = 4
        if flags & 0x0001 != 0 { i += 1 }  // pedal power balance
        if flags & 0x0004 != 0 { i += 2 }  // accumulated torque
        if flags & 0x0010 != 0 { i += 6 }  // wheel revolutions and event time
        guard flags & 0x0020 != 0, b.count >= i + 4 else { return (watts, nil) }
        return (watts, crankEvent(b, at: i))
    }

    /// CSC Measurement: UInt8 flags, an optional wheel pair, then an optional crank pair.
    fileprivate static func speedCadence(_ b: [UInt8]) -> CrankEvent? {
        guard let flags = b.first else { return nil }
        var i = 1
        if flags & 0x01 != 0 { i += 6 }
        guard flags & 0x02 != 0, b.count >= i + 4 else { return nil }
        return crankEvent(b, at: i)
    }

    private static func crankEvent(_ b: [UInt8], at i: Int) -> CrankEvent {
        CrankEvent(
            revolutions: UInt16(b[i]) | UInt16(b[i + 1]) << 8,
            time: UInt16(b[i + 2]) | UInt16(b[i + 3]) << 8
        )
    }
}

extension SensorLab: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        MainActor.assumeIsolated {
            self.state = state
            if state == .poweredOn { self.poweredOn() }
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let profiles = services.compactMap(SensorProfile.init(service:))
        let rssi = RSSI.intValue
        MainActor.assumeIsolated { self.remember(peripheral, profiles: profiles, rssi: rssi) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            self.connecting.remove(peripheral.identifier)
            self.connected.insert(peripheral.identifier)
            peripheral.delegate = self
            peripheral.discoverServices(SensorProfile.services)
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        MainActor.assumeIsolated { self.connecting.remove(peripheral.identifier) }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        MainActor.assumeIsolated {
            self.connecting.remove(peripheral.identifier)
            self.connected.remove(peripheral.identifier)
        }
    }
}

extension SensorLab: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] {
            guard let profile = SensorProfile(service: service.uuid) else { continue }
            peripheral.discoverCharacteristics([profile.measurement], for: service)
        }
        let profiles = (peripheral.services ?? []).compactMap { SensorProfile(service: $0.uuid) }
        MainActor.assumeIsolated { self.remember(peripheral, profiles: profiles, rssi: nil) }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        for characteristic in service.characteristics ?? [] {
            peripheral.setNotifyValue(true, for: characteristic)
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let data = characteristic.value,
              let service = characteristic.service,
              let profile = SensorProfile(service: service.uuid)
        else { return }
        MainActor.assumeIsolated { self.read(profile, data) }
    }
}
#endif

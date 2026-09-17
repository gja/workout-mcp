// A FIT encoder small enough to read: definition records, data records, and the one
// developer field that names the workout. Field and enum numbers are the profile's,
// copied out of `@garmin/fitsdk` rather than remembered. See ios/README.md.

import Foundation

/// FIT counts seconds from 1989-12-31, not 1970.
private let fitEpoch: TimeInterval = 631_065_600

enum FitBaseType: UInt8 {
    case enumerated = 0x00
    case sint8 = 0x01
    case uint8 = 0x02
    case string = 0x07
    case byteArray = 0x0D
    case sint16 = 0x83
    case uint16 = 0x84
    case sint32 = 0x85
    case uint32 = 0x86
    case uint32z = 0x8C

    /// What a decoder reads back as "nothing was recorded here", which is never zero.
    var invalid: [UInt8] {
        switch self {
        case .enumerated, .uint8: return [0xFF]
        case .sint8: return [0x7F]
        case .uint16: return [0xFF, 0xFF]
        case .sint16: return [0xFF, 0x7F]
        case .uint32: return [0xFF, 0xFF, 0xFF, 0xFF]
        case .sint32: return [0xFF, 0xFF, 0xFF, 0x7F]
        case .uint32z: return [0x00, 0x00, 0x00, 0x00]
        case .string: return [0x00]
        case .byteArray: return [0xFF]
        }
    }
}

/// One field's bytes, already scaled and already little-endian.
struct FitValue {
    let baseType: FitBaseType
    let bytes: [UInt8]
}

extension FitValue {
    private static func littleEndian(_ value: Int64, _ width: Int) -> [UInt8] {
        let unsigned = UInt64(bitPattern: value)
        return (0 ..< width).map { UInt8((unsigned >> (8 * $0)) & 0xFF) }
    }

    private static func make(_ type: FitBaseType, _ width: Int, _ raw: Double?, scale: Double, offset: Double) -> FitValue {
        guard let raw, raw.isFinite else { return FitValue(baseType: type, bytes: type.invalid) }
        let scaled = (raw + offset) * scale
        guard scaled.isFinite, abs(scaled) < 9.0e18 else { return FitValue(baseType: type, bytes: type.invalid) }
        return FitValue(baseType: type, bytes: littleEndian(Int64(scaled.rounded()), width))
    }

    static func enumerated(_ raw: Int?) -> FitValue { make(.enumerated, 1, raw.map(Double.init), scale: 1, offset: 0) }
    static func uint8(_ raw: Double?, scale: Double = 1, offset: Double = 0) -> FitValue { make(.uint8, 1, raw, scale: scale, offset: offset) }
    static func sint8(_ raw: Double?, scale: Double = 1, offset: Double = 0) -> FitValue { make(.sint8, 1, raw, scale: scale, offset: offset) }
    static func uint16(_ raw: Double?, scale: Double = 1, offset: Double = 0) -> FitValue { make(.uint16, 2, raw, scale: scale, offset: offset) }
    static func sint16(_ raw: Double?, scale: Double = 1, offset: Double = 0) -> FitValue { make(.sint16, 2, raw, scale: scale, offset: offset) }
    static func uint32(_ raw: Double?, scale: Double = 1, offset: Double = 0) -> FitValue { make(.uint32, 4, raw, scale: scale, offset: offset) }
    static func sint32(_ raw: Double?, scale: Double = 1, offset: Double = 0) -> FitValue { make(.sint32, 4, raw, scale: scale, offset: offset) }
    static func uint32z(_ raw: Double?) -> FitValue { make(.uint32z, 4, raw, scale: 1, offset: 0) }

    static func timestamp(_ date: Date?) -> FitValue {
        uint32(date.map { $0.timeIntervalSince1970 - fitEpoch })
    }

    /// Degrees to the 2^31-per-180 units FIT stores a position in.
    static func semicircles(_ degrees: Double?) -> FitValue {
        sint32(degrees.map { $0 * (2147483648.0 / 180.0) })
    }

    /// Fixed width, null-terminated and null-padded: the size is in the definition record,
    /// so a string that changed length would silently need a new one.
    static func text(_ raw: String, capacity: Int) -> FitValue {
        var bytes = Array(raw.utf8.prefix(capacity - 1))
        bytes.append(contentsOf: [UInt8](repeating: 0, count: capacity - bytes.count))
        return FitValue(baseType: .string, bytes: bytes)
    }

    /// A raw byte array, for the 16-byte application id a developer field is declared under.
    static func bytes(_ raw: [UInt8]) -> FitValue { FitValue(baseType: .byteArray, bytes: raw) }
}

struct FitField {
    let number: UInt8
    let value: FitValue

    init(_ number: UInt8, _ value: FitValue) {
        self.number = number
        self.value = value
    }
}

/// A field this file invented, declared by a `field_description` message ahead of it.
struct FitDeveloperField {
    let number: UInt8
    let index: UInt8
    let value: FitValue
}

struct FitMessage {
    let global: UInt16
    let fields: [FitField]
    var developerFields: [FitDeveloperField] = []
}

/// Builds the body, then wraps it in the 14-byte header and the two CRCs.
struct FitWriter {
    private var body: [UInt8] = []
    private var locals: [UInt16: (id: UInt8, layout: [UInt8])] = [:]
    private var nextLocal: UInt8 = 0

    mutating func append(_ message: FitMessage) {
        let layout = layoutOf(message)
        let known = locals[message.global]

        if known?.layout != layout {
            // A local id is reused for the same global message, so a file with eight
            // message types never runs out of the sixteen a record header can address.
            let id = known?.id ?? takeLocal()
            writeDefinition(message, local: id)
            locals[message.global] = (id, layout)
        }

        body.append(locals[message.global]!.id)
        for field in message.fields { body.append(contentsOf: field.value.bytes) }
        for field in message.developerFields { body.append(contentsOf: field.value.bytes) }
    }

    func finish() -> Data {
        var header: [UInt8] = [14, 0x20]
        header.append(contentsOf: FitWriter.littleEndian(21214, 2))
        header.append(contentsOf: FitWriter.littleEndian(UInt32(body.count), 4))
        header.append(contentsOf: Array(".FIT".utf8))
        header.append(contentsOf: FitWriter.littleEndian(UInt32(FitWriter.crc(header)), 2))

        var file = header + body
        file.append(contentsOf: FitWriter.littleEndian(UInt32(FitWriter.crc(file)), 2))
        return Data(file)
    }

    // --- The records themselves ----------------------------------------------

    private func layoutOf(_ message: FitMessage) -> [UInt8] {
        var layout: [UInt8] = []
        for field in message.fields {
            layout.append(contentsOf: [field.number, UInt8(field.value.bytes.count), field.value.baseType.rawValue])
        }
        for field in message.developerFields {
            layout.append(contentsOf: [field.number, UInt8(field.value.bytes.count), field.index])
        }
        return layout
    }

    private mutating func takeLocal() -> UInt8 {
        defer { nextLocal = (nextLocal + 1) % 16 }
        return nextLocal
    }

    private mutating func writeDefinition(_ message: FitMessage, local: UInt8) {
        let hasDeveloperFields = !message.developerFields.isEmpty
        body.append(0x40 | (hasDeveloperFields ? 0x20 : 0) | local)
        body.append(0) // reserved
        body.append(0) // little-endian, which is what every value above is written as
        body.append(contentsOf: FitWriter.littleEndian(UInt32(message.global), 2))
        body.append(UInt8(message.fields.count))

        for field in message.fields {
            body.append(contentsOf: [field.number, UInt8(field.value.bytes.count), field.value.baseType.rawValue])
        }
        guard hasDeveloperFields else { return }

        body.append(UInt8(message.developerFields.count))
        for field in message.developerFields {
            body.append(contentsOf: [field.number, UInt8(field.value.bytes.count), field.index])
        }
    }

    private static func littleEndian(_ value: UInt32, _ width: Int) -> [UInt8] {
        (0 ..< width).map { UInt8((value >> (8 * $0)) & 0xFF) }
    }

    /// The CRC-16 the FIT spec specifies, a nibble at a time off its own table.
    private static func crc(_ bytes: [UInt8]) -> UInt16 {
        let table: [UInt16] = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
                               0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]
        var sum: UInt16 = 0
        for byte in bytes {
            var carry = table[Int(sum & 0xF)]
            sum = (sum >> 4) & 0x0FFF
            sum = sum ^ carry ^ table[Int(byte & 0xF)]

            carry = table[Int(sum & 0xF)]
            sum = (sum >> 4) & 0x0FFF
            sum = sum ^ carry ^ table[Int((byte >> 4) & 0xF)]
        }
        return sum
    }
}

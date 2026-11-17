import Foundation
import UIKit

enum DeviceInfo {
    /// The hardware identifier, for example "iPhone16,2".
    static func modelIdentifier() -> String {
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        guard size > 0 else { return "unknown" }
        var machine = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        return String(cString: machine)
    }

    /// IPv4 addresses of this device, Wi-Fi first. Loopback is left out.
    static func ipv4Addresses() -> [String] {
        var wifi: [String] = []
        var others: [String] = []
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else { return [] }
        defer { freeifaddrs(pointer) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            let interface = current.pointee
            cursor = interface.ifa_next
            guard let address = interface.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET),
                  (interface.ifa_flags & UInt32(IFF_UP)) != 0,
                  (interface.ifa_flags & UInt32(IFF_LOOPBACK)) == 0
            else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                address, socklen_t(address.pointee.sa_len),
                &host, socklen_t(host.count),
                nil, 0, NI_NUMERICHOST
            )
            guard result == 0 else { continue }
            let text = String(cString: host)
            if String(cString: interface.ifa_name) == "en0" {
                wifi.append(text)
            } else {
                others.append(text)
            }
        }
        return wifi + others
    }

    /// Facts that need the main thread (UIKit). Call from the main thread only.
    static func systemSnapshot() -> [String: Any] {
        let device = UIDevice.current
        var info: [String: Any] = [
            "model": modelIdentifier(),
            "system": "\(device.systemName) \(device.systemVersion)",
            "thermalState": thermalName(ProcessInfo.processInfo.thermalState),
        ]
        let battery = device.batteryLevel
        if battery >= 0 {
            info["battery"] = Double(battery)
        }
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let values = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        if let free = values?.volumeAvailableCapacityForImportantUsage {
            info["freeBytes"] = free
        }
        return info
    }

    static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
}

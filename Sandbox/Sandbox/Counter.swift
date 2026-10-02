import Observation
import OSLog

@Observable
final class Counter {
    private static let logger = Logger(subsystem: "com.artemnovichkov.Sandbox", category: "Counter")

    private(set) var value = 0

    func increment() {
        value += 1
        Self.logger.info("Incremented to \(self.value)")
    }

    func reset() {
        value = 0
        Self.logger.notice("Reset")
    }
}

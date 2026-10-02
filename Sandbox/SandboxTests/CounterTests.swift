import Testing
@testable import Sandbox

@MainActor
struct CounterTests {
    @Test func startsAtZero() {
        #expect(Counter().value == 0)
    }

    @Test func increments() {
        let counter = Counter()
        counter.increment()
        counter.increment()
        #expect(counter.value == 2)
    }

    @Test func resets() {
        let counter = Counter()
        counter.increment()
        counter.reset()
        #expect(counter.value == 0)
    }
}

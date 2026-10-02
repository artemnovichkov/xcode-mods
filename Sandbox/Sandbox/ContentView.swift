import SwiftUI

struct ContentView: View {
    @State private var counter = Counter()

    var body: some View {
        VStack(spacing: 24) {
            Text("\(counter.value)")
                .font(.system(size: 96, weight: .bold, design: .rounded))
                .contentTransition(.numericText())
            HStack {
                Button("Reset", role: .destructive) { counter.reset() }
                Button("Increment") { withAnimation { counter.increment() } }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding()
    }
}

#Preview {
    ContentView()
}

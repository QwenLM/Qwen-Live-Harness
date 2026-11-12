// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentRemoteMac",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "AgentRemoteMac", targets: ["AgentRemoteMac"])],
    targets: [
        .target(name: "AgentRemoteMacCore", path: "Sources/AgentRemoteMacCore"),
        .executableTarget(name: "AgentRemoteMac", dependencies: ["AgentRemoteMacCore"], path: "Sources/AgentRemoteMac"),
        .testTarget(name: "AgentRemoteMacCoreTests", dependencies: ["AgentRemoteMacCore"], path: "Tests/AgentRemoteMacCoreTests"),
    ]
)

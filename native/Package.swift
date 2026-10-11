// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EchoVueMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "EchoVueMac", targets: ["EchoVueMac"])
    ],
    targets: [
        .executableTarget(
            name: "EchoVueMac",
            path: "Sources/EchoVueMac"
        )
    ]
)

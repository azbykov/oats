// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "oats-audio",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "oats-audio", targets: ["OatsAudio"])],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4"),
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "0.9.0")
    ],
    targets: [
        .executableTarget(
            name: "OatsAudio",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "WhisperKit", package: "WhisperKit")
            ]
        )
    ]
)

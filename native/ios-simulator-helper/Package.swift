// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SolentaSimulatorHelper",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "SolentaSimulatorHelper", targets: ["SolentaSimulatorHelper"])
  ],
  targets: [
    .target(
      name: "SimulatorPrivateBridge",
      publicHeadersPath: "include",
      linkerSettings: [
        .linkedFramework("Foundation"),
        .linkedFramework("CoreMedia"),
        .linkedFramework("CoreVideo"),
        .linkedFramework("CoreGraphics"),
        .linkedFramework("ImageIO"),
        .linkedFramework("IOSurface"),
        .linkedFramework("VideoToolbox"),
        .linkedLibrary("sandbox")
      ]
    ),
    .executableTarget(
      name: "SolentaSimulatorHelper",
      dependencies: ["SimulatorPrivateBridge"]
    ),
    .testTarget(
      name: "SolentaSimulatorHelperTests",
      dependencies: ["SolentaSimulatorHelper", "SimulatorPrivateBridge"]
    )
  ]
)

const { execFileSync } = require("node:child_process");
const { copyFile, rename } = require("node:fs/promises");
const path = require("node:path");

// Forge passes the build target on the command line (`--platform win32`), and
// packagerConfig is static, so it is read here to pick per-platform icons,
// makers and signing inputs.
const platformArgumentIndex = process.argv.indexOf("--platform");
const targetPlatform =
  platformArgumentIndex >= 0 ? process.argv[platformArgumentIndex + 1] : process.platform;
// Windows signing runs against the vendor's remote HSM; see scripts/sign-windows.cjs.
const { hasSigningCredentials, signMareoFile } = require("./scripts/sign-windows.cjs");
const windowsSign = { hookModulePath: path.join(__dirname, "scripts", "sign-windows.cjs") };

const makers = [];
if (targetPlatform === "darwin") {
  makers.push({
    name: "@electron-forge/maker-dmg",
    config: {
      format: "ULFO",
    },
  });
}
if (targetPlatform === "win32") {
  makers.push({
    name: "@electron-forge/maker-squirrel",
    config: {
      name: "Mareo",
      setupExe: "MareoSetup.exe",
      setupIcon: path.join(__dirname, "assets", "app-icon.ico"),
      loadingGif: path.join(__dirname, "assets", "installer-loading.gif"),
      // Shown in the Windows Apps & features list; must stay reachable.
      iconUrl: "https://mareo.cn/downloads/app-icon.ico",
      authors: "Wuhan Datou AI Technology Co., Ltd.",
      description: "Mareo desktop host for DeepSeek Harness",
    },
  });
}

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  // Squirrel unpacks the app again under this directory, and Windows stops at
  // 260 characters. The runtime's deepest file is already 186 characters, so the
  // Windows job points this at a short root (C:\m) instead of the checkout path.
  outDir: process.env.MAREO_OUT_DIR ?? "out",
  packagerConfig: {
    name: "Mareo",
    icon: targetPlatform === "win32"
      ? path.join(__dirname, "assets", "app-icon.ico")
      : path.join(__dirname, ".cache", "icons", "mareo.icns"),
    appBundleId: "app.mareo.desktop",
    appCategoryType: "public.app-category.productivity",
    asar: true,
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
    },
    extraResource: [".staging/rt", ".staging/node-runtime"],
    // Signs Mareo.exe during packaging, before Squirrel packs it into the
    // installer; the hook itself decides which files are ours.
    windowsSign,
    ignore: [
      /^\/\.cache(?:\/|$)/,
      /^\/\.github(?:\/|$)/,
      /^\/\.npm-cache(?:\/|$)/,
      /^\/\.staging(?:\/|$)/,
      /^\/dist\/tests(?:\/|$)/,
      /^\/runtime(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/server(?:\/|$)/,
      /^\/brand(?:\/|$)/,
      /^\/website(?:\/|$)/,
      /^\/docs(?:\/|$)/,
      /^\/entitlements\.mac\.plist$/,
      /^\/tests(?:\/|$)/,
      /^\/src\/.*\.ts$/,
    ],
  },
  makers,
  hooks: {
    generateAssets: async () => {
      // The macOS icon is generated with sips/iconutil; Windows and other
      // hosts use the committed assets/app-icon.ico instead.
      if (process.platform !== "darwin") return;
      execFileSync(process.execPath, [
        path.join(__dirname, "scripts", "generate-icon.mjs"),
      ]);
    },
    postMake: async (_forgeConfig, makeResults) => {
      // Canonical artifact names: Mareo-<version>-<os>-<arch>[...].<ext>
      const results = Array.isArray(makeResults) ? makeResults : [makeResults];
      for (const result of results) {
        const version = result.packageJSON?.version;
        if (!version) continue;
        const arch = result.arch ?? process.arch;
        for (const artifact of result.artifacts ?? []) {
          if (result.platform === "darwin" && artifact.endsWith(".dmg")) {
            const target = path.join(path.dirname(artifact), `Mareo-${version}-macos-${arch}.dmg`);
            if (target !== artifact) await rename(artifact, target);
          }
          if (result.platform === "win32" && path.basename(artifact) === "MareoSetup.exe") {
            // Sign before publishing copies: a copy keeps its signature, so the
            // versioned name is signed as well.
            if (hasSigningCredentials()) {
              signMareoFile(artifact);
            } else {
              console.log("no signing credentials in the environment; leaving MareoSetup.exe unsigned");
            }
            // Keep MareoSetup.exe (Squirrel's update chain needs the fixed name)
            // and publish a versioned copy for humans and manifests.
            await copyFile(artifact, path.join(path.dirname(artifact), `Mareo-${version}-windows-${arch}-setup.exe`));
          }
        }
      }
    },
    postPackage: async (_forgeConfig, { platform, outputPaths }) => {
      if (platform !== "darwin") return;
      const unusedPermissions = [
        "NSAudioCaptureUsageDescription",
        "NSBluetoothAlwaysUsageDescription",
        "NSBluetoothPeripheralUsageDescription",
        "NSCameraUsageDescription",
        "NSMicrophoneUsageDescription",
      ];
      // Optional Developer ID signing + notarization (see scripts/sign-macos.mjs).
      const { signApp, notarizeApp } = await import("./scripts/sign-macos.mjs");
      for (const outputPath of outputPaths) {
        const infoPlist = path.join(
          outputPath,
          "Mareo.app",
          "Contents",
          "Info.plist",
        );
        for (const permission of unusedPermissions) {
          execFileSync("/usr/bin/plutil", ["-remove", permission, infoPlist]);
        }
        const appPath = path.join(outputPath, "Mareo.app");
        if (await signApp(appPath)) {
          await notarizeApp(appPath);
        }
      }
    },
  },
};

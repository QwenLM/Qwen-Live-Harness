# Agent Remote iOS

[简体中文](README_ZH.md) · [Install the computer gateway](../README.md)

From the package directory, run `npm ci && npm run build` first. Then:

```sh
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

Select your development team and trusted iPhone, then Run. The display name is Agent Remote. Bundle ID, registered pairing schemes and Keychain identifiers intentionally retain the original values so upgrading preserves paired credentials. Do not rename them when installing over the original app.

Simulator example:

```sh
xcodebuild -project QwenLiveMobile.xcodeproj -scheme QwenLiveMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

For all TLS/UI tests, first run `npm run test:ios-fixture` in the package directory and leave it running, then regenerate the project. Restart the fixture for each test run. Without it the dependent tests explicitly skip. All automated tasks use fake agents; physical network, camera, signing and real backend acceptance are separate checks.

The client enforces HTTPS, rejects redirects and validates the paired certificate pin, hostname, expiry and server use. An ATS IPv4 exception permits private pinned certificates; it does not bypass these client checks. Tests reject wrong pins and plaintext requests.

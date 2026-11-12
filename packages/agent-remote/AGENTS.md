# Working on Agent Remote

- This directory is an extractable project. Keep all runtime imports, test fixtures, build tools and configuration within it. Do not import adjacent Harness or Host source.
- Preserve the v1 HTTPS/pairing contract, existing iOS bundle and Keychain identifiers, and legacy state-directory compatibility unless explicitly requested otherwise.
- Qwen YOLO / Codex Full Access and automatic one-time approvals are the user's chosen defaults. Keep session/job identity, stale-request, cancellation and process-ownership checks intact.
- Test with owned fake ACP processes and temporary credentials. Never use personal model accounts in default tests.
- Run `npm ci`, `npm run build`, `npm run typecheck`, `npm test` and `npm run check:package`. Start `npm run test:ios-fixture` before generating the Xcode project for complete native tests.
- macOS changes also require `npm run test:macos`, `npm run build:macos` and `npm run check:macos`. The bundle acceptance check uses a separate launchd label, HOME and fake agent. Never replace the real service from an automated test. `npm run package:macos -- --skip-build` produces local PKG/DMG artifacts from the validated app; unsigned local builds are not Apple-notarized releases.
- The parent repository LICENSE is the only maintained copy. Build/export tools generate distribution copies. Do not add a maintained package-root LICENSE while this directory lives in the parent repository.
- Keep English and Simplified Chinese guidance consistent. Build caches, generated Xcode projects and pairing fixtures are ignored.
- `npm run export` creates the standalone source distribution; `npm run bundle` produces the local-install tarball. Neither command publishes anything.

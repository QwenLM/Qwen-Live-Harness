# Pinned Qwen Code peer SDK

This directory contains the **unmodified** Node-only peer entry point from
[`QwenLM/qwen-code` PR #11560](https://github.com/QwenLM/qwen-code/pull/11560),
commit `af4dece3a73a545d45e5a81948ac1374f9068ea1`. The published
`@qwen-code/sdk@0.1.12` does not contain the `./peer` export, so Live temporarily
vendors only this independent entry point. The existing published HTTP SDK
dependency remains in use.

`upstream.json` records the exact public source paths and SHA-256 hashes. The
upstream Apache-2.0 license is preserved here and shipped, together with the
provenance manifest, in the installed Live package. No Qwen CLI, core package,
or sibling checkout is required to build or run this code.

- `npm run check:peer-source` verifies the checked-in bytes offline. Every
  normal build also runs this check; CI and installation need no GitHub access.
- `npm run restore:peer-source` explicitly downloads every locked file from
  `raw.githubusercontent.com`, verifies all hashes, then restores the files.
  It does not select a newer upstream version or change the lock.
- To update the pin, review a fixed upstream commit and its complete peer
  dependency set, update the manifest hashes, restore the files, and run the
  build and tests. Keep third-party source changes upstream rather than
  patching these files locally.
- Once a published SDK includes `./peer`, replace this source import and
  remove the vendor directory and restore/check script in the same change.

The sources are excluded narrowly from local formatting and linting to retain
their exact upstream bytes. TypeScript compilation, source hash verification,
repository boundary checks, and the isolated endpoint test still cover them.

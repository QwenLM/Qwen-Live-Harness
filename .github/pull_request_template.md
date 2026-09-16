<!--
Maintainers prioritize PRs with a clear reviewer test plan — without it, review may be delayed.

Write each paragraph or list item as one long line to keep the description easy to edit and read.
-->

## What this PR does

<!-- Describe the resulting behavior in prose, not by file or function names. -->

## Why it's needed

<!-- Describe the motivation, the problem being solved, or the user-facing benefit. -->

## Reviewer Test Plan

<!--
How a reviewer can confirm this PR: reproduction steps, expected vs observed behavior, and evidence. The CLI/daemon and macOS Host have separate checks; state what you verified locally.

User-visible CLI / Host changes: include before-and-after output, screenshots, or a short recording where useful.
Non-user-visible changes (refactor, types, docs): include relevant commands and results; write N/A under Before/After.
Share redacted evidence only. Do not upload API keys, tokens, private configuration, Memory contents, or raw media / visual Monitor debug archives.
-->

### How to verify

<!-- Give the exact launch command or Host action and what a reviewer should observe. For lifecycle changes, cover startup, repeated launch, and coordinated Quit. For device or permission changes, identify the source, capture mode, device type, and permission state tested. -->

### Evidence (Before & After)

<!-- User-visible changes: paste before-and-after output, screenshots, or a short recording. Non-UI changes: N/A. -->

### Tested on

| Component    | Environment                                               | Result |
| :----------- | :-------------------------------------------------------- | :----- |
| CLI / daemon | OS and Node.js version                                    |        |
| macOS Host   | macOS version, arm64 / x64, installed app or source build |        |

<!-- ✅ tested · ⚠️ not tested · N/A for unaffected components -->

### Environment (optional)

<!-- For example: an npm-installed `qwen-live-harness`, or `npm start` from a source checkout. Note the Realtime model and background Harness (or none) if relevant. -->

## Risk & Scope

- Main risk or tradeoff:
- Not validated / out of scope:
- Breaking changes / migration notes:

<!-- Link relevant README or design documentation when behavior, configuration, or capability boundaries change. -->

## Linked Issues

<!--
Closes #N / Fixes #N / Resolves #N to auto-close.
Otherwise reference without a closing keyword.
-->

<details>
<summary>中文说明（可选）</summary>

<!--
可在此补充中文说明，涵盖修改目的、用户可见行为和验证方式，并与上面的英文内容保持一致。PR 标题使用英文。
-->

</details>

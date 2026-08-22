# DeepSeek Harness Desktop

Native desktop shells for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This repository only contains the shell and prebuilt runtime publishing logic.

- `apps/macos` — macOS shell (Swift + WKWebView)
- `apps/windows` — Windows shell (C# + WebView2)
- `apps/updater` — shell/core bootstrap and update helper
- `scripts/build-runtime-*` — prebuilt dsh runtime bundle builders
- `.github/workflows/runtime-release.yml` — automatic upstream prebuilt runtime release

Shell-only apps download the dsh core and Node runtime on first launch from upstream sources or from the published `dsh-runtime-*` GitHub Release.

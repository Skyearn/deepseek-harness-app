# Agent Note: macOS 状态栏随系统外观实时变化

Status: implemented

[English](2026-08-15-macos-status-bar-appearance.md) | 中文

## 问题

macOS 外壳绘制其 30px 状态栏时，把 `NSColor.windowBackgroundColor.cgColor` 赋给状态栏的图层。`windowBackgroundColor` 是动态目录颜色，而裸 `.cgColor` 读取会在环境绘制外观下解析它——这个环境外观会回退到浅色变体。因此当 macOS 切换到深色模式时，状态栏仍保留启动时的（浅色）颜色；即便外壳观察了 `NSApp.effectiveAppearance` 并在变化时重绘，每次重绘读取到的仍是同一个浅色 `.cgColor`，颜色始终没有改变。

## 决策

状态栏是一个图层背衬的 `StatusBarView: NSView`，在 `updateLayer()` 中把动态 `windowBackgroundColor` 赋给 `layer.backgroundColor`。AppKit 会在每次显示刷新时调用 `updateLayer()`——包括系统主题切换时——因此无需任何外观观察；而保留 `layer.backgroundColor`（而非在 `draw(_:)` 中绘制）可以维持与同级 WKWebView 相邻时正确的合成方式。颜色读取用 `effectiveAppearance.performAsCurrentDrawingAppearance { … }` 包住，这是按指定外观解析动态颜色的文档化做法；裸 `.cgColor` 读取正是那个被冻结的浅色快照。原先对 `NSApp.effectiveAppearance` 的 `NSKeyValueObservation` 以及 `repaintStatusBar` 方法一并移除。

## 备选方案

**在 `draw(_:)` 中用动态颜色绘制背景。** 不予采用，因为 `draw(_:)` 填充的图层在与 WKWebView 的远程内容相邻时合成方式不同：页面会盖住状态栏（且图层还需要显式的更新路径）。`updateLayer()` 保留了原来 `layer.backgroundColor` 的合成方式。

**保留一次性的 `layer.backgroundColor`，在外观钩子（KVO 或 `viewDidChangeEffectiveAppearance`）中重新读取。** 不予采用，因为这只是在重复实现 `updateLayer()` 已经自动完成的工作，并且仍取决于手工钩子是否触发、是否在正确时机解析。

**改用 `NSVisualEffectView` 或 `NSBox` 来绘制状态栏。** 不予采用，因为状态栏是自定义的 30px 色带，其纯窗口背景色外观已与应用整体一致；更换组件会改变观感而非修复问题。

## 影响

状态栏现在会随系统主题实时变化，与窗口 chrome 保持一致，且没有任何手工监听逻辑。该修复依赖 `wantsUpdateLayer`/`updateLayer()`（macOS 10.8+）、`performAsCurrentDrawingAppearance`（macOS 11+）以及动态 `NSColor` 语义——三者都在 macOS 13 的最低版本要求之内。今后状态栏背景必须在 `updateLayer()` 中把动态颜色以 `effectiveAppearance` 为作用域来设置，而不是赋成裸 `.cgColor` 快照，否则会再次冻结在浅色变体上。

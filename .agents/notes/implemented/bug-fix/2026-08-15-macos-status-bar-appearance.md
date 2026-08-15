# Agent Note: macOS status bar follows the live system appearance

Status: implemented

English | [中文](2026-08-15-macos-status-bar-appearance.zh.md)

## Problem

The macOS shell drew its 30px status bar by assigning `NSColor.windowBackgroundColor.cgColor` to the bar's layer. `windowBackgroundColor` is a dynamic catalog color, and a bare `.cgColor` read resolves it at the ambient drawing appearance — which falls back to the light variant. The bar therefore kept its launch-time (light) color when macOS switched to dark mode, even though the shell observed `NSApp.effectiveAppearance` and repainted on change: every repaint re-read the same light `.cgColor`, so the color never changed.

## Decision

The status bar is a layer-backed `StatusBarView: NSView` that sets `layer.backgroundColor` from the dynamic `windowBackgroundColor` in `updateLayer()`. AppKit calls `updateLayer()` on every display refresh — including when the system theme flips — so no appearance observation is needed, and keeping `layer.backgroundColor` (rather than drawing in `draw(_:)`) preserves the compositing that works beside the sibling WKWebView. The color read is scoped with `effectiveAppearance.performAsCurrentDrawingAppearance { … }`, the documented way to resolve a dynamic color for a specific appearance; the bare `.cgColor` read was the frozen light snapshot. The `NSKeyValueObservation` on `NSApp.effectiveAppearance` and the `repaintStatusBar` method are removed.

## Alternatives considered

**Draw the background in `draw(_:)` with the dynamic color.** Rejected because a `draw(_:)`-filled layer composites differently against the WKWebView's remote content: the page overlapped the bar (and the layer needed an explicit update path). `updateLayer()` keeps the original `layer.backgroundColor` compositing.

**Keep the one-time `layer.backgroundColor` and re-read it on an appearance hook (KVO or `viewDidChangeEffectiveAppearance`).** Rejected because it re-implements what `updateLayer()` already does automatically, and it still hinges on the manual hook firing and resolving at the right moment.

**Use `NSVisualEffectView` or `NSBox` for the bar.** Rejected because the bar is a custom 30px strip whose solid window-background look already matches the app; switching components would change its appearance rather than fix it.

## Consequences

The status bar follows the system theme live, matching the window chrome, with no manual plumbing. The fix relies on `wantsUpdateLayer`/`updateLayer()` (macOS 10.8+), `performAsCurrentDrawingAppearance` (macOS 11+), and dynamic `NSColor` semantics — all within the shell's macOS 13 minimum. Any future bar background must be set in `updateLayer()` with the dynamic color scoped to `effectiveAppearance`, not assigned as a bare `.cgColor` snapshot, or it will freeze at the light variant again.

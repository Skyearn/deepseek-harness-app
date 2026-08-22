// DeepSeek Harness macOS app shell.
//
// A thin native wrapper around `dsh web`: it resolves the dsh and node
// executables, launches the web runner in its own process group, embeds the
// served UI in a WKWebView window once the port accepts connections, and on
// quit — Cmd+Q, window close, or a termination signal — terminates the
// server's process group and verifies the port is released before exiting.
// The server itself is unchanged; this file only owns its lifecycle. The
// system browser is never opened automatically; "Open in Browser" in the menu
// is the explicit opt-in.

import Cocoa
import Darwin
import WebKit

// MARK: - Paths and configuration

let bundleID = "ai.deepseek.harness"

enum Paths {
    /// Where the shell keeps its lock files. Defaults to Application Support;
    /// the `stateDir` preference overrides it (used by tests and portable
    /// setups). The server's own data lives under DSH_HOME, untouched.
    static let appSupport: URL = {
        if let override = UserDefaults.standard.string(forKey: "stateDir") {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("DeepSeek Harness", isDirectory: true)
    }()
    static let logs: URL = {
        let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Logs/DeepSeek Harness", isDirectory: true)
    }()
    static let serverLog = logs.appendingPathComponent("server.log")
    static let serverLock = appSupport.appendingPathComponent("server.pid")
    static let appLock = appSupport.appendingPathComponent("app.pid")
    static let runtime = appSupport.appendingPathComponent("runtime", isDirectory: true)
    static let runtimeVersions = runtime.appendingPathComponent("versions", isDirectory: true)
    static let runtimeCurrent = runtime.appendingPathComponent("current")

    static func ensure(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
}

/// The port `dsh web` serves. Command-line arguments (`-port 8080`) override
/// the preference (`defaults write ai.deepseek.harness port -int 8080`); both
/// fall back to the dsh default of 3080.
func configuredPort() -> Int {
    let value = UserDefaults.standard.integer(forKey: "port")
    return value > 0 && value <= 65_535 ? value : 3080
}

// MARK: - Executable resolution

enum ExecutableResolver {
    /// Directories searched for `dsh` and `node`: the inherited PATH first,
    /// then the common install locations a Finder-launched app never sees.
    static func candidateDirs() -> [String] {
        var dirs: [String] = []
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            dirs += path.split(separator: ":").map(String.init)
        }
        let home = NSHomeDirectory()
        dirs += [
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
            "\(home)/.npm-global/bin", "\(home)/.local/bin",
            "\(home)/.volta/bin", "\(home)/.bun/bin",
        ]
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/.nvm/versions/node") {
            for version in versions.sorted(by: >) {
                dirs.append("\(home)/.nvm/versions/node/\(version)/bin")
            }
        }
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/.asdf/installs/nodejs") {
            for version in versions.sorted(by: >) {
                dirs.append("\(home)/.asdf/installs/nodejs/\(version)/bin")
            }
        }
        if let caches = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/.npm/_npx") {
            for hash in caches {
                dirs.append("\(home)/.npm/_npx/\(hash)/node_modules/.bin")
            }
        }
        return dirs
    }

    static func findInDirs(_ name: String) -> String? {
        for dir in candidateDirs() {
            let candidate = "\(dir)/\(name)"
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            // Skip shell-wrapper shims (e.g. ~/.local/bin/dsh) that are not
            // Node-entry JS files. The shell launches dsh through node, so a
            // `#!/bin/sh` wrapper would be parsed as JavaScript and fail.
            if let content = try? String(contentsOfFile: candidate, encoding: .utf8) {
                let shebang = content.components(separatedBy: .newlines).first ?? ""
                if shebang.hasPrefix("#!") && (shebang.contains("/sh") || shebang.contains("bash") || shebang.contains("zsh") || shebang.contains("pwsh")) {
                    continue
                }
            }
            return candidate
        }
        return nil
    }
}

/// The dsh package installed by the shell updater under the runtime dir:
/// ~/Library/Application Support/DeepSeek Harness/runtime/current.
func managedCoreDSHPath() -> String? {
    guard let current = try? String(contentsOf: Paths.runtimeCurrent, encoding: .utf8) else { return nil }
    let version = current.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !version.isEmpty else { return nil }
    let root = Paths.runtimeVersions.appendingPathComponent(version, isDirectory: true)
    let marker = root.appendingPathComponent(".complete")
    guard FileManager.default.fileExists(atPath: marker.path) else { return nil }
    let installed = root.appendingPathComponent("node_modules/@deepseek-ai/dsh/lib/bin.js").path
    return FileManager.default.fileExists(atPath: installed) ? installed : nil
}

/// The dsh executable, in order: the `dshPath` preference, the runtime install
/// maintained by the shell updater, the dsh install bundled under
/// Contents/Resources/dsh (from `build.sh --bundle-dsh`), then a PATH search.
/// The first three sources may be non-executable files — the bin is launched
/// through node, not directly.
func resolveDSH() -> String? {
    let fm = FileManager.default
    if let override = UserDefaults.standard.string(forKey: "dshPath") {
        if fm.fileExists(atPath: override) { return override }
        NSLog("ignoring dshPath override: no file at %@", override)
    }
    if let managed = managedCoreDSHPath() { return managed }
    if let resource = Bundle.main.resourceURL {
        for relative in ["dsh/node_modules/.bin/dsh", "dsh/bin/dsh"] {
            let candidate = resource.appendingPathComponent(relative).path
            if fm.fileExists(atPath: candidate) { return candidate }
        }
    }
    return ExecutableResolver.findInDirs("dsh")
}

/// The node executable, in order: the `nodePath` preference, then a PATH
/// search. dsh needs a node >= 22.19 (or >= 24).
func resolveNode() -> String? {
    let fm = FileManager.default
    if let override = UserDefaults.standard.string(forKey: "nodePath") {
        if fm.fileExists(atPath: override) { return override }
        NSLog("ignoring nodePath override: no file at %@", override)
    }
    if let resource = Bundle.main.resourceURL {
        let bundled = resource.appendingPathComponent("dsh/bin/node").path
        if fm.fileExists(atPath: bundled) { return bundled }
    }
    return ExecutableResolver.findInDirs("node")
}

// MARK: - Process and port helpers

/// True when a TCP connect to 127.0.0.1:port succeeds; used for readiness and
/// for verifying the port is released after termination.
func portOpen(port: Int) -> Bool {
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(port).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var sa = sockaddr()
    _ = withUnsafePointer(to: &addr) { memcpy(&sa, $0, MemoryLayout<sockaddr_in>.size) }
    return connect(fd, &sa, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
}

/// The pid listening on port, if any (via lsof). Best-effort: returns nil when
/// lsof cannot run or the call exceeds the timeout.
func listenerPid(port: Int) -> Int? {
    guard let output = captureProcessOutput(
        executable: "/usr/sbin/lsof",
        arguments: ["-nP", "-tiTCP:\(port)", "-sTCP:LISTEN"],
        timeout: 2
    ) else { return nil }
    return output.split(whereSeparator: \.isNewline).first.flatMap { Int($0) }
}

/// Runs a short-lived command and captures its stdout, with a hard timeout so a
/// missing or denied executable can never block the app.
func captureProcessOutput(executable: String, arguments: [String], timeout: TimeInterval) -> String? {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = Pipe()
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    do {
        try process.run()
    } catch {
        return nil
    }
    var output = ""
    let readQueue = DispatchQueue(label: "dsh-shell.capture")
    readQueue.async {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        output = String(data: data, encoding: .utf8) ?? ""
    }
    guard finished.wait(timeout: .now() + timeout) == .success else {
        process.terminate()
        return nil
    }
    return output
}

/// The NUL-separated argument strings of a process, read via
/// KERN_PROCARGS2. Used to confirm a pid belongs to this app's server before
/// any recovery kill; the buffer also carries environment strings, which the
/// caller tolerates.
func processArgStrings(_ processID: pid_t) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, Int32(processID)]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0, size < 1 << 20 else { return nil }
    var buffer = [CChar](repeating: 0, count: size)
    var newSize = size
    guard sysctl(&mib, 3, &buffer, &newSize, nil, 0) == 0 else { return nil }
    return buffer.withUnsafeBufferPointer { raw -> [String]? in
        guard let base = raw.baseAddress else { return nil }
        let limit = min(newSize, raw.count)
        guard limit > MemoryLayout<Int32>.size else { return nil }
        var offset = MemoryLayout<Int32>.size
        var strings: [String] = []
        for _ in 0..<256 {
            if offset >= limit { break }
            var end = offset
            while end < limit && base[end] != 0 { end += 1 }
            if end == offset { offset += 1; continue }
            let bytes = UnsafeBufferPointer(start: base + offset, count: end - offset).map { UInt8(bitPattern: $0) }
            strings.append(String(decoding: bytes, as: UTF8.self))
            offset = end + 1
        }
        return strings
    }
}

/// True when the pid is alive (kill 0 semantics).
func processExists(_ pid: Int32) -> Bool {
    guard pid > 0 else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

/// Spawns the server as the leader of its own process group, with stdout and
/// stderr appended to the server log. Returns the child pid.
@discardableResult
func spawnServer(executable: String, arguments: [String], environment: [String: String], logURL: URL) throws -> pid_t {
    var fileActions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fileActions)
    defer { posix_spawn_file_actions_destroy(&fileActions) }

    // Logging is best-effort: without a writable log the server still runs.
    let logFd = open(logURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    if logFd >= 0 {
        posix_spawn_file_actions_adddup2(&fileActions, logFd, STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&fileActions, logFd, STDERR_FILENO)
        posix_spawn_file_actions_addclose(&fileActions, logFd)
    }

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
    posix_spawnattr_setpgroup(&attr, 0)

    // argv[0] is the program name; the executable is passed separately to
    // posix_spawn, so the first real argument starts at index 1.
    let argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) } + [nil]
    defer { for pointer in argv { if let pointer { free(pointer) } } }

    let env: [UnsafeMutablePointer<CChar>?] = environment.keys.sorted()
        .map { strdup("\($0)=\(environment[$0]!)") } + [nil]
    defer { for pointer in env { if let pointer { free(pointer) } } }

    var pid: pid_t = 0
    let result = posix_spawn(&pid, executable, &fileActions, &attr, argv, env)
    if result != 0 {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(result),
                      userInfo: [NSLocalizedDescriptionKey: "posix_spawn failed (\(result)) for \(executable)"])
    }
    return pid
}

// MARK: - Server controller

enum ServerState {
    case stopped
    case starting
    case running
    case stopping
    case failed(String)
}

/// Owns the `dsh web` child process: launch, readiness, crash detection, and
/// teardown. All state changes happen on the main thread.
final class ServerController {
    static let shared = ServerController()

    private(set) var state: ServerState = .stopped
    private(set) var port: Int
    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }

    private var pid: pid_t = 0
    private var dshPath = ""
    private var nodePath = ""
    private var pendingFailure: String?
    private(set) var isQuitting = false
    private var watchdog: Timer?
    private var reaperLock = NSLock()

    var onStateChange: (() -> Void)?

    private init() {
        port = configuredPort()
        Paths.ensure(Paths.appSupport)
        Paths.ensure(Paths.logs)
    }

    // MARK: Launch

    /// Resolves both executables once; recovery and start both need them.
    /// Returns false and records the message when either is missing.
    @discardableResult
    func resolvePaths() -> Bool {
        let dsh = resolveDSH()
        let node = resolveNode()
        guard let dsh, let node else {
            pendingFailure = buildResolutionMessage(dsh: dsh, node: node)
            return false
        }
        dshPath = dsh
        nodePath = node
        return true
    }

    func start() {
        guard !isQuitting else { return }
        if case .running = state { return }
        if case .starting = state { return }

        if dshPath.isEmpty || nodePath.isEmpty {
            guard resolvePaths() else {
                fail(pendingFailure ?? "Cannot find dsh or node.")
                return
            }
        }

        // Fast-path diagnostics: a foreign process already on the port means
        // the server could never bind; surface that before spawning a doomed
        // child. (Recovery runs before start and clears our own orphan.)
        if portOpen(port: port) {
            fail("Port \(port) is already in use by another process. Quit that process, or choose another port (defaults write ai.deepseek.harness port -int <n>).")
            return
        }

        var arguments = [dshPath, "web", "--no-open"]
        if port != 3080 { arguments += ["--port", String(port)] }
        let nodeDir = URL(fileURLWithPath: nodePath).deletingLastPathComponent().path
        let environment = childEnvironment(extraPathDirs: [nodeDir])

        do {
            pid = try spawnServer(executable: nodePath, arguments: arguments, environment: environment, logURL: Paths.serverLog)
        } catch {
            fail(error.localizedDescription)
            return
        }
        writeServerLock()
        state = .starting
        onStateChange?()
        startWatchdog()
        pollReadiness()
    }

    private func buildResolutionMessage(dsh: String?, node: String?) -> String {
        var missing: [String] = []
        if dsh == nil { missing.append("dsh") }
        if node == nil { missing.append("node") }
        return "Cannot find \(missing.joined(separator: " and ")). Install it, or set the dshPath/nodePath preferences (see apps/macos/README.md)."
    }

    private func childEnvironment(extraPathDirs: [String]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        var pathDirs = extraPathDirs
        if let existing = env["PATH"] { pathDirs.append(existing) }
        env["PATH"] = pathDirs.joined(separator: ":")
        env["HOME"] = NSHomeDirectory()
        env["DSH_HOME"] = env["DSH_HOME"] ?? "\(NSHomeDirectory())/.dsh"
        return env
    }

    /// Polls the port (and the child) from a background thread until the server
    /// accepts connections, the child dies, or 90 seconds pass.
    private func pollReadiness() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(90)
            while Date() < deadline {
                if self.isQuitting { return }
                if case .stopping = self.state { return }
                switch self.reapChild() {
                case .exited(let code):
                    DispatchQueue.main.async { self.onServerExited(code: code, signal: 0) }
                    return
                case .signaled(let signal):
                    DispatchQueue.main.async { self.onServerExited(code: 0, signal: signal) }
                    return
                case .notRunning:
                    return
                case .running:
                    break
                }
                if portOpen(port: self.port) {
                    DispatchQueue.main.async { self.onReady() }
                    return
                }
                usleep(250_000)
            }
            DispatchQueue.main.async {
                self.fail("The server did not start within 90 seconds; see \(Paths.serverLog.path)")
            }
        }
    }

    private func startWatchdog() {
        watchdog?.invalidate()
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self, !self.isQuitting else { return }
            guard case .running = self.state else { return }
            switch self.reapChild() {
            case .exited(let code):
                self.onServerExited(code: code, signal: 0)
            case .signaled(let signal):
                self.onServerExited(code: 0, signal: signal)
            case .notRunning, .running:
                break
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdog = timer
    }

    /// waitpid(WNOHANG); the single reaper for the child, serialized so the
    /// readiness poll and the watchdog never race.
    private func reapChild() -> ChildState {
        reaperLock.lock()
        defer { reaperLock.unlock() }
        guard pid > 0 else { return .notRunning }
        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid {
            // waitpid status: low 7 bits are the terminating signal.
            let signal = Int(status & 0x7f)
            if signal != 0 && signal != 0x7f { return .signaled(signal) }
            return .exited(Int((status >> 8) & 0xff))
        }
        if result == 0 { return .running }
        return .notRunning
    }

    private enum ChildState {
        case running
        case exited(Int)
        case signaled(Int)
        case notRunning
    }

    // MARK: Transitions

    private func onReady() {
        guard !isQuitting else { return }
        state = .running
        onStateChange?()
        if UserDefaults.standard.bool(forKey: "openBrowserOnLaunch") {
            NSWorkspace.shared.open(url)
        }
    }

    private func onServerExited(code: Int, signal: Int) {
        watchdog?.invalidate()
        watchdog = nil
        removeServerLockIfOwned()
        guard !isQuitting else { return }
        let detail = signal != 0 ? "signal \(signal)" : "exit code \(code)"
        fail("The server stopped (\(detail)).\n\n" + lastLogLines(Paths.serverLog, count: 30))
    }

    private func fail(_ message: String) {
        state = .failed(message)
        onStateChange?()
    }

    /// Reads the tail of the server log for diagnostics.
    private func lastLogLines(_ url: URL, count: Int) -> String {
        guard let data = try? String(contentsOf: url, encoding: .utf8) else { return "(no log yet)" }
        let lines = data.split(whereSeparator: \.isNewline)
        let tail = lines.suffix(count).joined(separator: "\n")
        return tail.isEmpty ? "(log is empty)" : tail
    }

    // MARK: Teardown

    func restart() {
        guard !isQuitting else { return }
        terminateServer()
        state = .stopped
        onStateChange?()
        start()
    }

    /// Terminates the server process group and verifies the port is released.
    /// Only our own process group is ever killed; a foreign process that
    /// happens to hold the port after our child dies is left alone.
    func terminateServer() {
        guard pid > 0 else { return }
        state = .stopping
        onStateChange?()

        kill(-pid, SIGTERM)
        var waited = 0
        while waited < 6000, portOpen(port: port) {
            usleep(100_000)
            waited += 100
        }
        if portOpen(port: port) {
            killGroupIfOurs(pid, signal: SIGKILL)
            usleep(300_000)
        }
        if portOpen(port: port) {
            NSLog("port %d still in use after terminating our server; leaving the listener alone", port)
        }
        removeServerLockIfOwned()
        pid = 0
        state = .stopped
        onStateChange?()
    }

    /// Quit path: stop everything and drop this instance's locks.
    func cleanup() {
        isQuitting = true
        watchdog?.invalidate()
        watchdog = nil
        terminateServer()
        removeAppLockIfOwned()
    }

    // MARK: Lock files

    private func writeServerLock() {
        guard pid > 0 else { return }
        try? "\(pid) \(port)\n".write(to: Paths.serverLock, atomically: true, encoding: .utf8)
    }

    private func removeServerLockIfOwned() {
        guard let content = try? String(contentsOf: Paths.serverLock, encoding: .utf8) else { return }
        if content.hasPrefix("\(pid) ") {
            try? FileManager.default.removeItem(at: Paths.serverLock)
        }
    }

    private func removeAppLockIfOwned() {
        let me = ProcessInfo.processInfo.processIdentifier
        guard let content = try? String(contentsOf: Paths.appLock, encoding: .utf8) else { return }
        if content.hasPrefix("\(me)") {
            try? FileManager.default.removeItem(at: Paths.appLock)
        }
    }

    func writeAppLock() {
        let me = ProcessInfo.processInfo.processIdentifier
        try? "\(me)\n".write(to: Paths.appLock, atomically: true, encoding: .utf8)
    }

    /// Recovers an orphaned server from a hard-killed previous instance: only
    /// the exact pid recorded in the lock whose arguments match the resolved
    /// dsh path is terminated, the port is awaited, then the stale lock drops.
    func recoverStaleServer() {
        guard let content = try? String(contentsOf: Paths.serverLock, encoding: .utf8) else { return }
        defer { try? FileManager.default.removeItem(at: Paths.serverLock) }
        let fields = content.split(separator: " ").compactMap { Int($0) }
        guard let stalePid = fields.first, stalePid > 0, processExists(Int32(stalePid)) else { return }
        guard !dshPath.isEmpty, isOurServerProcess(Int32(stalePid)) else { return }
        NSLog("recovering orphaned server pid %d", stalePid)
        kill(-Int32(stalePid), SIGTERM)
        var waited = 0
        while waited < 4000, processExists(Int32(stalePid)) || portOpen(port: port) {
            usleep(100_000)
            waited += 100
        }
        if processExists(Int32(stalePid)) {
            killGroupIfOurs(Int32(stalePid), signal: SIGKILL)
            usleep(300_000)
        }
    }

    /// Kills the process group of a pid only when the process at that pid
    /// still matches the resolved dsh invocation, guarding against pid
    /// recycling between the graceful signal and the escalation.
    private func killGroupIfOurs(_ target: pid_t, signal: Int32) {
        guard isOurServerProcess(target) else {
            NSLog("not killing pid %d: no longer matches our server invocation", target)
            return
        }
        kill(-target, signal)
    }

    /// True when the pid's arguments contain the resolved dsh path and the
    /// `web` profile argument — the signature of a server this app spawned.
    private func isOurServerProcess(_ processID: Int32) -> Bool {
        guard !dshPath.isEmpty, let args = processArgStrings(processID) else { return false }
        let joined = args.joined(separator: " ")
        return joined.contains(dshPath) && joined.contains(" web ")
    }
}

// MARK: - Status bar

/// The bottom status bar: layer-backed so it composites correctly beside the
/// WKWebView, with its background set from the dynamic `windowBackgroundColor`
/// in `updateLayer()`. AppKit calls `updateLayer()` on every display refresh —
/// including when the system theme flips. `windowBackgroundColor` is dynamic,
/// and `cgColor` resolves it against the current drawing appearance, so the
/// read is scoped to the view's effective appearance; without that scope it
/// falls back to the light variant.
final class StatusBarView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
    }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        }
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusBar: NSView!
    private var webBottomConstraint: NSLayoutConstraint!
    private var statusLabel: NSTextField!
    private var urlField: NSTextField!
    private var signalSources: [DispatchSourceSignal] = []
    private var lastFailure: String?
    private var showStatusBarItem: NSMenuItem?
    private var progressIndicator: NSProgressIndicator?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()
        buildMenu()
        buildWindow()

        ServerController.shared.onStateChange = { [weak self] in self?.refreshUI() }
        refreshUI()

        // Tests pass -singleInstance 0 to run alongside an already-open app on
        // an isolated port and state dir.
        let singleInstance = UserDefaults.standard.object(forKey: "singleInstance") == nil
            || UserDefaults.standard.bool(forKey: "singleInstance")
        if singleInstance, let other = existingInstance() {
            other.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        ServerController.shared.writeAppLock()
        let hasBundledDsh = (Bundle.main.resourceURL?.appendingPathComponent("dsh").path)
            .map { FileManager.default.fileExists(atPath: $0) } ?? false
        if managedCoreDSHPath() == nil && !hasBundledDsh {
            statusLabel?.stringValue = "正在下载运行环境…"
            progressIndicator?.startAnimation(nil)
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let output = self?.runUpdaterStreaming(arguments: ["bootstrap"], timeout: 1800) { progress in
                    DispatchQueue.main.async { self?.statusLabel?.stringValue = progress }
                } ?? ""
                DispatchQueue.main.async {
                    self?.progressIndicator?.stopAnimation(nil)
                    if self?.parseUpdateOutput(output)["BOOTSTRAP_OK"] == "1" {
                        _ = ServerController.shared.resolvePaths()
                        ServerController.shared.recoverStaleServer()
                        ServerController.shared.start()
                    } else {
                        self?.showBootstrapFailure(output)
                    }
                }
            }
        } else {
            if !ServerController.shared.resolvePaths() {
                let bootstrap = parseUpdateOutput(runUpdater(arguments: ["bootstrap"], timeout: 1800))
                if bootstrap["BOOTSTRAP_OK"] == "1" {
                    _ = ServerController.shared.resolvePaths()
                }
            }
            ServerController.shared.recoverStaleServer()
            ServerController.shared.start()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        ServerController.shared.cleanup()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return true
    }

    /// Another instance of this app is already running; hand it the spotlight.
    /// The pid must still be alive — a stale LaunchServices entry must not
    /// count as an instance.
    private func existingInstance() -> NSRunningApplication? {
        let me = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first { $0.processIdentifier != me && processExists($0.processIdentifier) }
    }

    // MARK: UI

    /// Build the full menu bar. The Edit menu is required, not cosmetic: on
    /// macOS the standard text-editing shortcuts (⌘X/⌘C/⌘V/⌘A/⌘Z) reach the
    /// WKWebView's field editor only through menu items carrying those key
    /// equivalents, so without it copy/paste/select-all die inside the embedded
    /// web UI. All titles are Chinese product copy.
    private func buildMenu() {
        let mainMenu = NSMenu()

        // App menu — the first item shows the app name automatically.
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 DeepSeek Harness",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "打开浏览器", action: #selector(openBrowser(_:)), keyEquivalent: "b")
        appMenu.addItem(withTitle: "重启服务", action: #selector(restartServer(_:)), keyEquivalent: "r")
        appMenu.addItem(withTitle: "打开日志", action: #selector(openLogs(_:)), keyEquivalent: "l")
        appMenu.addItem(.separator())
        let toggleStatusBar = NSMenuItem(title: "",
                                         action: #selector(toggleStatusBar(_:)), keyEquivalent: "")
        toggleStatusBar.target = self
        appMenu.addItem(toggleStatusBar)
        showStatusBarItem = toggleStatusBar
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 DeepSeek Harness",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "隐藏其他",
                                    action: #selector(NSApplication.hideOtherApplications(_:)),
                                    keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "全部显示",
                        action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 DeepSeek Harness",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Update menu — keeps shell/core update actions out of the app menu.
        let updateItem = NSMenuItem()
        mainMenu.addItem(updateItem)
        let updateMenu = NSMenu(title: "更新")
        updateMenu.addItem(withTitle: "检查更新…", action: #selector(checkUpdates(_:)), keyEquivalent: "u")
        updateMenu.addItem(withTitle: "更新 DSH 内核", action: #selector(updateCore(_:)), keyEquivalent: "")
        updateMenu.addItem(withTitle: "更新 APP 壳", action: #selector(downloadShellUpdate(_:)), keyEquivalent: "")
        updateMenu.addItem(.separator())
        updateMenu.addItem(withTitle: "打开更新目录",
                           action: #selector(openUpdateDirectory(_:)), keyEquivalent: "")
        updateItem.submenu = updateMenu

        // Edit menu — routes undo/redo/cut/copy/paste/select-all through the
        // responder chain (nil target) so the web view's field editor receives
        // them; this is what makes ⌘Z/⇧⌘Z/⌘X/⌘C/⌘V/⌘A work in the embedded UI.
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        // Window menu — standard minimize/zoom/close shortcuts.
        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化",
                           action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放",
                           action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "关闭窗口",
                           action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "DeepSeek Harness"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.minSize = NSSize(width: 640, height: 420)

        let content = NSView()
        window.contentView = content

        // The embedded UI: the same page a browser would load at the served URL.
        // A non-persistent data store keeps WebKit off the disk (no HSTS/cache
        // writes); the server owns all durable state.
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(web)

        let bar = StatusBarView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(bar)

        statusLabel = NSTextField(labelWithString: "正在启动服务…")
        statusLabel.font = .systemFont(ofSize: 12)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(statusLabel)

        urlField = NSTextField(labelWithString: ServerController.shared.url.absoluteString)
        urlField.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        urlField.textColor = .secondaryLabelColor
        urlField.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(urlField)

        let progress = NSProgressIndicator()
        progress.style = .spinning
        progress.controlSize = .small
        progress.isIndeterminate = true
        progress.isDisplayedWhenStopped = false
        progress.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(progress)
        progressIndicator = progress

        let webBottom = web.bottomAnchor.constraint(equalTo: bar.topAnchor)

        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: content.topAnchor),
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webBottom,
            bar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            bar.heightAnchor.constraint(equalToConstant: 30),
            statusLabel.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 12),
            statusLabel.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            progressIndicator!.leadingAnchor.constraint(equalTo: statusLabel.trailingAnchor, constant: 8),
            progressIndicator!.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            progressIndicator!.widthAnchor.constraint(equalToConstant: 16),
            progressIndicator!.heightAnchor.constraint(equalToConstant: 16),
            urlField.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -12),
            urlField.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
        ])

        self.webView = web
        self.statusBar = bar
        self.webBottomConstraint = webBottom
        self.window = window
        applyStatusBarVisibility(animated: false)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func refreshUI() {
        guard let statusLabel, let urlField else { return }
        switch ServerController.shared.state {
        case .stopped, .starting:
            statusLabel.stringValue = "正在启动服务…"
            urlField.stringValue = ServerController.shared.url.absoluteString
        case .running:
            statusLabel.stringValue = "运行中"
            urlField.stringValue = ServerController.shared.url.absoluteString
            loadWebView()
        case .stopping:
            statusLabel.stringValue = "正在停止…"
        case .failed(let message):
            statusLabel.stringValue = "已停止"
            urlField.stringValue = ""
            showStoppedPage(message)
            if message != lastFailure {
                lastFailure = message
                showFailureAlert(message)
            }
        }
    }

    /// Loads the served page into the embedded web view. Called on every
    /// transition to `.running`, so a restart reloads the UI.
    private func loadWebView() {
        guard !isQuitting, webView != nil else { return }
        webView.load(URLRequest(url: ServerController.shared.url))
    }

    /// A minimal in-window error page when the server is down.
    private func showStoppedPage(_ message: String) {
        guard !isQuitting, webView != nil else { return }
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        let html = """
        <html><head><meta charset="utf-8"><style>
        body { font-family: -apple-system, sans-serif; padding: 48px; color: #666; }
        h2 { margin-bottom: 8px; }
        pre { white-space: pre-wrap; font-size: 12px; }
        </style></head>
        <body><h2>服务已停止</h2><pre>\(escaped)</pre></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private var isQuitting: Bool {
        ServerController.shared.isQuitting
    }

    private func showFailureAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "DeepSeek Harness 无法启动服务"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "更新 DSH 内核")
        alert.addButton(withTitle: "重启")
        alert.addButton(withTitle: "打开日志")
        alert.addButton(withTitle: "退出")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            updateCore(nil)
        case .alertSecondButtonReturn:
            ServerController.shared.restart()
        case .alertThirdButtonReturn:
            openLogs(nil)
        default:
            NSApp.terminate(nil)
        }
    }

    private func showBootstrapFailure(_ output: String) {
        let alert = NSAlert()
        alert.messageText = "下载运行环境失败"
        alert.informativeText = output.isEmpty ? "请检查网络后重试" : output
        alert.alertStyle = .critical
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    @objc private func openBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(ServerController.shared.url)
    }

    @objc private func restartServer(_ sender: Any?) {
        ServerController.shared.restart()
    }

    @objc private func openLogs(_ sender: Any?) {
        Paths.ensure(Paths.logs)
        NSWorkspace.shared.open(Paths.logs)
    }

    // MARK: Updates

    private func shellVersion() -> String {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("version.txt"),
           let text = try? String(contentsOf: url, encoding: .utf8) {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
    }

    private func runUpdater(arguments: [String], timeout: TimeInterval = 60) -> String {
        guard let node = resolveNode(),
              let script = Bundle.main.resourceURL?.appendingPathComponent("updater.mjs").path else {
            return "ERROR: 找不到 node 或 updater.mjs"
        }
        return captureProcessOutput(executable: node, arguments: [script] + arguments, timeout: timeout) ?? ""
    }

    private func runUpdaterStreaming(arguments: [String], timeout: TimeInterval, onProgress: @escaping (String) -> Void) -> String {
        guard let node = resolveNode(),
              let script = Bundle.main.resourceURL?.appendingPathComponent("updater.mjs").path else {
            return "ERROR: 找不到 node 或 updater.mjs"
        }
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script] + arguments
        process.standardOutput = pipe
        process.standardError = Pipe()
        let outputLock = NSLock()
        var output = ""
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { return }
            let text = String(data: data, encoding: .utf8) ?? ""
            outputLock.lock()
            output += text
            outputLock.unlock()
            for line in text.components(separatedBy: .newlines) {
                if line.hasPrefix("PROGRESS=") {
                    onProgress(line.replacingOccurrences(of: "PROGRESS=", with: ""))
                } else if line.hasPrefix("STATUS=") {
                    onProgress(String(line.dropFirst(7)))
                }
            }
        }
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do {
            try process.run()
        } catch {
            return "ERROR: \(error.localizedDescription)"
        }
        if done.wait(timeout: .now() + timeout) != .success {
            process.terminate()
        }
        pipe.fileHandleForReading.readabilityHandler = nil
        return output
    }

    private func parseUpdateOutput(_ output: String) -> [String: String] {
        var dict: [String: String] = [:]
        for line in output.components(separatedBy: .newlines) {
            if let eq = line.firstIndex(of: "=") {
                let key = String(line[..<eq])
                let value = String(line[line.index(after: eq)...])
                dict[key] = value
            }
        }
        return dict
    }

    private func isVersionAtLeast(_ current: String, _ latest: String) -> Bool {
        let a = current.split(separator: ".").compactMap { Int($0) }
        let b = latest.split(separator: ".").compactMap { Int($0) }
        let count = max(a.count, b.count)
        for i in 0..<count {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return true
    }

    private func updateLine(name: String, current: String, latest: String) -> String {
        if current.isEmpty || current == "?" { return "\(name)：未安装 -> \(latest)" }
        if isVersionAtLeast(current, latest) { return "\(name)：\(current)（已是最新）" }
        return "\(name)：\(current) -> \(latest)"
    }

    @objc private func checkUpdates(_ sender: Any?) {
        let output = runUpdater(arguments: ["check", "--shell-current", shellVersion()])
        let info = parseUpdateOutput(output)
        let shellCurrent = info["SHELL_CURRENT"] ?? "?"
        let shellLatest = info["SHELL_LATEST"] ?? "?"
        let coreCurrent = info["CORE_CURRENT"] ?? ""
        let coreLatest = info["CORE_LATEST"] ?? "?"
        let alert = NSAlert()
        alert.messageText = "检查更新"
        alert.informativeText = "\(updateLine(name: "壳", current: shellCurrent, latest: shellLatest))\n\(updateLine(name: "内核", current: coreCurrent, latest: coreLatest))"
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    @objc private func updateCore(_ sender: Any?) {
        let output = runUpdater(arguments: ["update-core"])
        let info = parseUpdateOutput(output)
        if info["CORE_UPDATED"] == "1" {
            ServerController.shared.restart()
            let alert = NSAlert()
            alert.messageText = "内核更新完成"
            alert.informativeText = "已切换到 \(info["CORE_VERSION"] ?? "?")"
            alert.addButton(withTitle: "好")
            alert.runModal()
        } else {
            let alert = NSAlert()
            alert.messageText = "内核更新失败"
            alert.informativeText = output.isEmpty ? "请检查网络后重试" : output
            alert.addButton(withTitle: "好")
            alert.runModal()
        }
    }

    @objc private func downloadShellUpdate(_ sender: Any?) {
        let output = runUpdater(arguments: ["download-shell"])
        let info = parseUpdateOutput(output)
        if info["SHELL_DOWNLOADED"] == "1", let path = info["SHELL_DOWNLOAD"] {
            NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: "")
        } else {
            let alert = NSAlert()
            alert.messageText = "壳更新下载失败"
            alert.informativeText = output.isEmpty ? "请检查网络后重试" : output
            alert.addButton(withTitle: "好")
            alert.runModal()
        }
    }

    @objc private func openUpdateDirectory(_ sender: Any?) {
        Paths.ensure(Paths.runtime)
        NSWorkspace.shared.open(Paths.runtime)
    }

    // MARK: Status bar

    private static let showStatusBarKey = "showStatusBar"

    /// The persisted status-bar visibility; the menu checkbox mirrors it.
    private var statusBarVisible: Bool {
        get { UserDefaults.standard.object(forKey: Self.showStatusBarKey) == nil
            || UserDefaults.standard.bool(forKey: Self.showStatusBarKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.showStatusBarKey) }
    }

    @objc private func toggleStatusBar(_ sender: Any?) {
        statusBarVisible.toggle()
        applyStatusBarVisibility(animated: true)
    }

    /// Show or hide the status bar and repaint it for the current appearance.
    private func applyStatusBarVisibility(animated: Bool) {
        guard let statusBar else { return }
        let visible = statusBarVisible
        // The menu item's title follows the state: it names the action that
        // the click performs, so it reads "隐藏状态栏" while visible and
        // "显示状态栏" while hidden.
        showStatusBarItem?.title = visible ? "隐藏状态栏" : "显示状态栏"
        // The web view anchors to the bar when visible, to the window edge
        // when hidden; swap the constraint so the web fills the released space.
        webBottomConstraint.isActive = false
        let newBottom = visible
            ? statusBar.topAnchor
            : statusBar.superview?.bottomAnchor
        if let newBottom {
            webBottomConstraint = webView.bottomAnchor.constraint(equalTo: newBottom)
            webBottomConstraint.isActive = true
        }
        statusBar.isHidden = !visible
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.2
                statusBar.superview?.layoutSubtreeIfNeeded()
            }
        }
    }
}

// MARK: - Entry

// Headless diagnostics for packaging and troubleshooting; prints the resolved
// executables and port state, then exits without starting anything.
if CommandLine.arguments.contains("--resolve") {
    let port = configuredPort()
    print("dsh=\(resolveDSH() ?? "<not found>")")
    print("node=\(resolveNode() ?? "<not found>")")
    print("port=\(port)")
    print("portOpen=\(portOpen(port: port))")
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

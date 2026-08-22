// DeepSeek Harness Windows launcher.
//
// A thin native wrapper around `dsh web`, mirroring the macOS shell in
// apps/macos: it resolves the dsh and node executables, launches the web
// runner as a child process, opens the default browser once the port accepts
// connections, and on quit terminates the child's process tree and verifies
// the port is released before exiting. The server itself is unchanged; this
// file only owns its lifecycle.
//
// Compiled with the .NET Framework csc.exe shipped with Windows (C# 5), so
// the build needs no SDK: keep the code within C# 5 and .NET Framework 4.x
// APIs.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace DeepSeekHarness
{
    // Settings come from the registry (HKCU\Software\DeepSeek Harness), then
    // command-line overrides, then defaults. Command-line keys mirror the
    // macOS shell's UserDefaults argument domain (-port, -stateDir, ...).
    internal static class Settings
    {
        public const string BundleId = "ai.deepseek.harness";
        public const string RegistryKey = @"Software\DeepSeek Harness";

        public static int Port = 3080;
        public static bool OpenBrowserOnLaunch = false;
        public static bool SingleInstance = true;
        public static bool ShowStatusBar = true;
        public static string DshPath;  // explicit path to dsh lib/bin.js
        public static string NodePath; // explicit path to node.exe
        public static string StateDir; // lock/log location override (tests)

        public static void Load()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryKey))
                {
                    if (key != null)
                    {
                        object value = key.GetValue("port");
                        if (value is int) Port = (int)value;
                        value = key.GetValue("openBrowserOnLaunch");
                        if (value is int) OpenBrowserOnLaunch = ((int)value) != 0;
                        value = key.GetValue("singleInstance");
                        if (value is int) SingleInstance = ((int)value) != 0;
                        value = key.GetValue("showStatusBar");
                        if (value is int) ShowStatusBar = ((int)value) != 0;
                        DshPath = key.GetValue("dshPath") as string;
                        NodePath = key.GetValue("nodePath") as string;
                        StateDir = key.GetValue("stateDir") as string;
                    }
                }
            }
            catch (Exception)
            {
            }

            string[] args = Environment.GetCommandLineArgs();
            for (int i = 1; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "-port" && i + 1 < args.Length)
                {
                    int parsed;
                    if (int.TryParse(args[++i], out parsed)) Port = parsed;
                }
                else if (arg == "-openBrowserOnLaunch" && i + 1 < args.Length)
                {
                    OpenBrowserOnLaunch = args[++i] != "0";
                }
                else if (arg == "-singleInstance" && i + 1 < args.Length)
                {
                    SingleInstance = args[++i] != "0";
                }
                else if (arg == "-showStatusBar" && i + 1 < args.Length)
                {
                    ShowStatusBar = args[++i] != "0";
                }
                else if (arg == "-dshPath" && i + 1 < args.Length)
                {
                    DshPath = args[++i];
                }
                else if (arg == "-nodePath" && i + 1 < args.Length)
                {
                    NodePath = args[++i];
                }
                else if (arg == "-stateDir" && i + 1 < args.Length)
                {
                    StateDir = args[++i];
                }
            }
        }

        public static bool HasArg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == name) return true;
            }
            return false;
        }

        public static string StatePath()
        {
            if (StateDir != null) return StateDir;
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DeepSeek Harness");
        }

        public static string ServerLogPath() { return Path.Combine(StatePath(), "server.log"); }
        public static string ServerLockPath() { return Path.Combine(StatePath(), "server.pid"); }
        public static string AppLockPath() { return Path.Combine(StatePath(), "app.pid"); }
    }

    internal static class Resolver
    {
        private static List<string> CandidateDirs()
        {
            List<string> dirs = new List<string>();
            string path = Environment.GetEnvironmentVariable("PATH");
            if (path != null) dirs.AddRange(path.Split(Path.PathSeparator));
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            dirs.Add(Path.Combine(appData, "npm"));
            dirs.Add(Path.Combine(programFiles, "nodejs"));
            dirs.Add(Path.Combine(localData, "Programs", "nodejs"));
            dirs.Add(Path.Combine(localData, "Volta", "bin"));
            dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin"));
            try
            {
                string nvm = Path.Combine(appData, "nvm");
                if (Directory.Exists(nvm))
                {
                    foreach (string version in Directory.GetDirectories(nvm)) dirs.Add(version);
                }
            }
            catch (Exception)
            {
            }
            try
            {
                string npx = Path.Combine(localData, "npm-cache", "_npx");
                if (Directory.Exists(npx))
                {
                    foreach (string hash in Directory.GetDirectories(npx))
                    {
                        dirs.Add(Path.Combine(hash, "node_modules", ".bin"));
                    }
                }
            }
            catch (Exception)
            {
            }
            return dirs;
        }

        public static string FindNode()
        {
            if (Settings.NodePath != null && File.Exists(Settings.NodePath)) return Settings.NodePath;
            string bundled = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "node", "node.exe");
            if (File.Exists(bundled)) return bundled;
            foreach (string dir in CandidateDirs())
            {
                string candidate = Path.Combine(dir, "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        public static string FindDsh()
        {
            if (Settings.DshPath != null && File.Exists(Settings.DshPath)) return Settings.DshPath;
            try
            {
                string currentFile = Path.Combine(Settings.StatePath(), "runtime", "current");
                if (File.Exists(currentFile))
                {
                    string version = File.ReadAllText(currentFile).Trim();
                    string pkg = Path.Combine(Settings.StatePath(), "runtime", "versions", version, "package");
                    string libBin = Path.Combine(pkg, "lib", "bin.js");
                    string dshBin = Path.Combine(pkg, "bin", "dsh");
                    if (File.Exists(libBin)) return libBin;
                    if (File.Exists(dshBin)) return dshBin;
                }
            }
            catch (Exception)
            {
            }
            string bundled = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
            if (File.Exists(bundled)) return bundled;
            foreach (string dir in CandidateDirs())
            {
                string candidate = Path.Combine(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }
    }

    internal static class Net
    {
        public static bool PortOpen(int port)
        {
            try
            {
                TcpClient client = new TcpClient();
                try
                {
                    IAsyncResult result = client.BeginConnect(IPAddress.Loopback, port, null, null);
                    bool opened = result.AsyncWaitHandle.WaitOne(300);
                    if (opened && client.Connected)
                    {
                        client.EndConnect(result);
                        return true;
                    }
                    return false;
                }
                finally
                {
                    client.Close();
                }
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    internal class Server
    {
        private static readonly object LogLock = new object();

        public Process Child;
        public int Pid;
        public string DshPath = "";
        public string NodePath = "";
        public bool Quitting;

        // Resolves both executables; recovery and start both need them.
        public void Resolve()
        {
            DshPath = Resolver.FindDsh() ?? "";
            NodePath = Resolver.FindNode() ?? "";
        }

        public string Start()
        {
            if (DshPath.Length == 0 || NodePath.Length == 0)
            {
                return "找不到 dsh 和/或 node。请安装它们，设置 dshPath/nodePath 注册表值 "
                    + @"(HKCU\Software\DeepSeek Harness)，或在构建时使用 --bundle-dsh。";
            }
            if (Net.PortOpen(Settings.Port))
            {
                return "端口 " + Settings.Port
                    + " 已被其他进程占用。请退出该进程，或选择其他端口 "
                    + "（注册表值 port 或 -port <n>）。";
            }
            try
            {
                Directory.CreateDirectory(Settings.StatePath());
            }
            catch (Exception)
            {
            }

            Process process = new Process();
            process.StartInfo.FileName = NodePath;
            process.StartInfo.Arguments = "\"" + DshPath + "\" web --no-open";
            if (Settings.Port != 3080) process.StartInfo.Arguments += " --port " + Settings.Port;
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.CreateNoWindow = true;
            process.StartInfo.WorkingDirectory =
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.RedirectStandardError = true;
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            string nodeDir = Path.GetDirectoryName(NodePath);
            process.StartInfo.EnvironmentVariables["PATH"] =
                (nodeDir == null ? "" : nodeDir + ";") + path;

            try
            {
                if (!process.Start()) return "Failed to start the server process.";
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
            Child = process;
            Pid = process.Id;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendLog(e.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendLog(e.Data);
            };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            WriteServerLock();
            return null;
        }

        private static void AppendLog(string line)
        {
            lock (LogLock)
            {
                try
                {
                    File.AppendAllText(Settings.ServerLogPath(), line + Environment.NewLine);
                }
                catch (Exception)
                {
                }
            }
        }

        public bool ChildAlive()
        {
            try
            {
                return Child != null && !Child.HasExited;
            }
            catch (Exception)
            {
                return false;
            }
        }

        public void WriteServerLock()
        {
            try
            {
                File.WriteAllText(Settings.ServerLockPath(),
                    Pid + " " + Settings.Port + Environment.NewLine);
            }
            catch (Exception)
            {
            }
        }

        public void RemoveServerLock()
        {
            try
            {
                if (File.Exists(Settings.ServerLockPath())) File.Delete(Settings.ServerLockPath());
            }
            catch (Exception)
            {
            }
        }

        public void WriteAppLock()
        {
            try
            {
                File.WriteAllText(Settings.AppLockPath(),
                    Process.GetCurrentProcess().Id + Environment.NewLine);
            }
            catch (Exception)
            {
            }
        }

        public void RemoveAppLock()
        {
            try
            {
                if (File.Exists(Settings.AppLockPath())) File.Delete(Settings.AppLockPath());
            }
            catch (Exception)
            {
            }
        }

        // Terminates the server's process tree and verifies the port is
        // released. Windows has no SIGTERM (Node's process.kill maps it to a
        // hard kill), so this is a tree kill via taskkill.
        public void Terminate()
        {
            if (Pid <= 0) return;
            Quitting = true;
            KillTree(Pid);
            int waited = 0;
            while (waited < 6000 && Net.PortOpen(Settings.Port))
            {
                Thread.Sleep(100);
                waited += 100;
            }
            if (Net.PortOpen(Settings.Port)) KillTree(Pid);
            RemoveServerLock();
            Pid = 0;
            Quitting = false;
        }

        private static void KillTree(int pid)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = "taskkill";
                info.Arguments = "/PID " + pid + " /T /F";
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                Process killer = Process.Start(info);
                if (killer != null) killer.WaitForExit(5000);
            }
            catch (Exception)
            {
            }
        }

        // Recovers an orphaned server from a hard-killed previous instance:
        // only the exact pid recorded in the lock whose command line contains
        // the resolved dsh path is terminated, then the stale lock drops.
        public void RecoverStale()
        {
            if (!File.Exists(Settings.ServerLockPath()))
            {
                return;
            }
            int stalePid = 0;
            try
            {
                string content = File.ReadAllText(Settings.ServerLockPath());
                string[] parts = content.Split(' ');
                if (parts.Length >= 1) int.TryParse(parts[0], out stalePid);
            }
            catch (Exception)
            {
            }
            if (stalePid > 0 && DshPath.Length > 0)
            {
                try
                {
                    Process stale = Process.GetProcessById(stalePid);
                    string commandLine = CommandLine(stalePid);
                    if (commandLine != null
                        && commandLine.IndexOf(DshPath, StringComparison.OrdinalIgnoreCase) >= 0
                        && commandLine.IndexOf(" web", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        KillTree(stalePid);
                    }
                }
                catch (Exception)
                {
                    // The recorded pid is no longer alive.
                }
            }
            RemoveServerLock();
        }

        private static string CommandLine(int pid)
        {
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
                {
                    foreach (ManagementObject obj in searcher.Get())
                    {
                        object value = obj["CommandLine"];
                        if (value != null) return value.ToString();
                    }
                }
            }
            catch (Exception)
            {
            }
            return null;
        }

        public string LogTail(int count)
        {
            try
            {
                if (!File.Exists(Settings.ServerLogPath())) return "(no log yet)";
                string[] lines = File.ReadAllLines(Settings.ServerLogPath());
                int start = Math.Max(0, lines.Length - count);
                StringBuilder builder = new StringBuilder();
                for (int i = start; i < lines.Length; i++)
                {
                    builder.AppendLine(lines[i]);
                }
                return builder.ToString().TrimEnd();
            }
            catch (Exception)
            {
                return "(log unreadable)";
            }
        }
    }

    internal class MainForm : Form
    {
        private readonly Server server = new Server();
        private WebView2 web;
        private Panel statusBar;
        private System.Windows.Forms.Timer lifeTimer;
        private Label statusLabel;
        private Label urlLabel;
        private Button openButton;
        private Button restartButton;
        private bool ready;
        private DateTime readyDeadline;
        private string lastFailure;

        public MainForm()
        {
            Text = "DeepSeek Harness";
            ClientSize = new Size(1100, 720);
            MinimumSize = new Size(640, 420);
            StartPosition = FormStartPosition.CenterScreen;

            // The embedded UI: the same page a browser would load at the
            // served URL. WebView2 runs on the Edge runtime installed with
            // Windows; the control reports a missing runtime through
            // CoreWebView2InitializationCompleted.
            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.CoreWebView2InitializationCompleted += delegate(object sender,
                CoreWebView2InitializationCompletedEventArgs e)
            {
                if (!e.IsSuccess)
                {
                    MessageBox.Show(this,
                        "缺少 Microsoft Edge WebView2 运行时。请从 "
                        + "https://developer.microsoft.com/microsoft-edge/webview2/ 安装。",
                        "需要 WebView2 运行时", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                else
                {
                    // Chinese text-editing context menu; the browser default
                    // (English on an English Windows) is replaced.
                    web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    web.CoreWebView2.ContextMenuRequested += OnContextMenuRequested;
                }
            };

            Panel bar = new Panel();
            bar.Dock = DockStyle.Bottom;
            bar.Height = 36;

            statusLabel = new Label();
            statusLabel.Text = "正在启动服务…";
            statusLabel.AutoSize = true;
            statusLabel.Location = new Point(12, 10);
            bar.Controls.Add(statusLabel);

            urlLabel = new Label();
            urlLabel.Text = "http://127.0.0.1:" + Settings.Port;
            urlLabel.AutoSize = true;
            urlLabel.ForeColor = SystemColors.GrayText;
            urlLabel.Location = new Point(12, 26);
            bar.Controls.Add(urlLabel);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.Dock = DockStyle.Right;
            buttons.WrapContents = false;
            buttons.Height = 36;
            buttons.Padding = new Padding(0, 5, 8, 0);

            openButton = new Button();
            openButton.Text = "打开浏览器";
            openButton.Width = 120;
            openButton.Enabled = false;
            openButton.Click += delegate { Browser.Open(Settings.Port); };

            restartButton = new Button();
            restartButton.Text = "重启";
            restartButton.Width = 80;
            restartButton.Enabled = false;
            restartButton.Click += delegate { Restart(); };

            ContextMenuStrip updateMenu = new ContextMenuStrip();
            ToolStripMenuItem checkItem = new ToolStripMenuItem("检查更新…");
            checkItem.Click += delegate { CheckUpdates(); };
            ToolStripMenuItem coreItem = new ToolStripMenuItem("更新 DSH 内核");
            coreItem.Click += delegate { UpdateCore(); };
            ToolStripMenuItem shellItem = new ToolStripMenuItem("更新 APP 壳");
            shellItem.Click += delegate { DownloadShellUpdate(); };
            ToolStripMenuItem updateDirItem = new ToolStripMenuItem("打开更新目录");
            updateDirItem.Click += delegate { OpenUpdateDirectory(); };
            updateMenu.Items.AddRange(new ToolStripItem[] {
                checkItem, coreItem, shellItem, new ToolStripSeparator(), updateDirItem
            });

            Button updateButton = new Button();
            updateButton.Text = "更新";
            updateButton.Width = 80;
            updateButton.Click += delegate { updateMenu.Show(updateButton, new Point(0, updateButton.Height)); };

            Button logsButton = new Button();
            logsButton.Text = "打开日志";
            logsButton.Width = 90;
            logsButton.Click += delegate { OpenLogs(); };

            Button quitButton = new Button();
            quitButton.Text = "退出";
            quitButton.Width = 74;
            quitButton.Click += delegate { Close(); };

            buttons.Controls.Add(openButton);
            buttons.Controls.Add(restartButton);
            buttons.Controls.Add(updateButton);
            buttons.Controls.Add(logsButton);
            buttons.Controls.Add(quitButton);
            bar.Controls.Add(buttons);
            statusBar = bar;
            bar.Visible = Settings.ShowStatusBar;

            // Right-clicking the status bar toggles it; the choice persists
            // to the registry so the next launch starts the way it ended.
            // The menu item's text names the action the click performs, so it
            // reads "隐藏状态栏" while visible and "显示状态栏" while hidden.
            ContextMenuStrip barMenu = new ContextMenuStrip();
            ToolStripMenuItem toggleBar = new ToolStripMenuItem("");
            UpdateStatusBarMenuItem(toggleBar, Settings.ShowStatusBar);
            toggleBar.Click += delegate
            {
                Settings.ShowStatusBar = !Settings.ShowStatusBar;
                statusBar.Visible = Settings.ShowStatusBar;
                UpdateStatusBarMenuItem(toggleBar, Settings.ShowStatusBar);
                SaveShowStatusBar(Settings.ShowStatusBar);
            };
            barMenu.Items.Add(toggleBar);
            bar.ContextMenuStrip = barMenu;

            Controls.Add(web);
            Controls.Add(bar);
        }

        private static void UpdateStatusBarMenuItem(ToolStripMenuItem item, bool visible)
        {
            item.Text = visible ? "隐藏状态栏" : "显示状态栏";
        }

        private static void SaveShowStatusBar(bool visible)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Settings.RegistryKey))
                {
                    key.SetValue("showStatusBar", visible ? 1 : 0, RegistryValueKind.DWord);
                }
            }
            catch (Exception)
            {
            }
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            Application.ApplicationExit += delegate { server.Terminate(); };
            server.WriteAppLock();
            server.Resolve();
            server.RecoverStale();
            string error = server.Start();
            if (error != null)
            {
                Fail(error);
                return;
            }
            ready = false;
            readyDeadline = DateTime.Now.AddSeconds(90);
            lifeTimer = new System.Windows.Forms.Timer();
            lifeTimer.Interval = 300;
            lifeTimer.Tick += LifeTick;
            lifeTimer.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (lifeTimer != null) lifeTimer.Stop();
            server.Terminate();
            server.RemoveAppLock();
            base.OnFormClosing(e);
        }

        private void LifeTick(object sender, EventArgs e)
        {
            if (server.Quitting) return;
            if (!server.ChildAlive())
            {
                lifeTimer.Stop();
                Fail("服务已停止（进程已退出）。\n\n" + server.LogTail(30));
                return;
            }
            if (!ready)
            {
                if (Net.PortOpen(Settings.Port))
                {
                    ready = true;
                    statusLabel.Text = "运行中";
                    urlLabel.Text = "http://127.0.0.1:" + Settings.Port;
                    openButton.Enabled = true;
                    restartButton.Enabled = true;
                    LoadWebView();
                    if (Settings.OpenBrowserOnLaunch) Browser.Open(Settings.Port);
                }
                else if (DateTime.Now > readyDeadline)
                {
                    lifeTimer.Stop();
                    Fail("服务未在 90 秒内启动。\n\n" + server.LogTail(30));
                }
            }
        }

        private void LoadWebView()
        {
            try
            {
                web.Source = new Uri("http://127.0.0.1:" + Settings.Port);
            }
            catch (Exception)
            {
            }
        }

        private void Restart()
        {
            server.Terminate();
            ready = false;
            statusLabel.Text = "Starting server…";
            urlLabel.Text = "http://127.0.0.1:" + Settings.Port;
            openButton.Enabled = false;
            restartButton.Enabled = false;
            readyDeadline = DateTime.Now.AddSeconds(90);
            string error = server.Start();
            if (error != null)
            {
                Fail(error);
                return;
            }
            if (lifeTimer == null)
            {
                lifeTimer = new System.Windows.Forms.Timer();
                lifeTimer.Interval = 300;
                lifeTimer.Tick += LifeTick;
            }
            lifeTimer.Start();
        }

        private void Fail(string message)
        {
            statusLabel.Text = "已停止";
            urlLabel.Text = "";
            openButton.Enabled = false;
            restartButton.Enabled = true;
            if (message == lastFailure) return;
            lastFailure = message;
            DialogResult result = MessageBox.Show(this, message,
                "DeepSeek Harness 无法启动服务",
                MessageBoxButtons.YesNoCancel, MessageBoxIcon.Error);
            if (result == DialogResult.Yes)
            {
                Restart();
            }
            else if (result == DialogResult.No)
            {
                OpenLogs();
            }
            else
            {
                Close();
            }
        }

        // MARK: Updater

        private string ShellVersion()
        {
            string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "version.txt");
            if (File.Exists(path)) return File.ReadAllText(path).Trim();
            return "0.0.0";
        }

        private string RunUpdater(string arguments)
        {
            string node = Resolver.FindNode();
            string updater = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "updater.mjs");
            if (node == null || !File.Exists(updater)) return "ERROR: 找不到 node 或 updater.mjs";
            try
            {
                Process p = new Process();
                p.StartInfo.FileName = node;
                p.StartInfo.Arguments = "\"" + updater + "\" " + arguments;
                p.StartInfo.UseShellExecute = false;
                p.StartInfo.CreateNoWindow = true;
                p.StartInfo.RedirectStandardOutput = true;
                p.StartInfo.RedirectStandardError = true;
                p.Start();
                string output = p.StandardOutput.ReadToEnd();
                string error = p.StandardError.ReadToEnd();
                p.WaitForExit();
                if (output.Length == 0) output = error;
                return output;
            }
            catch (Exception ex)
            {
                return "ERROR: " + ex.Message;
            }
        }

        private static Dictionary<string, string> ParseUpdateOutput(string output)
        {
            Dictionary<string, string> result = new Dictionary<string, string>();
            foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                int eq = line.IndexOf('=');
                if (eq > 0)
                {
                    result[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
            }
            return result;
        }

        private static string Get(Dictionary<string, string> info, string key, string fallback)
        {
            string value;
            return info.TryGetValue(key, out value) ? value : fallback;
        }

        private void CheckUpdates()
        {
            string output = RunUpdater("check --shell-current \"" + ShellVersion() + "\"");
            if (output.StartsWith("ERROR"))
            {
                MessageBox.Show(this, output, "检查更新失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            Dictionary<string, string> info = ParseUpdateOutput(output);
            string shellCurrent = Get(info, "SHELL_CURRENT", "?");
            string shellLatest = Get(info, "SHELL_LATEST", "?");
            string coreCurrent = Get(info, "CORE_CURRENT", "");
            string coreLatest = Get(info, "CORE_LATEST", "?");
            string text = "壳: " + shellCurrent + " -> " + shellLatest + "\n"
                + "内核: " + (coreCurrent.Length == 0 ? "未安装" : coreCurrent) + " -> " + coreLatest;
            MessageBox.Show(this, text, "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void UpdateCore()
        {
            string output = RunUpdater("update-core");
            Dictionary<string, string> info = ParseUpdateOutput(output);
            if (Get(info, "CORE_UPDATED", "") == "1")
            {
                Restart();
                MessageBox.Show(this, "内核已更新到 " + Get(info, "CORE_VERSION", "?"), "更新完成",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                MessageBox.Show(this, output.Length == 0 ? "更新失败，请检查网络" : output, "内核更新失败",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void DownloadShellUpdate()
        {
            string output = RunUpdater("download-shell");
            Dictionary<string, string> info = ParseUpdateOutput(output);
            if (Get(info, "SHELL_DOWNLOADED", "") == "1")
            {
                string path = Get(info, "SHELL_DOWNLOAD", Settings.StatePath());
                Directory.CreateDirectory(path);
                Process.Start("explorer.exe", path);
            }
            else
            {
                MessageBox.Show(this, output.Length == 0 ? "下载失败，请检查网络" : output, "壳更新下载失败",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OpenUpdateDirectory()
        {
            string runtimeDir = Path.Combine(Settings.StatePath(), "runtime");
            try
            {
                Directory.CreateDirectory(runtimeDir);
                Process.Start("explorer.exe", runtimeDir);
            }
            catch (Exception)
            {
            }
        }

        private static void OpenLogs()
        {
            try
            {
                Directory.CreateDirectory(Settings.StatePath());
                Process.Start(Settings.StatePath());
            }
            catch (Exception)
            {
            }
        }

        private int cutCommandId;
        private int copyCommandId;
        private int pasteCommandId;
        private int selectAllCommandId;

        // Supplies the Chinese text-editing context menu. Selecting a custom
        // command item re-raises the event with SelectedCommandId set to the
        // id WebView2 assigned when the item was created (the .NET
        // CreateContextMenuItem overload takes no command id; it is read back
        // from the returned item), which is where the edit command runs.
        private void OnContextMenuRequested(object sender, CoreWebView2ContextMenuRequestedEventArgs e)
        {
            if (e.SelectedCommandId != 0)
            {
                if (e.SelectedCommandId == cutCommandId) { web.CoreWebView2.ExecuteScriptAsync("document.execCommand('cut')"); }
                else if (e.SelectedCommandId == copyCommandId) { web.CoreWebView2.ExecuteScriptAsync("document.execCommand('copy')"); }
                else if (e.SelectedCommandId == pasteCommandId) { web.CoreWebView2.ExecuteScriptAsync("document.execCommand('paste')"); }
                else if (e.SelectedCommandId == selectAllCommandId) { web.CoreWebView2.ExecuteScriptAsync("document.execCommand('selectAll')"); }
                e.Handled = true;
                return;
            }
            e.MenuItems.Clear();
            CoreWebView2ContextMenuItem cutItem = web.CoreWebView2.Environment.CreateContextMenuItem(
                "剪切", null, CoreWebView2ContextMenuItemKind.Command);
            cutCommandId = cutItem.CommandId;
            e.MenuItems.Add(cutItem);
            CoreWebView2ContextMenuItem copyItem = web.CoreWebView2.Environment.CreateContextMenuItem(
                "拷贝", null, CoreWebView2ContextMenuItemKind.Command);
            copyCommandId = copyItem.CommandId;
            e.MenuItems.Add(copyItem);
            CoreWebView2ContextMenuItem pasteItem = web.CoreWebView2.Environment.CreateContextMenuItem(
                "粘贴", null, CoreWebView2ContextMenuItemKind.Command);
            pasteCommandId = pasteItem.CommandId;
            e.MenuItems.Add(pasteItem);
            CoreWebView2ContextMenuItem selectAllItem = web.CoreWebView2.Environment.CreateContextMenuItem(
                "全选", null, CoreWebView2ContextMenuItemKind.Command);
            selectAllCommandId = selectAllItem.CommandId;
            e.MenuItems.Add(selectAllItem);
            e.Handled = true;
        }
    }

    internal static class Browser
    {
        public static void Open(int port)
        {
            try
            {
                Process.Start("http://127.0.0.1:" + port);
            }
            catch (Exception)
            {
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Settings.Load();
            if (Settings.HasArg("--resolve"))
            {
                string dsh = Resolver.FindDsh() ?? "<not found>";
                string node = Resolver.FindNode() ?? "<not found>";
                Console.WriteLine("dsh=" + dsh);
                Console.WriteLine("node=" + node);
                Console.WriteLine("port=" + Settings.Port);
                Console.WriteLine("portOpen=" + Net.PortOpen(Settings.Port).ToString().ToLowerInvariant());
                return;
            }

            bool createdNew = false;
            Mutex mutex = null;
            if (Settings.SingleInstance)
            {
                mutex = new Mutex(true, Settings.BundleId + ".single", out createdNew);
                if (!createdNew)
                {
                    MessageBox.Show("DeepSeek Harness 已在运行。");
                    return;
                }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
            if (mutex != null) mutex.ReleaseMutex();
        }
    }
}

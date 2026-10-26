import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const DESKTOP_INDICATOR_IDLE_TIMEOUT_MS = 120_000;
export const DESKTOP_SCREEN_CONTROL_HOLD_MS = 120_000;
export const DESKTOP_INDICATOR_WATCHDOG_INTERVAL_MS = 5_000;
export const DESKTOP_INDICATOR_HEARTBEAT_STALE_MS = 15_000;
const READY_TIMEOUT_MS = 8_000;
const TOOL_REGISTRATION_INSTRUMENTED = Symbol("toolRegistrationInstrumented");
let lastIndicatorFailure: string | undefined;

export interface DesktopIndicatorState {
  active: number;
  waiting: number;
  screenControl: number;
  onlineOnly: boolean;
}

export type DesktopIndicatorActivity = "tool" | "screen-control";

export interface DesktopIndicatorDriver {
  show(state: DesktopIndicatorState): Promise<void>;
  update(state: DesktopIndicatorState): Promise<void>;
  hide(): Promise<void>;
}

export interface DesktopIndicatorController {
  run<T>(operation: () => Promise<T>, activity?: DesktopIndicatorActivity): Promise<T>;
  ensureOnline(): Promise<void>;
}

type InstrumentedMcpServer = McpServer & {
  [TOOL_REGISTRATION_INSTRUMENTED]?: boolean;
};

type ToolCallbackAdapter = (...args: unknown[]) => unknown;
type RegisterToolAdapter = (name: string, config: unknown, callback: ToolCallbackAdapter) => unknown;

function reportIndicatorFailure(stage: "show" | "update" | "hide", error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  lastIndicatorFailure = `${stage}: ${detail}`;
  console.warn(`[desktop-control-indicator] Unable to ${stage} the Windows activity badge: ${detail}`);
}

export function getDesktopControlIndicatorDiagnostics(): {
  enabled: boolean;
  environmentValue: string | null;
  readyTimeoutMs: number;
  idleTimeoutMs: number;
  screenControlHoldMs: number;
  watchdogIntervalMs: number;
  heartbeatStaleMs: number;
  lastFailure: string | null;
} {
  return {
    enabled: process.platform === "win32" && process.env.MCP_DESKTOP_INDICATOR_ENABLED !== "false",
    environmentValue: process.env.MCP_DESKTOP_INDICATOR_ENABLED ?? null,
    readyTimeoutMs: READY_TIMEOUT_MS,
    idleTimeoutMs: DESKTOP_INDICATOR_IDLE_TIMEOUT_MS,
    screenControlHoldMs: DESKTOP_SCREEN_CONTROL_HOLD_MS,
    watchdogIntervalMs: DESKTOP_INDICATOR_WATCHDOG_INTERVAL_MS,
    heartbeatStaleMs: DESKTOP_INDICATOR_HEARTBEAT_STALE_MS,
    lastFailure: lastIndicatorFailure ?? null,
  };
}

export function createDesktopControlIndicatorController(
  driver: DesktopIndicatorDriver,
  idleTimeoutMs = DESKTOP_INDICATOR_IDLE_TIMEOUT_MS,
  screenControlHoldMs = DESKTOP_SCREEN_CONTROL_HOLD_MS,
): DesktopIndicatorController {
  let activeOperations = 0;
  let waitingOperations = 0;
  let screenControlOperations = 0;
  let screenControlHoldActive = false;
  let onlineOnly = true;
  let indicatorVisible = false;
  let showPromise: Promise<void> | undefined;
  let hidePromise: Promise<void> | undefined;
  let hideTimer: NodeJS.Timeout | undefined;
  let screenControlTimer: NodeJS.Timeout | undefined;

  const currentState = (): DesktopIndicatorState => ({
    active: activeOperations,
    waiting: waitingOperations,
    screenControl: screenControlOperations + (screenControlHoldActive ? 1 : 0),
    onlineOnly,
  });
  const updateIndicator = async (): Promise<void> => {
    if (!indicatorVisible && !showPromise) return;
    try {
      await driver.update(currentState());
    } catch (error) {
      reportIndicatorFailure("update", error);
    }
  };

  return {
    async ensureOnline(): Promise<void> {
      onlineOnly = false;
      if (indicatorVisible || showPromise) {
        hidePromise = driver.hide()
          .catch((error) => reportIndicatorFailure("hide", error))
          .finally(() => {
            indicatorVisible = false;
            hidePromise = undefined;
          });
        await hidePromise;
      }
    },
    async run<T>(operation: () => Promise<T>, activity: DesktopIndicatorActivity = "tool"): Promise<T> {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }

      onlineOnly = false;
      waitingOperations += 1;
      if (hidePromise) await hidePromise;
      if (!indicatorVisible && !showPromise) {
        showPromise = driver.show(currentState())
          .then(() => { indicatorVisible = true; })
          .catch((error) => reportIndicatorFailure("show", error))
          .finally(() => { showPromise = undefined; });
      }
      const pendingShow = showPromise;
      await updateIndicator();
      if (pendingShow) await pendingShow;

      waitingOperations = Math.max(0, waitingOperations - 1);
      activeOperations += 1;
      if (activity === "screen-control") {
        if (screenControlTimer) {
          clearTimeout(screenControlTimer);
          screenControlTimer = undefined;
        }
        screenControlHoldActive = false;
        screenControlOperations += 1;
      }
      await updateIndicator();

      try {
        return await operation();
      } finally {
        activeOperations = Math.max(0, activeOperations - 1);
        if (activity === "screen-control") {
          screenControlOperations = Math.max(0, screenControlOperations - 1);
          if (screenControlOperations === 0) {
            screenControlHoldActive = true;
            screenControlTimer = setTimeout(() => {
              screenControlTimer = undefined;
              screenControlHoldActive = false;
              void updateIndicator();
            }, Math.max(0, screenControlHoldMs));
            screenControlTimer.unref?.();
          }
        }
        if (activeOperations === 0 && waitingOperations === 0) {
          await updateIndicator();
          hideTimer = setTimeout(() => {
            hideTimer = undefined;
            hidePromise = driver.hide()
              .catch((error) => reportIndicatorFailure("hide", error))
              .finally(() => {
                indicatorVisible = false;
                hidePromise = undefined;
              });
          }, Math.max(0, idleTimeoutMs));
          hideTimer.unref?.();
        } else {
          await updateIndicator();
        }
      }
    },
  };
}

const OVERLAY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class McpIndicatorNative {
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@
$readyPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__READY_PATH__'))
$statusPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__STATUS_PATH__'))
$heartbeatPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__HEARTBEAT_PATH__'))
$parentPid = __PARENT_PID__
function Get-IndicatorAreaInDips {
  # Keep positioning entirely in WPF device-independent coordinates.
  # Mixing WinForms physical pixels with WPF DIPs and foreground-window DPI
  # makes the badge jump off-screen when DPI/resolution/foreground changes.
  $workArea = [System.Windows.SystemParameters]::WorkArea
  return [pscustomobject]@{
    Left = [double]$workArea.Left
    Top = [double]$workArea.Top
    Right = [double]$workArea.Right
    Bottom = [double]$workArea.Bottom
  }
}
function Clamp-IndicatorPosition($area) {
  $maxLeft = [Math]::Max($area.Left, $area.Right - $window.Width)
  $maxTop = [Math]::Max($area.Top, $area.Bottom - $window.Height)
  $window.Left = [Math]::Max($area.Left, [Math]::Min($window.Left, $maxLeft))
  $window.Top = [Math]::Max($area.Top, [Math]::Min($window.Top, $maxTop))
}
$window = New-Object System.Windows.Window
$window.Title = 'MCP Bridge Activity'
$window.Width = 650
$window.Height = 72
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.AllowsTransparency = $false
$window.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(17, 24, 39))
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.Focusable = $false
$area = Get-IndicatorAreaInDips
$window.Left = $area.Left + 18
$window.Top = $area.Bottom - $window.Height - 12

$border = New-Object System.Windows.Controls.Border
$border.CornerRadius = New-Object System.Windows.CornerRadius(12)
$border.BorderThickness = New-Object System.Windows.Thickness(3)
$yellowBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(250, 204, 21))
$greenBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(34, 197, 94))
$onlineBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(56, 189, 248))
$border.BorderBrush = $yellowBrush
$border.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(17, 24, 39))
$border.Padding = New-Object System.Windows.Thickness(18, 10, 18, 10)

$stack = New-Object System.Windows.Controls.StackPanel
$stack.Orientation = [System.Windows.Controls.Orientation]::Horizontal
$stack.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$dot = New-Object System.Windows.Shapes.Ellipse
$dot.Width = 16
$dot.Height = 16
$dot.Margin = New-Object System.Windows.Thickness(0, 0, 14, 0)
$dot.Fill = $yellowBrush
$text = New-Object System.Windows.Controls.TextBlock
$text.Text = 'Bridge Đang Chờ Lệnh'
$text.Foreground = [System.Windows.Media.Brushes]::White
$text.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI Semibold')
$text.FontSize = 15
$text.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$stack.Children.Add($dot) | Out-Null
$stack.Children.Add($text) | Out-Null
$border.Child = $stack
$window.Content = $border

$window.Add_SourceInitialized({
  $handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  $style = [McpIndicatorNative]::GetWindowLong($handle, -20)
  [McpIndicatorNative]::SetWindowLong($handle, -20, $style -bor 0x00000020 -bor 0x00000080 -bor 0x08000000) | Out-Null
  $source = [System.Windows.Interop.HwndSource]::FromHwnd($handle)
  $script:hitTestHook = [System.Windows.Interop.HwndSourceHook]{
    param([IntPtr]$hwnd, [int]$msg, [IntPtr]$wParam, [IntPtr]$lParam, [ref]$handled)
    if ($msg -eq 0x0084) {
      $handled.Value = $true
      return [IntPtr](-1)
    }
    return [IntPtr]::Zero
  }
  $source.AddHook($script:hitTestHook)
})
$window.Add_ContentRendered({
  [IO.File]::WriteAllText($readyPath, 'ready', [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($heartbeatPath, [DateTime]::UtcNow.Ticks.ToString(), [Text.Encoding]::UTF8)
})
$parentTimer = New-Object System.Windows.Threading.DispatcherTimer
$parentTimer.Interval = [TimeSpan]::FromSeconds(1)
$parentTimer.Add_Tick({
  try { [Diagnostics.Process]::GetProcessById($parentPid) | Out-Null }
  catch { $window.Close() }
})
$parentTimer.Start()
$heartbeatTimer = New-Object System.Windows.Threading.DispatcherTimer
$heartbeatTimer.Interval = [TimeSpan]::FromSeconds(1)
$heartbeatTimer.Add_Tick({
  try { [IO.File]::WriteAllText($heartbeatPath, [DateTime]::UtcNow.Ticks.ToString(), [Text.Encoding]::UTF8) } catch {}
})
$heartbeatTimer.Start()
function Update-IndicatorText {
  try {
    $area = Get-IndicatorAreaInDips
    $parts = ([IO.File]::ReadAllText($statusPath, [Text.Encoding]::UTF8)).Split('|')
    if ($parts.Length -eq 4) {
      if ([int]$parts[2] -gt 0) {
        $window.Width = 430
        $window.Height = 72
        $window.Left = $area.Right - $window.Width - 18
        $window.Top = $area.Bottom - $window.Height - 12
        $window.Opacity = 0.52
        $border.BorderBrush = $greenBrush
        $dot.Fill = $greenBrush
        $text.Text = 'Bridge Đang Mượn Màn Hình'
      } elseif ($parts[0] -eq '0' -and $parts[1] -eq '0') {
        $window.Width = 430
        $window.Height = 72
        $window.Left = $area.Right - $window.Width - 18
        $window.Top = $area.Bottom - $window.Height - 12
        $window.Opacity = 0.42
        $border.BorderBrush = $yellowBrush
        $dot.Fill = $yellowBrush
        $text.Text = 'Bridge Đang Chờ Lệnh'
      } else {
        $window.Width = 650
        $window.Height = 72
        $window.Left = $area.Right - $window.Width - 18
        $window.Top = $area.Bottom - $window.Height - 12
        $window.Opacity = 0.56
        $border.BorderBrush = $yellowBrush
        $dot.Fill = $yellowBrush
        $text.Text = "Bridge Đang Xử Dụng Máy Thực Hiện (Đang chạy: $($parts[0]) | Chờ: $($parts[1])) Task"
      }
      Clamp-IndicatorPosition $area
    }
  } catch {}
}
Update-IndicatorText
$statusTimer = New-Object System.Windows.Threading.DispatcherTimer
$statusTimer.Interval = [TimeSpan]::FromMilliseconds(100)
$statusTimer.Add_Tick({
  Update-IndicatorText
})
$statusTimer.Start()
$window.ShowDialog() | Out-Null
`;

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWindowsDesktopIndicatorDriver(): DesktopIndicatorDriver {
  const indicatorDir = path.join(os.tmpdir(), `mcp-desktop-indicator-${process.pid}`);
  const readyPath = path.join(indicatorDir, "ready");
  const statusPath = path.join(indicatorDir, "status");
  const heartbeatPath = path.join(indicatorDir, "heartbeat");
  let overlayProcess: ChildProcess | undefined;
  let launchError: Error | undefined;
  let desiredVisible = false;
  let latestState: DesktopIndicatorState | undefined;
  let relaunchPromise: Promise<void> | undefined;
  let overlayStartedAt = 0;

  const isEnabled = (): boolean => process.platform === "win32" && process.env.MCP_DESKTOP_INDICATOR_ENABLED !== "false";
  const writeState = async (state: DesktopIndicatorState): Promise<void> => {
    latestState = { ...state };
    if (!isEnabled()) return;
    await fs.mkdir(indicatorDir, { recursive: true });
    const value = `${state.active}|${state.waiting}|${state.screenControl}|${state.onlineOnly ? 1 : 0}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.writeFile(statusPath, value, "utf8");
        lastIndicatorFailure = undefined;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" || attempt === 4) throw error;
        await delay(10);
      }
    }
  };

  const hide = async (): Promise<void> => {
    desiredVisible = false;
    const child = overlayProcess;
    overlayProcess = undefined;
    if (child?.exitCode === null && !child.killed) child.kill();
    await fs.rm(indicatorDir, { recursive: true, force: true });
  };

  const showOverlay = async (state: DesktopIndicatorState): Promise<void> => {
    if (!isEnabled()) return;
    desiredVisible = true;
    await writeState(state);
    if (overlayProcess?.exitCode === null && !overlayProcess.killed) return;

    await fs.mkdir(indicatorDir, { recursive: true });
    await fs.rm(readyPath, { force: true });
    launchError = undefined;
    const readyPathBase64 = Buffer.from(readyPath, "utf8").toString("base64");
    const statusPathBase64 = Buffer.from(statusPath, "utf8").toString("base64");
    const heartbeatPathBase64 = Buffer.from(heartbeatPath, "utf8").toString("base64");
    const script = OVERLAY_SCRIPT
      .replace("__READY_PATH__", readyPathBase64)
      .replace("__STATUS_PATH__", statusPathBase64)
      .replace("__HEARTBEAT_PATH__", heartbeatPathBase64)
      .replace("__PARENT_PID__", String(process.pid));
    let stderrOutput = "";
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encodePowerShell(script),
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: false });
    overlayProcess = child;
    overlayStartedAt = Date.now();
    child.once("error", (error) => { launchError = error; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrOutput = (stderrOutput + chunk).slice(-4_000);
    });
    child.once("exit", (code) => {
      if (overlayProcess === child) overlayProcess = undefined;
      if (!desiredVisible) return;
      const detail = stderrOutput.trim();
      lastIndicatorFailure = `overlay-exit: code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`;
    });
    child.unref();

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await fs.access(readyPath);
        lastIndicatorFailure = undefined;
        return;
      } catch {
        if (launchError) break;
        if (child.exitCode !== null) break;
        await delay(25);
      }
    }

    if (overlayProcess === child) overlayProcess = undefined;
    if (child.exitCode === null && !child.killed) child.kill();
    await fs.rm(indicatorDir, { recursive: true, force: true });
    throw launchError ?? new Error("Windows activity badge did not become ready in time.");
  };

  const heartbeatIsFresh = async (): Promise<boolean> => {
    try {
      const stat = await fs.stat(heartbeatPath);
      return Date.now() - stat.mtimeMs <= DESKTOP_INDICATOR_HEARTBEAT_STALE_MS;
    } catch {
      return false;
    }
  };

  const retireOverlay = async (child: ChildProcess): Promise<void> => {
    if (overlayProcess === child) overlayProcess = undefined;
    if (child.exitCode === null && !child.killed) child.kill();
    await Promise.all([
      fs.rm(readyPath, { force: true }),
      fs.rm(heartbeatPath, { force: true }),
    ]);
  };

  const ensureVisible = async (): Promise<void> => {
    if (!desiredVisible || !latestState || !isEnabled()) return;
    const child = overlayProcess;
    if (child?.exitCode === null && !child.killed) {
      if (await heartbeatIsFresh()) return;
      const launchGraceMs = READY_TIMEOUT_MS + DESKTOP_INDICATOR_WATCHDOG_INTERVAL_MS;
      if (Date.now() - overlayStartedAt <= launchGraceMs) return;
      lastIndicatorFailure = "watchdog: stale overlay heartbeat";
      await retireOverlay(child);
    }
    if (relaunchPromise) return relaunchPromise;
    relaunchPromise = showOverlay(latestState)
      .catch((error) => reportIndicatorFailure("update", error))
      .finally(() => { relaunchPromise = undefined; });
    return relaunchPromise;
  };

  const watchdogTimer = setInterval(() => {
    void ensureVisible();
  }, DESKTOP_INDICATOR_WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();

  return {
    async show(state): Promise<void> {
      desiredVisible = true;
      await showOverlay(state);
    },
    async update(state): Promise<void> {
      desiredVisible = true;
      await writeState(state);
      await ensureVisible();
    },
    hide,
  };
}

const desktopIndicator = createDesktopControlIndicatorController(createWindowsDesktopIndicatorDriver());

export function ensureDesktopControlIndicatorOnline(): Promise<void> {
  return desktopIndicator.ensureOnline();
}

export function instrumentMcpServerToolActivity(
  server: McpServer,
  controller: DesktopIndicatorController = desktopIndicator,
): void {
  const instrumentedServer = server as InstrumentedMcpServer;
  if (instrumentedServer[TOOL_REGISTRATION_INSTRUMENTED]) return;

  const registerTool = server.registerTool.bind(server) as RegisterToolAdapter;
  const serverAdapter = server as unknown as { registerTool: RegisterToolAdapter };
  serverAdapter.registerTool = (name, config, callback) => registerTool(
    name,
    config,
    (...args) => controller.run(async () => callback(...args)),
  );
  instrumentedServer[TOOL_REGISTRATION_INSTRUMENTED] = true;
}

export function withDesktopControlIndicator<T>(operation: () => Promise<T>): Promise<T> {
  return desktopIndicator.run(operation, "screen-control");
}

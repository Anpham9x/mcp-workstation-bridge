import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureWindowsScreen } from "./desktopControl.js";
import { withDesktopControlIndicator } from "./desktopControlIndicator.js";

const execFilePromise = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ELEMENTS = 200;
const DESTRUCTIVE_CONTROL_NAME = /\b(?:delete|remove|uninstall|format|shutdown|restart|erase|factory reset|purchase|pay|place order|send)\b/i;

type JsonRecord = Record<string, unknown>;

export interface DesktopSelector {
  name?: string;
  automationId?: string;
  controlType?: string;
  match?: "exact" | "contains";
}

const COMMON_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class McpDesktopNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    var inputs = new INPUT[2];
    inputs[0].type = 0; inputs[0].U.mi.dwFlags = 0x0002;
    inputs[1].type = 0; inputs[1].U.mi.dwFlags = 0x0004;
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput click failed.");
  }
  public static void Scroll(int delta) {
    var input = new INPUT[1]; input[0].type = 0; input[0].U.mi.dwFlags = 0x0800; input[0].U.mi.mouseData = unchecked((uint)delta);
    if (SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput scroll failed.");
  }
  public static void TypeUnicode(string value) {
    foreach (char ch in value) {
      var inputs = new INPUT[2];
      inputs[0].type = 1; inputs[0].U.ki.wScan = ch; inputs[0].U.ki.dwFlags = 0x0004;
      inputs[1].type = 1; inputs[1].U.ki.wScan = ch; inputs[1].U.ki.dwFlags = 0x0004 | 0x0002;
      if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput text failed.");
    }
  }
}
'@
function Get-Payload {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__'))
  return $json | ConvertFrom-Json
}
function Get-DesktopWindows {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $primary = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  if ($primary.Count -gt 0) { return $primary }

  # UI Automation can occasionally return an empty RootElement collection in
  # restricted-but-interactive sessions. Fall back to visible process window
  # handles from the current Windows session and convert those handles back to
  # AutomationElement instances.
  $currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $fallback = @()
  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    try {
      if ($process.SessionId -ne $currentSessionId -or $process.MainWindowHandle -eq 0) { continue }
      $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
      if ($element) { $fallback += $element }
    } catch {}
  }
  return $fallback
}
function Get-Window([string]$title, [string]$match) {
  foreach ($window in Get-DesktopWindows) {
    $name = $window.Current.Name
    if (($match -eq 'exact' -and $name -eq $title) -or ($match -ne 'exact' -and $name.IndexOf($title, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { return $window }
  }
  return $null
}
function Get-Element($root, $selector) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($item in $all) {
    $matches = $true
    if ($selector.name) {
      $actual = $item.Current.Name
      $matches = $matches -and (($selector.match -eq 'contains' -and $actual.IndexOf($selector.name, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($selector.match -ne 'contains' -and $actual -eq $selector.name))
    }
    if ($selector.automationId) { $matches = $matches -and ($item.Current.AutomationId -eq $selector.automationId) }
    if ($selector.controlType) { $matches = $matches -and ($item.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '' -eq $selector.controlType) }
    if ($matches) { return $item }
  }
  return $null
}
function Convert-BoundedInt($value) {
  $number = [double]$value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -gt [int]::MaxValue -or $number -lt [int]::MinValue) { return $null }
  return [int]$number
}
function Get-WindowState([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return "unknown" }
  if ([McpDesktopNative]::IsIconic($handle)) { return "minimized" }
  if ([McpDesktopNative]::IsZoomed($handle)) { return "maximized" }
  return "normal"
}
function Convert-Element($element) {
  $rect = $element.Current.BoundingRectangle
  $nativeHandle = [IntPtr]$element.Current.NativeWindowHandle
  return [ordered]@{
    name = $element.Current.Name
    automationId = $element.Current.AutomationId
    controlType = ($element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    enabled = $element.Current.IsEnabled
    offscreen = $element.Current.IsOffscreen
    password = $element.Current.IsPassword
    bounds = [ordered]@{ x = Convert-BoundedInt $rect.X; y = Convert-BoundedInt $rect.Y; width = Convert-BoundedInt $rect.Width; height = Convert-BoundedInt $rect.Height }
    nativeWindowHandle = $element.Current.NativeWindowHandle
    windowState = Get-WindowState $nativeHandle
    processId = $element.Current.ProcessId
  }
}
`;

const OBSERVE_SCRIPT = `${COMMON_POWERSHELL}
$payload = Get-Payload
$foreground = [McpDesktopNative]::GetForegroundWindow().ToInt32()
$windows = @()
$activeWindow = $null
foreach ($window in Get-DesktopWindows) {
  if (-not $window.Current.Name) { continue }
  $view = Convert-Element $window
  $windows += $view
  if ($view.nativeWindowHandle -eq $foreground) { $activeWindow = $window }
}
$elements = @()
if ($payload.includeElements -and $activeWindow) {
  $all = $activeWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $limit = [Math]::Min([int]$payload.maxElements, $all.Count)
  for ($i = 0; $i -lt $limit; $i++) {
    $element = $all.Item($i)
    if ($element.Current.Name -or $element.Current.AutomationId) { $elements += Convert-Element $element }
  }
}
$currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
$explorerSessionIds = @(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SessionId -Unique)
$chromeSessionIds = @(Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SessionId -Unique)
$diagnostics = [ordered]@{
  processSessionId = $currentProcess.SessionId
  userInteractive = [Environment]::UserInteractive
  sessionName = $env:SESSIONNAME
  explorerSessionIds = $explorerSessionIds
  chromeSessionIds = $chromeSessionIds
  windowCount = $windows.Count
  foregroundAvailable = ($foreground -ne 0)
  sameSessionExplorer = ($explorerSessionIds -contains $currentProcess.SessionId)
  sameSessionChrome = ($chromeSessionIds -contains $currentProcess.SessionId)
}
[ordered]@{ ok = $true; foregroundHandle = $foreground; windows = $windows; elements = $elements; diagnostics = $diagnostics } | ConvertTo-Json -Depth 7 -Compress
`;

const WINDOW_SCRIPT = `${COMMON_POWERSHELL}
$payload = Get-Payload
$window = Get-Window $payload.title $payload.match
if (-not $window) { throw "Desktop window not found." }
$handle = [IntPtr]$window.Current.NativeWindowHandle
$requestedState = [string]$payload.state
if (-not $requestedState) { $requestedState = "preserve" }
$beforeState = Get-WindowState $handle
switch ($requestedState) {
  "maximize" { [McpDesktopNative]::ShowWindow($handle, 3) | Out-Null }
  "restore" { [McpDesktopNative]::ShowWindow($handle, 9) | Out-Null }
  default { if ([McpDesktopNative]::IsIconic($handle)) { [McpDesktopNative]::ShowWindow($handle, 9) | Out-Null } }
}
$focusError = $null
try { $window.SetFocus() } catch { $focusError = $_.Exception.Message }
$focused = [McpDesktopNative]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 150
$afterState = Get-WindowState $handle
$verified = switch ($requestedState) {
  "maximize" { $afterState -eq "maximized" }
  "restore" { $afterState -eq "normal" }
  default { $afterState -ne "minimized" }
}
[ordered]@{ ok = $true; focused = $focused; verified = $verified; requestedState = $requestedState; beforeState = $beforeState; windowState = $afterState; focusError = $focusError; window = Convert-Element $window } | ConvertTo-Json -Depth 5 -Compress
`;

const ACTION_SCRIPT = `${COMMON_POWERSHELL}
$payload = Get-Payload
$root = $null
if ($payload.windowTitle) { $root = Get-Window $payload.windowTitle $payload.windowMatch }
if (-not $root) {
  $handle = [McpDesktopNative]::GetForegroundWindow().ToInt32()
  foreach ($window in Get-DesktopWindows) { if ($window.Current.NativeWindowHandle -eq $handle) { $root = $window; break } }
}
if (-not $root) { throw "No foreground desktop window is available." }
if ($payload.windowTitle) {
  $rootHandle = [IntPtr]$root.Current.NativeWindowHandle
  $requestedWindowState = [string]$payload.windowState
  if (-not $requestedWindowState) { $requestedWindowState = "preserve" }
  switch ($requestedWindowState) {
    "maximize" { [McpDesktopNative]::ShowWindow($rootHandle, 3) | Out-Null }
    "restore" { [McpDesktopNative]::ShowWindow($rootHandle, 9) | Out-Null }
    default { if ([McpDesktopNative]::IsIconic($rootHandle)) { [McpDesktopNative]::ShowWindow($rootHandle, 9) | Out-Null } }
  }
  [McpDesktopNative]::SetForegroundWindow($rootHandle) | Out-Null
  Start-Sleep -Milliseconds 100
}
$element = $null
if ($payload.selector) {
  $element = Get-Element $root $payload.selector
  if (-not $element) { throw "Desktop element not found." }
  if (-not $element.Current.IsEnabled) { throw "Desktop element is disabled." }
  if ($element.Current.IsOffscreen) { throw "Desktop element is offscreen." }
  if ($element.Current.IsPassword) { throw "Password controls are blocked." }
}
switch ($payload.action) {
  'click' {
    if (-not $element) { throw "click requires a semantic selector." }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() }
    else {
      $rect = $element.Current.BoundingRectangle
      if ($rect.Width -le 0 -or $rect.Height -le 0) { throw "Element has no clickable bounds." }
      [McpDesktopNative]::Click([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
    }
  }
  'set_text' {
    if (-not $element) { throw "set_text requires a semantic selector." }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) { $pattern.SetValue([string]$payload.text) }
    else { $element.SetFocus(); [McpDesktopNative]::TypeUnicode([string]$payload.text) }
  }
  'type_text' {
    if ($element) { $element.SetFocus() }
    [McpDesktopNative]::TypeUnicode([string]$payload.text)
  }
  'press_key' {
    if ($element) { $element.SetFocus() }
    [System.Windows.Forms.SendKeys]::SendWait([string]$payload.sendKeys)
  }
  'scroll' { [McpDesktopNative]::Scroll([int]$payload.delta) }
  'coordinate_click' { [McpDesktopNative]::Click([int]$payload.x, [int]$payload.y) }
  default { throw "Unsupported desktop action." }
}
Start-Sleep -Milliseconds 120
$windowView = Convert-Element $root
$windowStateVerified = $true
if ($payload.windowTitle) {
  if ($requestedWindowState -eq "maximize") { $windowStateVerified = $windowView.windowState -eq "maximized" }
  elseif ($requestedWindowState -eq "restore") { $windowStateVerified = $windowView.windowState -eq "normal" }
  else { $windowStateVerified = $windowView.windowState -ne "minimized" }
}
[ordered]@{ ok = $true; verified = $windowStateVerified; action = $payload.action; requestedWindowState = $requestedWindowState; window = $windowView; element = $(if ($element) { Convert-Element $element } else { $null }) } | ConvertTo-Json -Depth 6 -Compress
`;

function encodePowerShell(script: string, payload: JsonRecord): string {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return Buffer.from(script.replaceAll("__PAYLOAD__", payloadBase64), "utf16le").toString("base64");
}

async function runDesktopPowerShellWithoutIndicator(script: string, payload: JsonRecord): Promise<JsonRecord> {
  if (process.platform !== "win32") throw new Error("Native desktop control currently supports Windows only.");
  let stdout: string;
  try {
    ({ stdout } = await execFilePromise("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script, payload),
    ], { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES }));
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const knownMessages = [
      "Desktop window not found", "Desktop element not found", "Password controls are blocked",
      "No foreground desktop window is available", "Desktop element is disabled", "Desktop element is offscreen",
      "Element has no clickable bounds", "Target element cannot receive focus", "SendInput",
    ];
    const known = knownMessages.find((message) => stderr.includes(message));
    throw new Error(known ? `Desktop helper failed: ${known}.` : "Desktop helper failed safely; input payload was suppressed.");
  }
  const output = stdout.trim();
  if (!output) throw new Error("Desktop helper returned no result.");
  try {
    return JSON.parse(output) as JsonRecord;
  } catch {
    throw new Error("Desktop helper returned an invalid result; raw output was suppressed.");
  }
}

export function runDesktopPowerShell(script: string, payload: JsonRecord): Promise<JsonRecord> {
  return withDesktopControlIndicator(() => runDesktopPowerShellWithoutIndicator(script, payload));
}

export async function observeDesktop(input: { includeElements?: boolean; maxElements?: number } = {}): Promise<JsonRecord> {
  const maxElements = Math.max(1, Math.min(input.maxElements ?? 80, MAX_ELEMENTS));
  return runDesktopPowerShell(OBSERVE_SCRIPT, { includeElements: input.includeElements ?? true, maxElements });
}

export async function focusDesktopWindow(input: { title: string; match?: "exact" | "contains"; state?: "preserve" | "restore" | "maximize" }): Promise<JsonRecord> {
  return runDesktopPowerShell(WINDOW_SCRIPT, { title: input.title, match: input.match ?? "contains", state: input.state ?? "preserve" });
}

function toSendKeys(key: string, modifiers: string[]): string {
  const prefix = `${modifiers.includes("Ctrl") ? "^" : ""}${modifiers.includes("Alt") ? "%" : ""}${modifiers.includes("Shift") ? "+" : ""}`;
  const named: Record<string, string> = { Enter: "{ENTER}", Escape: "{ESC}", Tab: "{TAB}", Backspace: "{BACKSPACE}", Delete: "{DELETE}", ArrowUp: "{UP}", ArrowDown: "{DOWN}", ArrowLeft: "{LEFT}", ArrowRight: "{RIGHT}", Home: "{HOME}", End: "{END}", PageUp: "{PGUP}", PageDown: "{PGDN}" };
  const resolved = named[key] ?? (/^[a-zA-Z0-9]$/.test(key) ? key.toLowerCase() : undefined);
  if (!resolved) throw new Error(`Unsupported desktop key '${key}'.`);
  return `${prefix}${resolved}`;
}

export async function performDesktopAction(input: {
  action: "click" | "set_text" | "type_text" | "press_key" | "scroll" | "coordinate_click";
  windowTitle?: string;
  windowMatch?: "exact" | "contains";
  windowState?: "preserve" | "restore" | "maximize";
  selector?: DesktopSelector;
  text?: string;
  key?: string;
  modifiers?: string[];
  delta?: number;
  x?: number;
  y?: number;
  confirmed?: boolean;
}): Promise<JsonRecord> {
  if ((input.action === "set_text" || input.action === "type_text") && input.text === undefined) throw new Error(`${input.action} requires text.`);
  if (input.action === "type_text" && !input.selector) throw new Error("type_text requires a semantic selector to prevent typing into an unknown or password control.");
  if (input.action === "press_key" && !input.key) throw new Error("press_key requires key.");
  if (input.action === "click" && input.selector?.name && DESTRUCTIVE_CONTROL_NAME.test(input.selector.name) && !input.confirmed) {
    throw new Error("Clicking a potentially destructive control requires confirmed=true.");
  }
  if (input.action === "coordinate_click" && !input.confirmed) throw new Error("coordinate_click requires confirmed=true because coordinate actions are not semantic.");
  if (input.action === "coordinate_click" && (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x! < 0 || input.y! < 0)) throw new Error("coordinate_click requires non-negative x and y.");
  const payload: JsonRecord = { ...input };
  if (input.action === "press_key") payload.sendKeys = toSendKeys(input.key!, input.modifiers ?? []);
  if (input.action === "scroll") payload.delta = Math.max(-1200, Math.min(input.delta ?? -360, 1200));
  return runDesktopPowerShell(ACTION_SCRIPT, payload);
}

const selectorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  automationId: z.string().min(1).max(200).optional(),
  controlType: z.string().min(1).max(80).optional(),
  match: z.enum(["exact", "contains"]).optional().default("exact"),
}).refine((value) => Boolean(value.name || value.automationId || value.controlType), "Selector requires name, automationId, or controlType.");

export function registerWindowsDesktopTools(server: McpServer): void {
  server.registerTool("desktop_observe", {
    description: "Observe the interactive Windows desktop: list top-level windows, inspect a bounded UI Automation tree for the foreground window, and optionally return a screenshot. Password values are never returned.",
    inputSchema: z.object({ includeElements: z.boolean().optional().default(true), maxElements: z.number().int().min(1).max(MAX_ELEMENTS).optional().default(80), screenshot: z.boolean().optional().default(true) }),
  }, async ({ includeElements, maxElements, screenshot }) => {
    const result = await observeDesktop({ includeElements, maxElements });
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: JSON.stringify(result, null, 2) }];
    if (screenshot) {
      const filePath = await captureWindowsScreen();
      const data = (await fs.readFile(filePath)).toString("base64");
      (result as JsonRecord).screenshotPath = filePath;
      content[0] = { type: "text", text: JSON.stringify(result, null, 2) };
      content.push({ type: "image", data, mimeType: "image/png" });
    }
    return { content };
  });

  server.registerTool("desktop_window", {
    description: "Focus an existing interactive Windows desktop window by title without shrinking a maximized window. By default it preserves window state and only restores minimized windows. For UI/layout review use state=maximize. Does not launch, close, or terminate applications.",
    inputSchema: z.object({ title: z.string().min(1).max(200), match: z.enum(["exact", "contains"]).optional().default("contains"), state: z.enum(["preserve", "restore", "maximize"]).optional().default("preserve") }),
  }, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await focusDesktopWindow(args), null, 2) }] }));

  server.registerTool("desktop_action", {
    description: "Perform one guarded action in the interactive Windows session. Window state is preserved by default, so actions no longer shrink maximized apps; for UI/layout tasks use windowState=maximize. Prefer semantic UI Automation selectors. Password controls are blocked; raw coordinate clicks require confirmed=true.",
    inputSchema: z.object({
      action: z.enum(["click", "set_text", "type_text", "press_key", "scroll", "coordinate_click"]),
      windowTitle: z.string().min(1).max(200).optional(), windowMatch: z.enum(["exact", "contains"]).optional().default("contains"),
      windowState: z.enum(["preserve", "restore", "maximize"]).optional().default("preserve"),
      selector: selectorSchema.optional(), text: z.string().max(4000).optional(),
      key: z.string().max(20).optional(), modifiers: z.array(z.enum(["Ctrl", "Alt", "Shift"])).max(3).optional().default([]),
      delta: z.number().int().min(-1200).max(1200).optional(), x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(),
      confirmed: z.boolean().optional().default(false),
    }),
  }, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await performDesktopAction(args), null, 2) }] }));
}

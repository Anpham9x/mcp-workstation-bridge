import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function isCdpUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Chrome DevTools endpoint|DevTools websocket|ECONNREFUSED/i.test(message);
}

export async function navigateExistingChromeWithWindowsUi(
  url: string,
  newTab: boolean,
): Promise<Record<string, unknown>> {
  if (process.platform !== "win32") {
    throw new Error("Windows-UI Chrome fallback is available on Windows only.");
  }

  const urlBase64 = Buffer.from(url, "utf8").toString("base64");
  const openTabCommand = newTab
    ? '[System.Windows.Forms.SendKeys]::SendWait("^t"); Start-Sleep -Milliseconds 120'
    : "";

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class McpChromeUiNative {",
    "  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }",
    "  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsZoomed(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);",
    "  public static void TypeUnicode(string value) {",
    "    foreach (char ch in value) {",
    "      var inputs = new INPUT[2];",
    "      inputs[0].type = 1; inputs[0].U.ki.wScan = ch; inputs[0].U.ki.dwFlags = 0x0004;",
    "      inputs[1].type = 1; inputs[1].U.ki.wScan = ch; inputs[1].U.ki.dwFlags = 0x0004 | 0x0002;",
    "      if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException(\"SendInput text failed.\");",
    "    }",
    "  }",
    "}",
    "'@",
    "$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + urlBase64 + "'))",
    "$currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId",
    "$foreground = [McpChromeUiNative]::GetForegroundWindow()",
    "$candidates = @(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $currentSessionId -and $_.MainWindowHandle -ne 0 })",
    "if ($candidates.Count -eq 0) { throw 'No visible Chrome window is available in the MCP Windows session.' }",
    "$chrome = $candidates | Where-Object { [IntPtr]$_.MainWindowHandle -eq $foreground } | Select-Object -First 1",
    "if (-not $chrome) { $chrome = $candidates | Select-Object -First 1 }",
    "$handle = [IntPtr]$chrome.MainWindowHandle",
    "if ([McpChromeUiNative]::IsIconic($handle)) { [McpChromeUiNative]::ShowWindow($handle, 9) | Out-Null }",
    "$element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)",
    "try { $element.SetFocus() } catch {}",
    "[McpChromeUiNative]::SetForegroundWindow($handle) | Out-Null",
    "Start-Sleep -Milliseconds 200",
    "if ([McpChromeUiNative]::GetForegroundWindow() -ne $handle) { throw 'Chrome window could not be focused safely.' }",
    openTabCommand,
    "[System.Windows.Forms.SendKeys]::SendWait(\"^l\")",
    "Start-Sleep -Milliseconds 80",
    "[McpChromeUiNative]::TypeUnicode($url)",
    "[System.Windows.Forms.SendKeys]::SendWait(\"{ENTER}\")",
    "Start-Sleep -Milliseconds 150",
    "[ordered]@{ ok = $true; mode = 'windows-ui'; processId = $chrome.Id; url = $url } | ConvertTo-Json -Compress",
  ].filter(Boolean).join("\r\n");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script),
    ], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
    });

    const output = stdout.trim();
    if (!output) {
      throw new Error("Chrome Windows-UI helper returned no result.");
    }
    return JSON.parse(output) as Record<string, unknown>;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const known = [
      "No visible Chrome window is available in the MCP Windows session.",
      "Chrome window could not be focused safely.",
      "SendInput text failed.",
    ].find((message) => stderr.includes(message));
    throw new Error(known ?? "Chrome Windows-UI fallback failed safely.");
  }
}

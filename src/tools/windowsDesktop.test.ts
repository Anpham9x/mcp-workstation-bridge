import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { focusDesktopWindow, observeDesktop, performDesktopAction, runDesktopPowerShell } from "./windowsDesktop.js";

async function expectRejects(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, pattern);
}

async function waitFor<T>(callback: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await callback();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for desktop E2E condition.");
}

async function runValidationTests(): Promise<void> {
  await expectRejects(
    () => performDesktopAction({ action: "coordinate_click", x: 1, y: 1 }),
    /confirmed=true/,
  );
  await expectRejects(
    () => performDesktopAction({ action: "press_key", key: "UnsupportedKey" }),
    /Unsupported desktop key/,
  );
  await expectRejects(
    () => performDesktopAction({ action: "set_text" }),
    /requires text/,
  );
  await expectRejects(
    () => performDesktopAction({ action: "type_text", text: "blocked" }),
    /semantic selector/,
  );
  await expectRejects(
    () => performDesktopAction({ action: "click", selector: { name: "Delete account" } }),
    /confirmed=true/,
  );
  if (process.platform === "win32") {
    let safeError = "";
    try { await runDesktopPowerShell("throw 'intentional test failure'", { text: "TOP_SECRET_DESKTOP_PAYLOAD" }); }
    catch (error) { safeError = String(error); }
    assert.match(safeError, /payload was suppressed/);
    assert.doesNotMatch(safeError, /TOP_SECRET_DESKTOP_PAYLOAD/);
  }
  console.log("Desktop validation tests passed.");
}

async function runNotepadE2E(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Desktop E2E requires Windows.");
  const workspaceRoot = path.resolve(process.cwd());
  const tempDir = path.resolve(workspaceRoot, ".bridge_tmp", "desktop-e2e");
  if (!tempDir.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error("Desktop E2E temp directory escaped the workspace.");
  const filePath = path.join(tempDir, `notepad-${Date.now()}.txt`);
  const expectedText = `MCP desktop E2E ${Date.now()}`;
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(filePath, "", "utf8");

  let child: ChildProcess | undefined;
  let ownedWindowPid: number | undefined;
  try {
    child = spawn("notepad.exe", [filePath], { stdio: "ignore", windowsHide: false });
    const fileName = path.basename(filePath);
    const focused = await waitFor(() => focusDesktopWindow({ title: fileName, match: "contains", state: "maximize" }));
    assert.equal(focused.windowState, "maximized", "Expected explicit UI-review focus to maximize the target window.");
    assert.equal(focused.verified, true, "Expected maximized window state to be verified.");

    const before = await observeDesktop({ includeElements: true, maxElements: 160 });
    assert.ok(Array.isArray(before.windows) && before.windows.length > 0, "Expected visible desktop windows.");
    assert.ok(Array.isArray(before.elements), "Expected a bounded UI Automation element list.");
    const ownedWindow = (before.windows as Array<Record<string, unknown>>).find((window) => String(window.name).includes(fileName));
    ownedWindowPid = typeof ownedWindow?.processId === "number" ? ownedWindow.processId : undefined;
    assert.ok(ownedWindowPid, "Expected the test-owned Notepad window process id.");

    await performDesktopAction({
      action: "type_text",
      windowTitle: fileName,
      selector: { controlType: "Document", match: "exact" },
      text: expectedText,
    });
    await performDesktopAction({ action: "press_key", windowTitle: fileName, key: "s", modifiers: ["Ctrl"] });

    const afterAction = await observeDesktop({ includeElements: false, maxElements: 20 });
    const preservedWindow = (afterAction.windows as Array<Record<string, unknown>>).find((window) => String(window.name).includes(fileName));
    assert.equal(preservedWindow?.windowState, "maximized", "Expected desktop actions to preserve a maximized target window.");

    await waitFor(async () => (await fs.readFile(filePath, "utf8")) === expectedText ? true : undefined);
    console.log(JSON.stringify({ ok: true, app: "Notepad", filePath, expectedTextLength: expectedText.length }, null, 2));
  } finally {
    if (child?.pid && child.exitCode === null) child.kill();
    if (ownedWindowPid && ownedWindowPid !== child?.pid) {
      try { process.kill(ownedWindowPid); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

await runValidationTests();
if (process.argv.includes("--e2e")) await runNotepadE2E();

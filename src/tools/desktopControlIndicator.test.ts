import assert from "node:assert/strict";
import {
  createDesktopControlIndicatorController,
  DESKTOP_INDICATOR_IDLE_TIMEOUT_MS,
  DESKTOP_INDICATOR_HEARTBEAT_STALE_MS,
  DESKTOP_INDICATOR_WATCHDOG_INTERVAL_MS,
  DESKTOP_SCREEN_CONTROL_HOLD_MS,
  instrumentMcpServerToolActivity,
  type DesktopIndicatorController,
  type DesktopIndicatorDriver,
} from "./desktopControlIndicator.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests(): Promise<void> {
  assert.equal(DESKTOP_INDICATOR_IDLE_TIMEOUT_MS, 120_000, "The production inactivity timeout must be 120 seconds.");
  assert.equal(DESKTOP_SCREEN_CONTROL_HOLD_MS, 120_000, "The production screen-control warning must remain green for 120 seconds.");
  assert.equal(DESKTOP_INDICATOR_WATCHDOG_INTERVAL_MS, 5_000, "The overlay watchdog must check every 5 seconds.");
  assert.equal(DESKTOP_INDICATOR_HEARTBEAT_STALE_MS, 15_000, "A non-updating overlay heartbeat must be treated as stale after 15 seconds.");

  const calls: string[] = [];
  let lastOnlineOnly = false;
  const driver: DesktopIndicatorDriver = {
    async show() { calls.push("show"); },
    async update(state) { lastOnlineOnly = state.onlineOnly; },
    async hide() { calls.push("hide"); },
  };
  const controller = createDesktopControlIndicatorController(driver, 10);

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = controller.run(async () => { await firstGate; return "first"; });
  await wait(0);
  const second = controller.run(async () => "second");
  assert.deepEqual(calls, ["show"], "Overlapping desktop operations must share one visible badge.");
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(calls, ["show"], "The badge must remain visible during the idle waiting window.");
  await wait(25);
  assert.equal(calls.includes("hide"), true, "The badge must hide after the idle waiting window.");
  assert.equal(lastOnlineOnly, false, "The persistent Bridge Online state must remain disabled.");

  const resetCalls: string[] = [];
  let resetOnlineOnly = false;
  const resetController = createDesktopControlIndicatorController({
    async show() { resetCalls.push("show"); },
    async update(state) { resetOnlineOnly = state.onlineOnly; },
    async hide() { resetCalls.push("hide"); },
  }, 20);
  await resetController.run(async () => undefined);
  await wait(12);
  await resetController.run(async () => undefined);
  await wait(12);
  assert.equal(resetCalls.includes("hide"), false, "A new tool call must reset the idle waiting window.");
  await wait(15);
  assert.equal(resetCalls.includes("hide"), true, "The reset idle timer must hide the badge after inactivity.");
  assert.equal(resetOnlineOnly, false, "The persistent Bridge Online state must stay disabled.");

  const lifecycleCalls: string[] = [];
  const lifecycleController = createDesktopControlIndicatorController({
    async show(state) { lifecycleCalls.push(`show:${state.onlineOnly}`); },
    async update(state) { lifecycleCalls.push(`update:${state.onlineOnly}`); },
    async hide() { lifecycleCalls.push("hide"); },
  }, 5);
  await lifecycleController.ensureOnline();
  assert.equal(lifecycleCalls.length, 0, "Runtime startup must not show a persistent Bridge Online badge.");
  await lifecycleController.run(async () => "active");
  assert.ok(lifecycleCalls.includes("update:false"), "Tool activity must show an active badge.");
  await wait(10);
  assert.equal(lifecycleCalls.at(-1), "hide", "After inactivity the badge must disappear.");

  let operationRan = false;
  const failOpenController = createDesktopControlIndicatorController({
    async show() { throw new Error("simulated display failure"); },
    async update() {},
    async hide() {},
  }, 0);
  const result = await failOpenController.run(async () => { operationRan = true; return 42; });
  assert.equal(result, 42);
  assert.equal(operationRan, true, "A badge failure must not block an otherwise safe desktop operation.");

  const countStates: string[] = [];
  let releaseShow!: () => void;
  let releaseOperations!: () => void;
  const showGate = new Promise<void>((resolve) => { releaseShow = resolve; });
  const operationsGate = new Promise<void>((resolve) => { releaseOperations = resolve; });
  const countController = createDesktopControlIndicatorController({
    async show(state) {
      countStates.push(`show:${state.active}:${state.waiting}:${state.screenControl}:${state.onlineOnly}`);
      await showGate;
    },
    async update(state) { countStates.push(`update:${state.active}:${state.waiting}:${state.screenControl}:${state.onlineOnly}`); },
    async hide() { countStates.push("hide"); },
  }, 10);
  const countedFirst = countController.run(async () => { await operationsGate; });
  await wait(0);
  const countedSecond = countController.run(async () => { await operationsGate; });
  await wait(0);
  assert.ok(countStates.includes("update:0:2:0:false"), "A received call must be counted as waiting until execution begins.");
  releaseShow();
  await wait(0);
  assert.ok(countStates.includes("update:2:0:0:false"), "Both callbacks must be counted as active while executing concurrently.");
  releaseOperations();
  await Promise.all([countedFirst, countedSecond]);
  assert.equal(countStates.at(-1), "update:0:0:0:false", "A zero/zero state must switch the badge to idle waiting text.");
  await wait(25);
  assert.equal(countStates.at(-1), "hide", "The idle waiting badge must hide after its timeout.");

  const screenStates: string[] = [];
  const screenController = createDesktopControlIndicatorController({
    async show(state) { screenStates.push(`show:${state.screenControl}`); },
    async update(state) { screenStates.push(`update:${state.active}:${state.screenControl}`); },
    async hide() {},
  }, 1_000, 10);
  await screenController.run(async () => undefined, "screen-control");
  assert.ok(screenStates.includes("update:1:1"), "A desktop-control operation must activate the dedicated green screen state.");
  assert.equal(screenStates.at(-1), "update:0:1", "The green warning must remain active after desktop control finishes.");
  await wait(25);
  assert.equal(screenStates.at(-1), "update:0:0", "The green warning must clear after its dedicated hold interval.");

  const registrations = new Map<string, (...args: unknown[]) => unknown>();
  const fakeServer = {
    registerTool(name: string, _config: unknown, callback: (...args: unknown[]) => unknown) {
      registrations.set(name, callback);
      return {};
    },
  } as unknown as McpServer;
  const globalCalls: string[] = [];
  const globalController: DesktopIndicatorController = {
    async ensureOnline(): Promise<void> {},
    async run<T>(operation: () => Promise<T>): Promise<T> {
      globalCalls.push("run");
      return operation();
    },
  };
  instrumentMcpServerToolActivity(fakeServer, globalController);
  instrumentMcpServerToolActivity(fakeServer, globalController);
  const registerSample = fakeServer.registerTool as unknown as (
    name: string,
    config: unknown,
    callback: (...args: unknown[]) => unknown
  ) => unknown;
  registerSample("sample", {}, async (value: unknown) => String(value).toUpperCase());
  const registeredCallback = registrations.get("sample");
  assert.ok(registeredCallback, "Instrumented registration must preserve the tool callback.");
  assert.equal(await registeredCallback("ok"), "OK");
  assert.deepEqual(globalCalls, ["run"], "Every tool callback must be wrapped exactly once.");

  console.log("Desktop control indicator tests passed.");
}

await runTests();

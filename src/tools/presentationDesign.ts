import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { focusDesktopWindow } from "./windowsDesktop.js";
import {
  checkForbiddenFile,
  isIgnoredPath,
  redactSensitiveData,
  resolveAndValidatePath,
} from "../security/index.js";

const execFilePromise = promisify(execFile);
const AUTOMATION_SCRIPT = fileURLToPath(new URL("../../scripts/pptx-automation.ps1", import.meta.url));
const POWERPOINT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DECK_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".svg", ".emf", ".wmf"]);
const ONLYOFFICE_EXECUTABLE_CANDIDATES = [
  "C:\\Program Files\\ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe",
  "C:\\Program Files (x86)\\ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe",
  ...(process.env.LOCALAPPDATA
    ? [path.join(process.env.LOCALAPPDATA, "ONLYOFFICE", "DesktopEditors", "DesktopEditors.exe")]
    : []),
];

const boxSchema = {
  x: z.number().min(-20).max(40),
  y: z.number().min(-20).max(30),
  width: z.number().positive().max(40),
  height: z.number().positive().max(30),
};

const textElementSchema = z.object({
  type: z.literal("text"),
  ...boxSchema,
  text: z.string().max(20_000),
  name: z.string().max(120).optional(),
  fontFamily: z.string().max(120).optional(),
  fontSize: z.number().min(6).max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right", "justify"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  margin: z.number().min(0).max(1).optional(),
  rotation: z.number().min(-360).max(360).optional(),
  transparency: z.number().min(0).max(1).optional(),
  autoFit: z.boolean().optional(),
});

const shapeElementSchema = z.object({
  type: z.literal("shape"),
  ...boxSchema,
  shape: z.enum(["rectangle", "roundedRectangle", "ellipse", "triangle", "chevron", "pentagon", "hexagon", "line"]),
  name: z.string().max(120).optional(),
  fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fillTransparency: z.number().min(0).max(1).optional(),
  lineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  lineWidth: z.number().min(0).max(20).optional(),
  dash: z.enum(["solid", "dash", "dot"]).optional(),
  startArrow: z.enum(["none", "triangle", "stealth", "diamond", "oval"]).optional(),
  endArrow: z.enum(["none", "triangle", "stealth", "diamond", "oval"]).optional(),
  rotation: z.number().min(-360).max(360).optional(),
});

const imageElementSchema = z.object({
  type: z.literal("image"),
  ...boxSchema,
  path: z.string().min(1).max(2_000),
  name: z.string().max(120).optional(),
  fit: z.enum(["stretch", "contain"]).optional(),
  rotation: z.number().min(-360).max(360).optional(),
});

const tableElementSchema = z.object({
  type: z.literal("table"),
  ...boxSchema,
  rows: z.array(z.array(z.string().max(4_000)).min(1).max(20)).min(1).max(50),
  name: z.string().max(120).optional(),
  fontFamily: z.string().max(120).optional(),
  fontSize: z.number().min(6).max(80).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  headerFillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  headerColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bodyFillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  borderColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});

const deckSchema = z.object({
  width: z.number().min(5).max(40).optional(),
  height: z.number().min(4).max(30).optional(),
  theme: z.object({
    fontFamily: z.string().max(120).optional(),
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).optional(),
  slides: z.array(z.object({
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    notes: z.string().max(30_000).optional(),
    elements: z.array(z.discriminatedUnion("type", [
      textElementSchema,
      shapeElementSchema,
      imageElementSchema,
      tableElementSchema,
    ])).max(100),
  })).min(1).max(100),
});

export const presentationDesignInputSchema = z.object({
  action: z.enum(["build", "inspect", "render", "open"]),
  workspacePath: z.string().min(1).max(2_000),
  presentationPath: z.string().min(1).max(2_000),
  overwrite: z.boolean().optional().default(false),
  deck: deckSchema.optional(),
  slideNumber: z.number().int().positive().max(100).optional(),
  renderWidth: z.number().int().min(640).max(2560).optional().default(1600),
});

type PresentationDesignInput = z.infer<typeof presentationDesignInputSchema>;
type DeckSpec = z.infer<typeof deckSchema>;
type JsonRecord = Record<string, unknown>;

async function resolveExistingDirectory(candidatePath: string): Promise<string> {
  const resolved = resolveAndValidatePath(candidatePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("workspacePath must be an existing directory.");
  const real = await fs.realpath(resolved);
  resolveAndValidatePath(real);
  return real;
}

async function resolvePresentationPath(workspacePath: string, candidatePath: string, mustExist: boolean): Promise<string> {
  const requested = path.isAbsolute(candidatePath) ? candidatePath : path.join(workspacePath, candidatePath);
  const resolved = resolveAndValidatePath(requested, [workspacePath]);
  if (path.extname(resolved).toLowerCase() !== ".pptx") throw new Error("presentationPath must end with .pptx.");
  if (checkForbiddenFile(resolved) || isIgnoredPath(resolved)) throw new Error("presentationPath is blocked by workspace policy.");

  if (mustExist) {
    const real = await fs.realpath(resolved);
    resolveAndValidatePath(real, [workspacePath]);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error("presentationPath must reference an existing file.");
    return real;
  }

  const parent = path.dirname(resolved);
  const realParent = await fs.realpath(parent);
  resolveAndValidatePath(realParent, [workspacePath]);
  if (path.resolve(parent).toLowerCase() !== path.resolve(realParent).toLowerCase()) {
    throw new Error("presentationPath parent must not be a symbolic link or junction.");
  }
  try {
    const existing = await fs.lstat(resolved);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Existing presentationPath must be a regular file, not a link or directory.");
    }
    const realExisting = await fs.realpath(resolved);
    resolveAndValidatePath(realExisting, [workspacePath]);
    if (path.resolve(realExisting).toLowerCase() !== path.resolve(resolved).toLowerCase()) {
      throw new Error("Existing presentationPath must not resolve through a link or junction.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path.join(realParent, path.basename(resolved));
}

async function validateAssetPath(workspacePath: string, candidatePath: string): Promise<string> {
  const requested = path.isAbsolute(candidatePath) ? candidatePath : path.join(workspacePath, candidatePath);
  const resolved = resolveAndValidatePath(requested, [workspacePath]);
  if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error(`Unsupported presentation image: ${path.basename(resolved)}`);
  if (checkForbiddenFile(resolved) || isIgnoredPath(resolved)) throw new Error(`Blocked presentation image: ${path.basename(resolved)}`);
  const real = await fs.realpath(resolved);
  resolveAndValidatePath(real, [workspacePath]);
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error(`Presentation image is missing or exceeds ${MAX_ASSET_BYTES} bytes.`);
  return real;
}

async function normalizeDeckAssets(workspacePath: string, deck: DeckSpec): Promise<DeckSpec> {
  const copy = structuredClone(deck);
  for (const slide of copy.slides) {
    for (const element of slide.elements) {
      if (element.type === "image") element.path = await validateAssetPath(workspacePath, element.path);
    }
  }
  return copy;
}

async function findOnlyOfficeExecutable(): Promise<string> {
  for (const candidate of ONLYOFFICE_EXECUTABLE_CANDIDATES) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Continue through fixed install locations only.
    }
  }
  throw new Error("ONLYOFFICE Desktop Editors is not installed in a supported location.");
}

async function tryFocusOpenPresentation(presentationPath: string): Promise<JsonRecord | undefined> {
  try {
    return await focusDesktopWindow({
      title: path.basename(presentationPath),
      match: "contains",
      state: "maximize",
    });
  } catch {
    return undefined;
  }
}

async function openPresentationInOnlyOffice(presentationPath: string): Promise<JsonRecord> {
  const existingWindow = await tryFocusOpenPresentation(presentationPath);
  if (existingWindow) {
    return {
      ok: true,
      action: "open",
      application: "ONLYOFFICE Desktop Editors",
      presentationPath,
      reviewMode: "onlyoffice-live",
      reusedExistingWindow: true,
      focused: true,
      window: existingWindow,
    };
  }

  const executablePath = await findOnlyOfficeExecutable();
  const child = spawn(executablePath, [presentationPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();

  let focusedWindow: JsonRecord | undefined;
  for (let attempt = 0; attempt < 8 && !focusedWindow; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    focusedWindow = await tryFocusOpenPresentation(presentationPath);
  }

  return {
    ok: true,
    action: "open",
    application: "ONLYOFFICE Desktop Editors",
    presentationPath,
    processId: child.pid,
    reviewMode: "onlyoffice-live",
    reusedExistingWindow: false,
    focused: Boolean(focusedWindow),
    ...(focusedWindow ? { window: focusedWindow } : {}),
  };
}

async function invokePowerPoint(payload: JsonRecord, workspacePath: string): Promise<{ result: JsonRecord; renderPath?: string }> {
  const tempRoot = path.join(workspacePath, ".bridge_tmp", "presentation-design", randomUUID());
  await fs.mkdir(tempRoot, { recursive: true });
  const requestPath = path.join(tempRoot, "request.json");
  const renderPath = path.join(tempRoot, "slide.png");
  await fs.writeFile(requestPath, JSON.stringify({ ...payload, renderPath }), "utf8");

  let succeeded = false;
  try {
    const { stdout } = await execFilePromise("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", AUTOMATION_SCRIPT, "-RequestPath", requestPath,
    ], { timeout: POWERPOINT_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" });
    const output = stdout.trim();
    if (!output) throw new Error("PowerPoint automation returned no result.");
    const result = JSON.parse(output) as JsonRecord;
    if (result.ok !== true) throw new Error(String(result.error || "PowerPoint automation failed."));
    succeeded = true;
    return { result, renderPath: payload.action === "render" ? renderPath : undefined };
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string };
    let message = processError.message || String(error);
    if (processError.stdout?.trim()) {
      try {
        const parsed = JSON.parse(processError.stdout.trim()) as JsonRecord;
        message = `${String(parsed.error || message)}${parsed.line ? ` (automation line ${parsed.line})` : ""}`;
      } catch {
        message = processError.stdout.trim();
      }
    } else if (processError.stderr?.trim()) {
      message = processError.stderr.trim();
    }
    throw new Error(redactSensitiveData(message));
  } finally {
    if (payload.action !== "render" || !succeeded) await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function executePresentationDesign(input: PresentationDesignInput): Promise<{
  result: JsonRecord;
  imageData?: string;
}> {
  const parsed = presentationDesignInputSchema.parse(input);
  const workspacePath = await resolveExistingDirectory(parsed.workspacePath);
  const mustExist = parsed.action !== "build";
  const presentationPath = await resolvePresentationPath(workspacePath, parsed.presentationPath, mustExist);

  if (parsed.action === "open") {
    return { result: await openPresentationInOnlyOffice(presentationPath) };
  }

  if (parsed.action === "build") {
    if (!parsed.deck) throw new Error("deck is required for action=build.");
    if (!parsed.overwrite) {
      try {
        await fs.access(presentationPath);
        throw new Error("Presentation already exists; set overwrite=true to replace it.");
      } catch (error) {
        if (error instanceof Error && !/ENOENT/.test(error.message)) throw error;
      }
    }
    const deck = await normalizeDeckAssets(workspacePath, parsed.deck);
    const serialized = JSON.stringify(deck);
    if (Buffer.byteLength(serialized, "utf8") > MAX_DECK_BYTES) throw new Error(`Deck specification exceeds ${MAX_DECK_BYTES} bytes.`);
    const { result } = await invokePowerPoint({ action: "build", presentationPath, overwrite: parsed.overwrite, deck }, workspacePath);
    return { result };
  }

  if (parsed.action === "inspect") {
    const { result } = await invokePowerPoint({ action: "inspect", presentationPath }, workspacePath);
    return { result };
  }

  if (!parsed.slideNumber) throw new Error("slideNumber is required for action=render.");
  const invocation = await invokePowerPoint({
    action: "render",
    presentationPath,
    slideNumber: parsed.slideNumber,
    renderWidth: parsed.renderWidth,
  }, workspacePath);
  if (!invocation.renderPath) throw new Error("PowerPoint render path was not returned.");
  try {
    const imageData = await fs.readFile(invocation.renderPath, { encoding: "base64" });
    return { result: invocation.result, imageData };
  } finally {
    await fs.rm(path.dirname(invocation.renderPath), { recursive: true, force: true });
  }
}

export function registerPresentationDesignTool(server: McpServer): void {
  server.registerTool(
    "presentation_design",
    {
      description: "Build a structured PowerPoint deck or open it in ONLYOFFICE Desktop Editors for the default live review/edit loop. action=open reuses and focuses the existing deck window when possible; pair it with desktop_observe/desktop_action for iterative visual edits. inspect is for geometry/text checks and render is a fallback for pixel-level QA, not the default review path. Paths must stay inside approved workspaces; no arbitrary scripts or executable paths are accepted.",
      inputSchema: presentationDesignInputSchema,
    },
    async (input) => {
      try {
        const output = await executePresentationDesign(input);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }> = [
          { type: "text", text: JSON.stringify(output.result, null, 2) },
        ];
        if (output.imageData) content.push({ type: "image", data: output.imageData, mimeType: "image/png" });
        return { content };
      } catch (error) {
        const message = redactSensitiveData(error instanceof Error ? error.message : String(error));
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }] };
      }
    },
  );
}

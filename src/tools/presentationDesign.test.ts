import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHealthTool } from "./health.js";
import { executePresentationDesign, presentationDesignInputSchema } from "./presentationDesign.js";

const workspacePath = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function testSchemaAndCatalog(): void {
  const parsed = presentationDesignInputSchema.parse({
    action: "inspect",
    workspacePath,
    presentationPath: "example.pptx",
  });
  assert.equal(parsed.renderWidth, 1600);
  assert.equal(presentationDesignInputSchema.parse({ action: "open", workspacePath, presentationPath: "example.pptx" }).action, "open");

  assert.throws(() => presentationDesignInputSchema.parse({
    action: "build",
    workspacePath,
    presentationPath: "unsafe.pptx",
    deck: { slides: [{ elements: [{ type: "text", x: 0, y: 0, width: 1, height: 1, text: "x", color: "red" }] }] },
  }), /invalid|regex/i);

  const names: string[] = [];
  const descriptions = new Map<string, string>();
  const requestHandlers = new Map<string, Function>([["tools/list", async () => ({ tools: [] })]]);
  const protocol = {
    _requestHandlers: requestHandlers,
    removeRequestHandler: (name: string) => { requestHandlers.delete(name); },
    setRequestHandler: (_schema: unknown, handler: Function) => { requestHandlers.set("tools/list", handler); },
  };
  const mockServer = {
    registerTool: (name: string, config?: { description?: string }) => {
      names.push(name);
      if (config?.description) descriptions.set(name, config.description);
    },
    server: protocol,
  } as never;
  registerHealthTool(mockServer, { includePowerShell: true, compactCatalog: true, profileSubject: "test-subject" });
  assert.equal(names.length, 50);
  assert(!names.includes("presentation_design"));
  assert(!names.includes("project_bootstrap"));
  assert(names.includes("filesystem_manage"));
  assert(!names.includes("open_browser"));
  assert(names.includes("open_url"));
}

async function testPathPolicy(): Promise<void> {
  await assert.rejects(executePresentationDesign({
    action: "inspect",
    workspacePath,
    presentationPath: "C:\\Windows\\outside.pptx",
    overwrite: false,
    renderWidth: 1600,
  }), /outside configured workspace roots/i);

  await assert.rejects(executePresentationDesign({
    action: "build",
    workspacePath,
    presentationPath: "unsafe.exe",
    overwrite: false,
    renderWidth: 1600,
    deck: { slides: [{ elements: [] }] },
  }), /must end with \.pptx/i);
}

async function testPowerPointRoundTrip(): Promise<void> {
  const outputPath = path.join(workspacePath, `presentation-design-e2e-${process.pid}.pptx`);
  const previewPath = path.join(workspacePath, `presentation-design-e2e-${process.pid}.png`);
  const keepArtifacts = process.env.MCP_PPTX_E2E_KEEP === "1";
  try {
    const build = await executePresentationDesign({
      action: "build",
      workspacePath,
      presentationPath: outputPath,
      overwrite: true,
      renderWidth: 1600,
      deck: {
        width: 13.333333,
        height: 7.5,
        theme: { fontFamily: "Aptos", textColor: "#172033", backgroundColor: "#F6F4EE" },
        slides: [
          {
            notes: "[Sources]\n- Integration-test fixture generated locally.",
            elements: [
              { type: "shape", shape: "rectangle", x: 0, y: 0, width: 0.25, height: 7.5, fillColor: "#F05A28", lineWidth: 0 },
              { type: "text", name: "Title", x: 0.8, y: 0.7, width: 11.6, height: 1.2, text: "Presentation Design E2E", fontSize: 40, bold: true },
              { type: "text", name: "Subtitle", x: 0.82, y: 2.1, width: 8.5, height: 0.7, text: "Structured JSON → native PowerPoint", fontSize: 22, color: "#526078" },
              { type: "shape", name: "Accent", shape: "roundedRectangle", x: 0.82, y: 3.1, width: 3.2, height: 0.18, fillColor: "#F05A28", lineWidth: 0 },
            ],
          },
          {
            elements: [
              { type: "text", x: 0.8, y: 0.45, width: 11.5, height: 0.7, text: "Native table and geometry inspection", fontSize: 30, bold: true },
              { type: "table", x: 0.8, y: 1.5, width: 11.7, height: 4.5, rows: [["Capability", "Status"], ["Build", "Ready"], ["Inspect", "Ready"], ["Render", "Ready"]], fontSize: 18, headerFillColor: "#172033" },
            ],
          },
        ],
      },
    });
    assert.equal(build.result.slideCount, 2);

    const inspect = await executePresentationDesign({
      action: "inspect", workspacePath, presentationPath: outputPath, overwrite: false, renderWidth: 1600,
    });
    assert.equal(inspect.result.slideCount, 2);
    const slides = inspect.result.slides as Array<{ shapes: Array<{ text: string; overflow: boolean }> }>;
    assert(slides[0].shapes.some((shape) => shape.text.includes("Presentation Design E2E")));
    assert(!slides.flatMap((slide) => slide.shapes).some((shape) => shape.overflow));

    const render = await executePresentationDesign({
      action: "render", workspacePath, presentationPath: outputPath, slideNumber: 1, overwrite: false, renderWidth: 1280,
    });
    assert(render.imageData && render.imageData.length > 10_000);
    assert.equal(render.result.width, 1280);
    if (keepArtifacts && render.imageData) {
      await fs.writeFile(previewPath, Buffer.from(render.imageData, "base64"));
      console.log(JSON.stringify({ outputPath, previewPath }));
    }
  } finally {
    if (!keepArtifacts) {
      await fs.rm(outputPath, { force: true });
      await fs.rm(previewPath, { force: true });
    }
  }
}

testSchemaAndCatalog();
await testPathPolicy();
if (process.argv.includes("--e2e")) await testPowerPointRoundTrip();
console.log(`presentationDesign tests passed${process.argv.includes("--e2e") ? " (including PowerPoint E2E)" : ""}.`);

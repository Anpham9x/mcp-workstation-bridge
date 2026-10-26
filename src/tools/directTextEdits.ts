import { contextFields, getToolContext } from '../reliability/policy.js';
import { managedTextEdit } from '../reliability/textEdits.js';
import { hasOwnerAccess } from '../security/ownerAccess.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOWED_WORKSPACE_ROOTS,
  validatePathForTextWrite,
  validatePathForRead,
  isBinaryBuffer,
  redactSensitiveData
} from "../security/index.js";

/**
 * Recursively checks all path components from the resolvedPath up to the drive root.
 * Ensures no path component is a symbolic link to prevent traversal outside allowed roots.
 */
async function checkSymlinksInResolvedPath(resolvedPath: string): Promise<void> {
  let current = resolvedPath;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Security violation: Path segment '${current}' is a symbolic link.`);
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break; // Reached drive root
    }
    current = parent;
  }
}

/**
 * Registers the append_to_file tool with the MCP server.
 */
export function registerAppendToFileTool(server: McpServer): void {
  server.registerTool(
    "append_to_file",
    {
      description: "Appends UTF-8 text to an existing or optionally created text file safely.",
      inputSchema: z.object({
        ...contextFields,
        filePath: z.string().describe("Absolute path to the text file"),
        text: z.string().describe("UTF-8 text content to append"),
        createIfMissing: z.boolean().optional().default(false).describe("Create the file if it does not exist (default: false)"),
        dryRun: z.boolean().optional().default(false).describe("If true, only validate paths and check eligibility without appending (default: false)")
      }),
    },
    async ({ filePath, text, createIfMissing = false, dryRun = false, authorizationId, expectedHash, operationId }) => {
      const context = getToolContext(server);
      if(context&&(context.requireScopes||hasOwnerAccess())) return managedTextEdit(context,"append",{filePath,text,createIfMissing,dryRun,authorizationId,expectedHash,operationId});
      try {
        const validatedPath = validatePathForTextWrite(filePath, ALLOWED_WORKSPACE_ROOTS);
        await checkSymlinksInResolvedPath(validatedPath);

        let fileExists = false;
        try {
          const stat = await fs.stat(validatedPath);
          if (!stat.isFile()) {
            throw new Error(`Path validation failed: '${validatedPath}' is not a regular file.`);
          }
          fileExists = true;

          // Check binary content for first 1024 bytes of existing file
          const fd = await fs.open(validatedPath, 'r');
          try {
            const checkSize = Math.min(stat.size, 1024);
            if (checkSize > 0) {
              const buffer = Buffer.alloc(checkSize);
              await fd.read(buffer, 0, checkSize, 0);
              if (isBinaryBuffer(buffer)) {
                throw new Error(`Security violation: Binary content detected in file '${path.basename(validatedPath)}'.`);
              }
            }
          } finally {
            await fd.close();
          }
        } catch (e: any) {
          if (e.code === 'ENOENT') {
            if (!createIfMissing) {
              throw new Error(`File does not exist: '${validatedPath}'. Set createIfMissing to true to create it.`);
            }
          } else {
            throw e;
          }
        }

        if (dryRun) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  dryRun: true,
                  message: fileExists
                    ? "File exists and is ready for appending."
                    : "File does not exist and will be created upon execution.",
                  filePath: validatedPath
                }, null, 2)
              }
            ]
          };
        }

        // Create parent directories if needed
        if (!fileExists && createIfMissing) {
          await fs.mkdir(path.dirname(validatedPath), { recursive: true });
        }

        await fs.appendFile(validatedPath, text, 'utf-8');

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                dryRun: false,
                message: fileExists ? "Successfully appended content to file." : "Successfully created file and appended content.",
                filePath: validatedPath,
                bytesWritten: Buffer.byteLength(text, 'utf-8')
              }, null, 2)
            }
          ]
        };

      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: redactSensitiveData(error.message || "An unexpected error occurred during append_to_file.")
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

/**
 * Registers the replace_text_once tool with the MCP server.
 */
export function registerReplaceTextOnceTool(server: McpServer): void {
  server.registerTool(
    "replace_text_once",
    {
      description: "Finds and replaces exactly one occurrence of a literal search string inside a safe text file.",
      inputSchema: z.object({
        ...contextFields,
        filePath: z.string().describe("Absolute path to the text file"),
        findText: z.string().describe("Exact literal string to find"),
        replaceText: z.string().describe("Replacement string"),
        dryRun: z.boolean().optional().default(false).describe("If true, only check if exactly one match exists without applying (default: false)")
      }),
    },
    async ({ filePath, findText, replaceText, dryRun = false, authorizationId, expectedHash, operationId }) => {
      const context = getToolContext(server);
      if(context&&(context.requireScopes||hasOwnerAccess())) return managedTextEdit(context,"replace",{filePath,findText,replaceText,dryRun,authorizationId,expectedHash,operationId});
      if(!findText) return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:"EMPTY_SEARCH_REJECTED"})}]};
      try {
        const validatedPath = validatePathForTextWrite(filePath, ALLOWED_WORKSPACE_ROOTS);
        await checkSymlinksInResolvedPath(validatedPath);

        const stat = await fs.stat(validatedPath);
        if (!stat.isFile()) {
          throw new Error(`Path validation failed: '${validatedPath}' is not a regular file.`);
        }

        // Limit size to prevent loading huge files to memory
        const MAX_FILE_SIZE = 5 * 1024 * 1024;
        if (stat.size > MAX_FILE_SIZE) {
          throw new Error(`Security violation: File size exceeds the maximum allowed limit of ${MAX_FILE_SIZE} bytes.`);
        }

        const buffer = await fs.readFile(validatedPath);
        if (isBinaryBuffer(buffer)) {
          throw new Error(`Security violation: Binary content detected in file '${path.basename(validatedPath)}'.`);
        }

        const content = buffer.toString('utf-8');

        // Count occurrences
        let count = 0;
        let pos = content.indexOf(findText);
        while (pos !== -1) {
          count++;
          if (count > 1) {
            break;
          }
          pos = content.indexOf(findText, pos + findText.length);
        }

        if (count === 0) {
          throw new Error(`Replacement failed: The search text was not found in the file.`);
        }
        if (count > 1) {
          throw new Error(`Replacement failed: Multiple occurrences of the search text were found (${count}). Only exactly one match is allowed to prevent unintended edits.`);
        }

        if (dryRun) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  dryRun: true,
                  message: "Exactly one occurrence of the search text was found. Eligible for replacement.",
                  filePath: validatedPath
                }, null, 2)
              }
            ]
          };
        }

        const updatedContent = content.replace(findText, replaceText);
        await fs.writeFile(validatedPath, updatedContent, 'utf-8');

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                dryRun: false,
                message: "Successfully replaced the search text once.",
                filePath: validatedPath
              }, null, 2)
            }
          ]
        };

      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: redactSensitiveData(error.message || "An unexpected error occurred during replace_text_once.")
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

/**
 * Registers the read_file_range tool with the MCP server.
 */
export function registerReadFileRangeTool(server: McpServer): void {
  server.registerTool(
    "read_file_range",
    {
      description: "Reads a bounded range of lines from a safe text file, returning lines with line numbers.",
      inputSchema: z.object({
        ...contextFields,
        filePath: z.string().describe("Absolute path to the text file"),
        startLine: z.number().min(1).describe("First line to read (1-indexed)"),
        endLine: z.number().min(1).describe("Last line to read (1-indexed, inclusive)"),
        maxLines: z.number().min(1).max(1000).optional().default(500).describe("Maximum number of lines to return (1 to 1000, default 500)"),
        maxBytes: z.number().min(1).max(5 * 1024 * 1024).optional().default(1024 * 1024).describe("Maximum bytes to read (up to 5 MB, default 1 MB)")
      }),
    },
    async ({ filePath, startLine, endLine, maxLines = 500, maxBytes = 1024 * 1024 }) => {
      try {
        if (startLine > endLine) {
          throw new Error("Invalid range: startLine must be less than or equal to endLine.");
        }

        const validatedPath = validatePathForRead(filePath, ALLOWED_WORKSPACE_ROOTS);
        await checkSymlinksInResolvedPath(validatedPath);

        const stat = await fs.stat(validatedPath);
        if (!stat.isFile()) {
          throw new Error(`Path validation failed: '${validatedPath}' is not a regular file.`);
        }

        // Check binary content for first 1024 bytes of existing file
        const fd = await fs.open(validatedPath, 'r');
        try {
          const checkSize = Math.min(stat.size, 1024);
          if (checkSize > 0) {
            const buffer = Buffer.alloc(checkSize);
            await fd.read(buffer, 0, checkSize, 0);
            if (isBinaryBuffer(buffer)) {
              throw new Error(`Security violation: Binary content detected in file '${path.basename(validatedPath)}'.`);
            }
          }
        } finally {
          await fd.close();
        }

        const limitLines = Math.min(Math.max(maxLines, 1), 1000);
        const limitBytes = Math.min(Math.max(maxBytes, 1), 5 * 1024 * 1024);

        const fileStream = createReadStream(validatedPath, { encoding: 'utf8' });
        const rl = readline.createInterface({
          input: fileStream,
          crlfDelay: Infinity
        });

        let currentLineNum = 0;
        const lines: string[] = [];
        let totalBytesAccumulated = 0;
        let isTruncated = false;

        try {
          for await (const line of rl) {
            currentLineNum++;
            if (currentLineNum >= startLine && currentLineNum <= endLine) {
              const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
              if (totalBytesAccumulated + lineBytes > limitBytes) {
                isTruncated = true;
                break;
              }
              if (lines.length >= limitLines) {
                isTruncated = true;
                break;
              }
              lines.push(`${currentLineNum}: ${line}`);
              totalBytesAccumulated += lineBytes;
            }
            if (currentLineNum > endLine) {
              break;
            }
          }
        } finally {
          rl.close();
          fileStream.destroy();
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                filePath: validatedPath,
                startLine,
                endLine,
                linesRead: lines.length,
                isTruncated,
                content: lines.join('\n')
              }, null, 2)
            }
          ]
        };

      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: redactSensitiveData(error.message || "An unexpected error occurred during read_file_range.")
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

/**
 * Registers the write_text_file tool with the MCP server.
 */
export function registerWriteTextFileTool(server: McpServer): void {
  server.registerTool(
    "write_text_file",
    {
      description: "Writes or overwrites a safe text file with configuration protection and dry-run options.",
      inputSchema: z.object({
        ...contextFields,
        filePath: z.string().describe("Absolute path to the target text file"),
        content: z.string().describe("UTF-8 text content to write"),
        overwrite: z.boolean().optional().default(false).describe("If true, overwrite the file if it exists (default: false)"),
        createParents: z.boolean().optional().default(true).describe("If true, create parent directories if missing (default: true)"),
        dryRun: z.boolean().optional().default(false).describe("If true, validate paths and options without writing (default: false)")
      }),
    },
    async ({ filePath, content, overwrite = false, createParents = true, dryRun = false, authorizationId, expectedHash, operationId }) => {
      const context = getToolContext(server);
      if(context&&(context.requireScopes||hasOwnerAccess())) return managedTextEdit(context,"write",{filePath,content,overwrite,createParents,dryRun,authorizationId,expectedHash,operationId});
      try {
        const validatedPath = validatePathForTextWrite(filePath, ALLOWED_WORKSPACE_ROOTS);
        await checkSymlinksInResolvedPath(validatedPath);

        let fileExists = false;
        try {
          const stat = await fs.stat(validatedPath);
          if (!stat.isFile()) {
            throw new Error(`Path validation failed: '${validatedPath}' is not a regular file.`);
          }
          fileExists = true;

          if (!overwrite) {
            throw new Error("Target file already exists. Set overwrite to true to allow overwriting.");
          }

          // Check binary content for first 1024 bytes of existing file
          const fd = await fs.open(validatedPath, 'r');
          try {
            const checkSize = Math.min(stat.size, 1024);
            if (checkSize > 0) {
              const buffer = Buffer.alloc(checkSize);
              await fd.read(buffer, 0, checkSize, 0);
              if (isBinaryBuffer(buffer)) {
                throw new Error("Security violation: Cannot overwrite a binary file.");
              }
            }
          } finally {
            await fd.close();
          }
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }

        const parentDir = path.dirname(validatedPath);
        let parentExists = false;
        try {
          const parentStat = await fs.stat(parentDir);
          if (parentStat.isDirectory()) {
            parentExists = true;
          }
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }

        if (!parentExists && !createParents) {
          throw new Error("Parent directory does not exist and createParents is set to false.");
        }

        if (dryRun) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  dryRun: true,
                  message: fileExists
                    ? "File exists and will be overwritten."
                    : `File does not exist and will be created. Parent directories status: ${parentExists ? 'exists' : 'will be created'}.`,
                  filePath: validatedPath
                }, null, 2)
              }
            ]
          };
        }

        // Create parent directories if needed
        if (!parentExists && createParents) {
          await fs.mkdir(parentDir, { recursive: true });
        }

        await fs.writeFile(validatedPath, content, 'utf-8');

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                dryRun: false,
                message: fileExists ? "Successfully overwrote file." : "Successfully created file.",
                filePath: validatedPath,
                bytesWritten: Buffer.byteLength(content, 'utf-8')
              }, null, 2)
            }
          ]
        };

      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: redactSensitiveData(error.message || "An unexpected error occurred during write_text_file.")
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

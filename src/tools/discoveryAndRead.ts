import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOWED_WORKSPACE_ROOTS,
  validatePathForRead,
  resolveAndValidatePath,
  isIgnoredPath,
  checkForbiddenFile,
  isBinaryExtension,
  isBinaryBuffer,
  MAX_READ_FILE_SIZE
} from "../security/index.js";

/**
 * Đăng ký công cụ list_projects với máy chủ MCP.
 * Liệt kê các thư mục dự án trực tiếp nằm dưới các workspace root được chấp thuận.
 * Loại bỏ hoàn toàn các symlink để tránh nguy cơ thoát khỏi thư mục an toàn.
 * Giới hạn số lượng dự án trả về bằng tham số maxProjects (mặc định 100, tối đa 500).
 */
export function registerListProjectsTool(server: McpServer): void {
  server.registerTool(
    "list_projects",
    {
      description: "List immediate project/repository directories under approved workspace roots",
      inputSchema: z.object({
        rootPath:z.string().optional().describe('Optional absolute directory to list; standing owner access permits any accessible directory'),
        maxProjects: z.number()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe("Maximum number of projects to return (1 to 500, default 100)")
      }),
    },
    async ({ maxProjects = 100, rootPath }) => {
      try {
        const limit = Math.min(Math.max(maxProjects, 1), 500);
        const projects: Array<{ name: string; path: string }> = [];
        let truncated = false;

        for (const root of rootPath?[resolveAndValidatePath(rootPath)]:ALLOWED_WORKSPACE_ROOTS) {
          if (truncated) {
            break;
          }
          try {
            const resolvedRoot = path.resolve(root);
            const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });

            for (const entry of entries) {
              // Chỉ xem xét thư mục và bỏ qua ngay các symlink được phát hiện qua Dirent
              if (entry.isDirectory() && !entry.isSymbolicLink()) {
                const projectPath = path.join(resolvedRoot, entry.name);
                
                // Sử dụng lstat để xác minh thêm lớp phòng thủ, loại bỏ hoàn toàn liên kết tượng trưng
                let lstat;
                try {
                  lstat = await fs.lstat(projectPath);
                } catch {
                  continue; // Bỏ qua nếu không thể lstat
                }

                if (lstat.isSymbolicLink()) {
                  continue;
                }

                // Kiểm tra xem thư mục có bị bỏ qua hoặc bị cấm theo chính sách bảo mật không
                if (isIgnoredPath(projectPath) || checkForbiddenFile(projectPath)) {
                  continue;
                }

                if (projects.length < limit) {
                  projects.push({
                    name: entry.name,
                    path: projectPath
                  });
                } else {
                  // Đã đạt giới hạn nhưng vẫn còn dự án hợp lệ khác
                  truncated = true;
                  break;
                }
              }
            }
          } catch (err) {
            // Bỏ qua lỗi nếu thư mục gốc không tồn tại hoặc không đọc được
            // để tiếp tục quét các thư mục gốc khác.
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  projects,
                  count: projects.length,
                  truncated
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error.message || "An unexpected error occurred while listing projects."
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}

interface TreeEntry {
  relativePath: string;
  type: "file" | "directory";
  size?: number;
}

/**
 * Đệ quy quét thư mục con và thu thập thông tin về cấu trúc cây.
 * Bị giới hạn bởi maxDepth và maxEntries.
 * Sử dụng lstat để ngăn chặn việc đi theo các symlink nhằm tránh rò rỉ dữ liệu ngoài workspace.
 */
async function scanDirectory(
  currentDir: string,
  rootPath: string,
  currentDepth: number,
  maxDepth: number,
  maxEntries: number,
  state: { count: number; entries: TreeEntry[] }
): Promise<void> {
  if (currentDepth > maxDepth || state.count >= maxEntries) {
    return;
  }

  let files: string[] = [];
  try {
    files = await fs.readdir(currentDir);
  } catch (err) {
    // Không thể đọc được thư mục này (ví dụ: lỗi quyền hạn), bỏ qua
    return;
  }

  for (const file of files) {
    if (state.count >= maxEntries) {
      break;
    }

    const fullPath = path.join(currentDir, file);
    const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/');

    // Kiểm tra bảo mật nghiêm ngặt cho từng đường dẫn con
    if (isIgnoredPath(fullPath) || checkForbiddenFile(fullPath)) {
      continue;
    }

    let lstat;
    try {
      // Sử dụng lstat thay vì stat để không đi theo symlink
      lstat = await fs.lstat(fullPath);
    } catch (err) {
      continue; // Bỏ qua nếu không thể lấy thông tin lstat
    }

    // Từ chối và bỏ qua mọi symlink để phòng ngừa rò rỉ
    if (lstat.isSymbolicLink()) {
      continue;
    }

    if (lstat.isDirectory()) {
      state.count++;
      state.entries.push({
        relativePath: relPath,
        type: "directory"
      });

      await scanDirectory(fullPath, rootPath, currentDepth + 1, maxDepth, maxEntries, state);
    } else if (lstat.isFile()) {
      // Bỏ qua các tệp nhị phân khỏi cấu trúc cây
      if (isBinaryExtension(fullPath)) {
        continue;
      }

      state.count++;
      state.entries.push({
        relativePath: relPath,
        type: "file",
        size: lstat.size
      });
    }
  }
}

/**
 * Đăng ký công cụ read_tree với máy chủ MCP.
 * Quét đệ quy cấu trúc cây thư mục dưới thư mục được chỉ định một cách an toàn.
 * Chặn hoàn toàn symlink tại cả thư mục gốc và thư mục con.
 */
export function registerReadTreeTool(server: McpServer): void {
  server.registerTool(
    "read_tree",
    {
      description: "Recursively list text-safe directory tree metadata, bounded by max depth and max entries",
      inputSchema: z.object({
        rootPath: z.string().describe("Absolute path to the root directory to scan"),
        maxDepth: z.number().min(1).max(5).optional().default(3).describe("Maximum directory recursion depth (1 to 5, default 3)"),
        maxEntries: z.number().min(1).max(1000).optional().default(250).describe("Maximum number of files/directories to return (1 to 1000, default 250)"),
      }),
    },
    async ({ rootPath, maxDepth = 3, maxEntries = 250 }) => {
      try {
        // Xác thực và chuẩn hóa rootPath bằng resolveAndValidatePath
        const validatedRoot = resolveAndValidatePath(rootPath, ALLOWED_WORKSPACE_ROOTS);

        // Kiểm tra bổ sung: không được là tệp/thư mục bị cấm hoặc nằm trong thư mục bị bỏ qua
        if (isIgnoredPath(validatedRoot) || checkForbiddenFile(validatedRoot)) {
          throw new Error(`Security violation: Directory '${path.basename(validatedRoot)}' is forbidden or ignored.`);
        }

        // Kiểm tra xem validatedRoot có phải là symlink hay không bằng lstat
        const rootLstat = await fs.lstat(validatedRoot);
        if (rootLstat.isSymbolicLink()) {
          throw new Error(`Security violation: Target path '${validatedRoot}' is a symbolic link.`);
        }
        if (!rootLstat.isDirectory()) {
          throw new Error(`Path validation failed: '${validatedRoot}' is not a directory.`);
        }

        const state = { count: 0, entries: [] as TreeEntry[] };
        await scanDirectory(validatedRoot, validatedRoot, 1, maxDepth, maxEntries, state);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  rootPath: validatedRoot,
                  entries: state.entries,
                  truncated: state.count >= maxEntries
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error.message || "An unexpected error occurred while reading directory tree."
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}

/**
 * Đăng ký công cụ read_file với máy chủ MCP.
 * Đọc nội dung tệp văn bản UTF-8 an toàn với các chốt chặn kích thước, symlink và nhị phân.
 */
export function registerReadFileTool(server: McpServer): void {
  server.registerTool(
    "read_file",
    {
      description: "Read a text file safely with size and binary content guards",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file to read"),
      }),
    },
    async ({ filePath }) => {
      try {
        // 1. Xác thực đường dẫn (thuộc roots, không cấm, không bỏ qua, không có extension nhị phân)
        const validatedPath = validatePathForRead(filePath, ALLOWED_WORKSPACE_ROOTS);

        // 2. Chốt chặn symlink giai đoạn đầu bằng lstat
        const lstat = await fs.lstat(validatedPath);
        if (lstat.isSymbolicLink()) {
          throw new Error(`Security violation: File '${path.basename(validatedPath)}' is a symbolic link.`);
        }

        if (!lstat.isFile()) {
          throw new Error(`Path validation failed: '${validatedPath}' is not a regular file.`);
        }

        if (lstat.size > MAX_READ_FILE_SIZE) {
          throw new Error(`Security violation: File size ${lstat.size} exceeds the maximum allowed limit of ${MAX_READ_FILE_SIZE} bytes.`);
        }

        // 3. Phòng thủ sâu hơn: Resolve real path và thực hiện các chốt chặn tương tự trên real path
        const realPath = await fs.realpath(validatedPath);
        const validatedRealPath = validatePathForRead(realPath, ALLOWED_WORKSPACE_ROOTS);

        const realLstat = await fs.lstat(validatedRealPath);
        if (realLstat.isSymbolicLink()) {
          throw new Error(`Security violation: Resolved real path is a symbolic link.`);
        }

        if (!realLstat.isFile()) {
          throw new Error(`Path validation failed: Resolved path is not a regular file.`);
        }

        if (realLstat.size > MAX_READ_FILE_SIZE) {
          throw new Error(`Security violation: Resolved file size ${realLstat.size} exceeds the maximum allowed limit.`);
        }

        // 4. Đọc dữ liệu tệp thô từ realPath dưới dạng buffer
        const buffer = await fs.readFile(validatedRealPath);

        // 5. Kiểm tra mã nhị phân trong buffer (chốt chặn cuối cùng)
        if (isBinaryBuffer(buffer)) {
          throw new Error(`Security violation: Binary content detected in file '${path.basename(validatedRealPath)}'.`);
        }

        const content = buffer.toString('utf-8');

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  filePath: validatedRealPath,
                  size: realLstat.size,
                  content
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error.message || "An unexpected error occurred while reading file."
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}

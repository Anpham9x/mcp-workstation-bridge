import { contextFields, getToolContext } from '../reliability/policy.js';
import { performMutation } from '../reliability/mutations.js';
import { patchBytes } from './bytePatch.js';
import { atomicFile, assertNoLinks, readOptional, sha256 } from './atomicFile.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOWED_WORKSPACE_ROOTS,
  validatePathForWrite,
  resolveAndValidatePath,
  redactSensitiveData
} from "../security/index.js";

/**
 * Trích xuất đường dẫn tệp tin từ dòng tiêu đề diff (--- hoặc +++).
 * Hỗ trợ định dạng git diff tiêu chuẩn và loại bỏ tiền tố a/ hoặc b/.
 * Trả về '/dev/null' nếu đó là file trống (tạo mới/xóa).
 */
function parsePathHeader(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  const remainder = line.substring(prefix.length).trim();
  if (remainder === '/dev/null') return '/dev/null';

  // Tách lấy phần đầu tiên trước khoảng trắng hoặc tab (để loại bỏ timestamp nếu có)
  const parts = remainder.split(/[\s\t]+/);
  let rawPath = parts[0];

  // Nếu đường dẫn bị bao quanh bởi dấu ngoặc kép (do khoảng trắng), từ chối để bảo mật/tránh nhập nhằng
  if (rawPath.startsWith('"') || rawPath.endsWith('"')) {
    throw new Error(`Định dạng đường dẫn không được hỗ trợ (chứa dấu nháy kép): ${rawPath}`);
  }

  // Loại bỏ tiền tố a/ hoặc b/ nếu có (ví dụ: a/src/index.ts -> src/index.ts)
  if (/^[a-zA-Z]\//.test(rawPath)) {
    rawPath = rawPath.substring(2);
  }

  return rawPath;
}

/**
 * Hàm phân tích cú pháp unified diff để trích xuất danh sách tất cả các tệp tin đích bị thay đổi.
 * Từ chối các patch không hợp lệ, chứa nhị phân, tạo symlink hoặc thực hiện rename tệp.
 */
export function parsePatchTargets(patch: string): string[] {
  // Kiểm tra malformed non-unified patch (ví dụ định dạng "*** Add File" của ChatGPT)
  if (patch.includes('*** Add File') || /^\s*\*\*\*\s*Add\s+File/i.test(patch) || /^\s*\*\*\*\s+\S+/m.test(patch)) {
    throw new Error("Malformed non-unified patch format (e.g. '*** Add File' style). Please use a standard unified diff format.");
  }

  // Kiểm tra patch nhị phân
  if (patch.includes('GIT binary patch') || patch.includes('Binary files differ')) {
    throw new Error("Không hỗ trợ áp dụng patch nhị phân (binary patch).");
  }

  // Kiểm tra xem có tạo liên kết tượng trưng (symlink) qua patch hay không
  // Trong git diff, tạo symlink mới có dòng mode là "new file mode 120000"
  if (patch.match(/^new file mode 120000/m)) {
    throw new Error("Tạo liên kết tượng trưng (symlink) qua patch bị cấm vì lý do bảo mật.");
  }

  const lines = patch.split(/\r?\n/);
  const targets = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Tìm kiếm cặp dòng --- và +++ đi liền nhau ở phần header của file
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const line1 = line;
      const line2 = lines[i + 1];

      const path1 = parsePathHeader(line1, '--- ');
      const path2 = parsePathHeader(line2, '+++ ');

      if (!path1 || !path2) {
        throw new Error(`Patch bị lỗi cấu trúc: Dòng tiêu đề không hợp lệ: "${line1}" và "${line2}"`);
      }

      if (path1 === '/dev/null' && path2 === '/dev/null') {
        throw new Error("Patch bị lỗi cấu trúc: Cả nguồn và đích đều là /dev/null");
      }

      let targetPath: string;
      if (path1 === '/dev/null') {
        // File được thêm mới
        targetPath = path2;
      } else if (path2 === '/dev/null') {
        // File bị xóa - Bị cấm theo chính sách bảo mật
        throw new Error("Hành động xóa tệp tin (deletion) không được hỗ trợ bởi controlled apply_patch.");
      } else {
        // File bị sửa đổi. Kiểm tra xem có đổi tên (rename) không.
        const norm1 = path.normalize(path1).replace(/\\/g, '/');
        const norm2 = path.normalize(path2).replace(/\\/g, '/');
        if (norm1 !== norm2) {
          throw new Error(`Phát hiện hành động đổi tên file (từ "${path1}" sang "${path2}"), hành động này không được hỗ trợ.`);
        }
        targetPath = path1;
      }

      targets.add(targetPath);
      i++; // Bỏ qua dòng +++ tiếp theo
    }
  }

  if (targets.size === 0) {
    throw new Error("Không tìm thấy tệp tin đích hợp lệ. Đảm bảo patch sử dụng định dạng unified diff tiêu chuẩn (chứa các dòng tiêu đề '---' và '+++').");
  }

  return Array.from(targets);
}

export function registerApplyPatchTool(server: McpServer): void {
  server.registerTool("apply_patch", {
    description: "Apply one unified UTF-8 file patch preserving unchanged bytes, BOM and line terminators. Multi-file patches fail closed.",
    inputSchema: z.object({
      ...contextFields,
      workspacePath: z.string(), patch: z.string(),
      dryRun: z.boolean().optional().default(false)
    })
  }, async ({ workspacePath, patch, dryRun = false, authorizationId, expectedHash, operationId }) => {
    try {
      const root = resolveAndValidatePath(workspacePath, ALLOWED_WORKSPACE_ROOTS);
      const targets = parsePatchTargets(patch);
      if (targets.length !== 1) throw new Error('SINGLE_FILE_ONLY');
      const file = path.resolve(root, targets[0]);
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PATH_OUTSIDE_WORKSPACE: target is outside workspace');
      validatePathForWrite(file, ALLOWED_WORKSPACE_ROOTS);
      await assertNoLinks(file);
      const context = getToolContext(server);
      if(context?.requireScopes){
        const result=await performMutation(context,{file,action:"patch",payload:{patch},dryRun,authorizationId,expectedHash,operationId,createParents:true},before=>patchBytes(before,patch));
        return {isError:!result.success,content:[{type:"text",text:JSON.stringify({...result,changedFiles:targets})}]};
      }
      const before = await readOptional(file);
      if (before && before.length > 5 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');
      const after = patchBytes(before, patch);
      if (!dryRun) {
        if (before === null) await fs.mkdir(path.dirname(file), {recursive:true});
        await atomicFile(file, after, before);
      }
      return {content:[{type:"text",text:JSON.stringify({success:true,dryRun,changedFiles:targets,
        beforeHash:before ? sha256(before) : null, afterHash:sha256(after),bytes:after.length})}]};
    } catch (error) {
      return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,
        error:redactSensitiveData(error instanceof Error ? error.message : String(error))})}]};
    }
  });
}

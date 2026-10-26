import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerApplyPatchTool, parsePatchTargets } from './applyPatch.js';

console.log('Bắt đầu chạy Unit Test cho Apply Patch Tool...');

// Khởi tạo MCP Server giả lập để test
const mockServer = new McpServer({
  name: "test-patch-server",
  version: "1.0.0"
});

// Đăng ký tool
registerApplyPatchTool(mockServer);

// Helper để lấy tool
function getTool(name: string) {
  const registeredTools = (mockServer as any)._registeredTools;
  const tool = registeredTools?.[name];
  if (!tool) {
    throw new Error(`Không tìm thấy công cụ '${name}' được đăng ký trên server.`);
  }
  return {
    execute: async (args: any) => {
      return await tool.handler(args);
    }
  };
}

async function runTests() {
  const applyPatch = getTool('apply_patch');
  const projectDir = path.resolve('.');

  // ==========================================
  // 1. UNIT TEST CHO PARSER (parsePatchTargets)
  // ==========================================
  console.log('- Đang kiểm tra parsePatchTargets...');

  // Test case 1.1: Patch hợp lệ sửa đổi file
  const validPatch = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcde 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 console.log("hello");
+console.log("world");
`;
  const targets = parsePatchTargets(validPatch);
  assert.deepStrictEqual(targets, ['src/index.ts'], 'Phải trích xuất đúng file src/index.ts');

  // Test case 1.2: Patch hợp lệ thêm mới file
  const newFilePatch = `diff --git a/newfile.txt b/newfile.txt
new file mode 100644
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1 @@
+New content
`;
  const newTargets = parsePatchTargets(newFilePatch);
  assert.deepStrictEqual(newTargets, ['newfile.txt'], 'Phải trích xuất đúng file newfile.txt khi tạo mới');

  // Test case 1.3: Reject patch xóa file (deletion)
  const deleteFilePatch = `diff --git a/oldfile.txt b/oldfile.txt
deleted file mode 100644
--- a/oldfile.txt
+++ /dev/null
@@ -1 +0,0 @@
-Old content
`;
  assert.throws(() => {
    parsePatchTargets(deleteFilePatch);
  }, /xóa tệp tin|deletion/, 'Phải từ chối patch xóa file');

  // Test case 1.4: Reject patch nhị phân
  const binaryPatch = `diff --git a/image.png b/image.png
Binary files differ
`;
  assert.throws(() => {
    parsePatchTargets(binaryPatch);
  }, /nhị phân/, 'Phải từ chối patch nhị phân');

  // Test case 1.5: Reject symlink creation
  const symlinkPatch = `diff --git a/link b/link
new file mode 120000
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+target_file
\\ No newline at end of file
`;
  assert.throws(() => {
    parsePatchTargets(symlinkPatch);
  }, /liên kết tượng trưng/, 'Phải từ chối patch tạo symlink');

  // Test case 1.6: Reject rename
  const renamePatch = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
`;
  assert.throws(() => {
    parsePatchTargets(renamePatch);
  }, /đổi tên/, 'Phải từ chối patch đổi tên file');


  // ==========================================
  // 2. UNIT TEST CHO PATH & SECURITY VALIDATION
  // ==========================================
  console.log('- Đang kiểm tra bảo mật đường dẫn và tệp tin bị cấm...');

  // Test case 2.1: Sửa đổi tệp tin bị cấm (.env)
  const forbiddenPatch = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1,2 @@
 PORT=3000
+SECRET=key
`;
  const forbiddenResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: forbiddenPatch,
    dryRun: true
  });
  assert.strictEqual(forbiddenResult.isError, true, 'Yêu cầu sửa đổi .env phải bị lỗi');
  assert.ok(forbiddenResult.content[0].text.includes('forbidden'), 'Thông báo lỗi phải đề cập đến forbidden hoặc tương tự');

  // Test case 2.2: Sửa đổi tệp tin cấu hình dự án bị khóa (package.json)
  const lockedConfigPatch = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,3 +2,4 @@
   "name": "mcp-antigravity-bridge",
+  "version": "1.0.0",
`;
  const lockedResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: lockedConfigPatch,
    dryRun: true
  });
  assert.strictEqual(lockedResult.isError, true, 'Yêu cầu sửa đổi package.json phải bị lỗi');
  assert.ok(lockedResult.content[0].text.includes('restricted') || lockedResult.content[0].text.includes('Security violation'), 'Thông báo lỗi phải phản ánh vi phạm ghi');

  // Test case 2.3: Path traversal ra ngoài workspace
  const traversalPatch = `diff --git a/../outside.txt b/../outside.txt
--- a/../outside.txt
+++ b/../outside.txt
@@ -1 +1 @@
-old
+new
`;
  const traversalResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: traversalPatch,
    dryRun: true
  });
  assert.strictEqual(traversalResult.isError, true, 'Yêu cầu sửa đổi file ngoài workspace phải bị lỗi');
  assert.ok(traversalResult.content[0].text.includes('nằm ngoài thư mục workspace') || traversalResult.content[0].text.includes('outside'), 'Phải báo lỗi thoát khỏi workspace');


  // ==========================================
  // 3. END-TO-END DRYRUN VÀ APPLY THỰC TẾ
  // ==========================================
  console.log('- Đang kiểm tra áp dụng patch thực tế (dry-run & apply)...');

  // Chuẩn bị file test vô hại trong thư mục scratch
  const scratchDir = path.join(projectDir, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  const testFileRelative = 'scratch/temp_test_apply_patch.txt';
  const testFileAbsolute = path.join(projectDir, testFileRelative);
  
  await fs.writeFile(testFileAbsolute, 'Hello World\nLine 2\nLine 3\n');

  // Tạo một patch thay đổi nội dung file test này
  const targetPatch = `diff --git a/scratch/temp_test_apply_patch.txt b/scratch/temp_test_apply_patch.txt
--- a/scratch/temp_test_apply_patch.txt
+++ b/scratch/temp_test_apply_patch.txt
@@ -1,3 +1,3 @@
-Hello World
+Hello Antigravity
 Line 2
 Line 3
`;

  // Thử nghiệm dryRun: true
  const dryRunResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: targetPatch,
    dryRun: true
  });

  assert.strictEqual(dryRunResult.isError, undefined, 'dryRun không được báo lỗi');
  const dryRunData = JSON.parse(dryRunResult.content[0].text);
  assert.strictEqual(dryRunData.success, true);
  assert.strictEqual(dryRunData.dryRun, true);
  assert.deepStrictEqual(dryRunData.changedFiles, [testFileRelative.replace(/\\/g, '/')]);

  // Kiểm tra xem file thực tế có bị thay đổi không (không được thay đổi)
  const contentAfterDryRun = await fs.readFile(testFileAbsolute);
  assert.deepStrictEqual(contentAfterDryRun, Buffer.from('Hello World\nLine 2\nLine 3\n'), 'File không được thay đổi khi dryRun=true');

  // Thử nghiệm dryRun: false (apply thực tế)
  const applyActualResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: targetPatch,
    dryRun: false
  });

  assert.strictEqual(applyActualResult.isError, undefined, 'apply thực tế không được báo lỗi');
  const applyActualData = JSON.parse(applyActualResult.content[0].text);
  assert.strictEqual(applyActualData.success, true);
  assert.strictEqual(applyActualData.dryRun, false);

  // Kiểm tra xem file thực tế đã được cập nhật chưa
  const contentAfterApply = await fs.readFile(testFileAbsolute);
  assert.deepStrictEqual(contentAfterApply, Buffer.from('Hello Antigravity\nLine 2\nLine 3\n'), 'File phải được thay đổi khi dryRun=false');

  // Dọn dẹp tệp tin test
  try {
    await fs.rm(testFileAbsolute, { force: true });
  } catch (err) {
    // Bỏ qua lỗi dọn dẹp
  }

  // ==========================================
  // 4. MỞ RỘNG KIỂM TRA THEO YÊU CẦU MCP-YEN-005
  // ==========================================
  console.log('- Đang kiểm tra tạo file Markdown mới (scratch/CHATGPT_MCP_SETUP_GUIDE.test.md)...');
  
  const setupGuideRelative = 'scratch/CHATGPT_MCP_SETUP_GUIDE.test.md';
  const setupGuideAbsolute = path.join(projectDir, setupGuideRelative);
  
  // Đảm bảo file không tồn tại trước khi test
  try {
    await fs.rm(setupGuideAbsolute, { force: true });
  } catch (err) {}

  const setupGuidePatch = `diff --git a/scratch/CHATGPT_MCP_SETUP_GUIDE.test.md b/scratch/CHATGPT_MCP_SETUP_GUIDE.test.md
new file mode 100644
--- /dev/null
+++ b/scratch/CHATGPT_MCP_SETUP_GUIDE.test.md
@@ -0,0 +1,6 @@
+# ChatGPT MCP Setup Guide
+
+This is a setup guide.
+Line 2
+Line 3
+`;

  // 4.1. Dry-run tạo mới Markdown
  const mdDryRunResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: setupGuidePatch,
    dryRun: true
  });
  assert.strictEqual(mdDryRunResult.isError, undefined, 'dry-run tạo file markdown mới không được báo lỗi');
  const mdDryRunData = JSON.parse(mdDryRunResult.content[0].text);
  assert.strictEqual(mdDryRunData.success, true);
  assert.strictEqual(mdDryRunData.dryRun, true);
  assert.deepStrictEqual(mdDryRunData.changedFiles, [setupGuideRelative]);

  // Kiểm tra xem file có bị tạo thật không (phải không được tạo)
  let fileExistsAfterDryRun = true;
  try {
    await fs.access(setupGuideAbsolute);
  } catch (err) {
    fileExistsAfterDryRun = false;
  }
  assert.strictEqual(fileExistsAfterDryRun, false, 'File markdown mới không được tạo trong dry-run');

  // 4.2. Actual apply tạo mới Markdown
  const mdApplyResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: setupGuidePatch,
    dryRun: false
  });
  assert.strictEqual(mdApplyResult.isError, undefined, 'Apply thực tế tạo file markdown mới không được báo lỗi');
  const mdApplyData = JSON.parse(mdApplyResult.content[0].text);
  assert.strictEqual(mdApplyData.success, true);
  assert.strictEqual(mdApplyData.dryRun, false);
  assert.deepStrictEqual(mdApplyData.changedFiles, [setupGuideRelative]);

  // Kiểm tra xem file đã được tạo thực tế chưa và nội dung chính xác không
  const fileExistsAfterApply = await fs.access(setupGuideAbsolute).then(() => true).catch(() => false);
  assert.strictEqual(fileExistsAfterApply, true, 'File markdown mới phải được tạo thực tế sau apply');
  const createdContent = (await fs.readFile(setupGuideAbsolute, 'utf-8')).replace(/\r\n/g, '\n');
  assert.ok(createdContent.includes('# ChatGPT MCP Setup Guide'), 'Nội dung file markdown mới phải chính xác');

  // Dọn dẹp file markdown test
  try {
    await fs.rm(setupGuideAbsolute, { force: true });
  } catch (err) {}


  // 4.3. Malformed *** Add File rejection message
  console.log('- Đang kiểm tra từ chối patch dạng malformed *** Add File...');
  const malformedAddFilePatch = `*** Add File: scratch/CHATGPT_MCP_SETUP_GUIDE.test.md ***
# ChatGPT MCP Setup Guide
This is malformed.
`;
  const malformedResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: malformedAddFilePatch,
    dryRun: true
  });
  assert.strictEqual(malformedResult.isError, true, 'Malformed patch phải trả về isError: true');
  const malformedData = JSON.parse(malformedResult.content[0].text);
  assert.strictEqual(malformedData.success, false);
  assert.ok(malformedData.error.includes("Malformed non-unified patch format"), 'Thông báo lỗi phải rõ ràng về định dạng không được hỗ trợ');
  assert.ok(malformedData.error.includes("*** Add File"), 'Thông báo lỗi phải đề cập đến định dạng *** Add File');


  // 4.4. Cung cấp test case cho forbidden secret paths
  console.log('- Đang kiểm tra chặn ghi vào forbidden secret paths...');
  const secretKeyPatch = `diff --git a/id_rsa b/id_rsa
new file mode 100644
--- /dev/null
+++ b/id_rsa
@@ -0,0 +1 @@
+-----BEGIN RSA PRIVATE KEY-----
`;
  const secretResult = await applyPatch.execute({
    workspacePath: projectDir,
    patch: secretKeyPatch,
    dryRun: true
  });
  assert.strictEqual(secretResult.isError, true, 'Ghi vào id_rsa phải bị từ chối');
  const secretData = JSON.parse(secretResult.content[0].text);
  assert.strictEqual(secretData.success, false);
  assert.ok(secretData.error.includes("forbidden") || secretData.error.includes("Security violation"), 'Thông báo lỗi phải chỉ ra vi phạm bảo mật/forbidden');

  console.log('Tất cả các Unit Test cho Apply Patch Tool đều đạt (PASSED) thành công!');
}

runTests().catch((error) => {
  console.error('Unit Test thất bại với lỗi:', error);
  process.exit(1);
});

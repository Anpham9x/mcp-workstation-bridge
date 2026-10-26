import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerListProjectsTool,
  registerReadTreeTool,
  registerReadFileTool
} from './discoveryAndRead.js';

console.log('Bắt đầu chạy Unit Test cho Discovery and Read Tools...');

// Khởi tạo MCP Server giả lập để test
const mockServer = new McpServer({
  name: "test-server",
  version: "1.0.0"
});

// Đăng ký tools
registerListProjectsTool(mockServer);
registerReadTreeTool(mockServer);
registerReadFileTool(mockServer);

// Helper để lấy một tool đã được đăng ký
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
  const listProjects = getTool('list_projects');
  const readTree = getTool('read_tree');
  const readFile = getTool('read_file');

  // 1. Kiểm tra list_projects
  console.log('- Đang kiểm tra list_projects...');
  const listResult = await listProjects.execute({});
  assert.strictEqual(listResult.isError, undefined, 'list_projects không được báo lỗi');
  const listData = JSON.parse(listResult.content[0].text);
  assert.strictEqual(listData.success, true);
  assert.ok(Array.isArray(listData.projects), 'projects phải là một mảng');
  assert.strictEqual(typeof listData.count, 'number', 'phải trả về trường count');
  assert.strictEqual(typeof listData.truncated, 'boolean', 'phải trả về trường truncated');
  console.log(`  Tìm thấy ${listData.projects.length} dự án (count: ${listData.count}, truncated: ${listData.truncated}).`);

  // Kiểm tra list_projects với giới hạn maxProjects thấp để kích hoạt truncated
  console.log('- Đang kiểm tra list_projects với maxProjects = 2 để test truncated...');
  const limitResult = await listProjects.execute({ maxProjects: 2 });
  assert.strictEqual(limitResult.isError, undefined, 'list_projects không được báo lỗi với maxProjects=2');
  const limitData = JSON.parse(limitResult.content[0].text);
  assert.strictEqual(limitData.success, true);
  assert.ok(limitData.projects.length <= 2, 'Số dự án không được vượt quá 2');
  assert.strictEqual(limitData.count, limitData.projects.length, 'count phải khớp với projects.length');
  if (listData.projects.length > 2) {
    assert.strictEqual(limitData.truncated, true, 'truncated phải là true khi tổng số dự án thực tế lớn hơn maxProjects');
  }

  // 2. Kiểm tra read_tree
  console.log('- Đang kiểm tra read_tree với đường dẫn hợp lệ...');
  // Sử dụng chính thư mục dự án hiện tại để test
  const currentProjectDir = path.resolve('.');
  const treeResult = await readTree.execute({
    rootPath: currentProjectDir,
    maxDepth: 2,
    maxEntries: 50
  });
  assert.strictEqual(treeResult.isError, undefined, 'read_tree không được báo lỗi');
  const treeData = JSON.parse(treeResult.content[0].text);
  assert.strictEqual(treeData.success, true);
  assert.ok(Array.isArray(treeData.entries), 'entries phải là một mảng');
  assert.ok(treeData.entries.length > 0, 'Thư mục hiện tại phải có ít nhất một mục con');
  
  // Xác minh các file cấm/bỏ qua không xuất hiện trong tree
  const hasGit = treeData.entries.some((e: any) => e.relativePath.split('/').some((segment: string) => segment.toLowerCase() === '.git'));
  const hasNodeModules = treeData.entries.some((e: any) => e.relativePath.split('/').some((segment: string) => segment.toLowerCase() === 'node_modules'));
  assert.strictEqual(hasGit, false, 'Không được phép có thư mục .git trong tree');
  assert.strictEqual(hasNodeModules, false, 'Không được phép có node_modules trong tree');

  // 3. Kiểm tra read_tree với đường dẫn bên ngoài workspace được duyệt
  console.log('- Đang kiểm tra read_tree với đường dẫn không hợp lệ (bên ngoài root)...');
  const invalidTreeResult = await readTree.execute({
    rootPath: 'C:\\Windows'
  });
  assert.strictEqual(invalidTreeResult.isError, true, 'read_tree phải báo lỗi khi vượt ngoài root');
  const invalidTreeData = JSON.parse(invalidTreeResult.content[0].text);
  assert.strictEqual(invalidTreeData.success, false);
  assert.ok(invalidTreeData.error.includes('outside configured workspace roots'), 'Lỗi phải chỉ ra vi phạm bảo mật đường dẫn');

  // 4. Kiểm tra read_file với tệp hợp lệ
  console.log('- Đang kiểm tra read_file với tệp hợp lệ...');
  const packageJsonPath = path.resolve('package.json');
  const fileResult = await readFile.execute({
    filePath: packageJsonPath
  });
  assert.strictEqual(fileResult.isError, undefined, 'read_file không được báo lỗi đối với package.json');
  const fileData = JSON.parse(fileResult.content[0].text);
  assert.strictEqual(fileData.success, true);
  assert.ok(fileData.content.includes('mcp-antigravity-bridge'), 'Nội dung tệp phải chứa chuỗi mcp-antigravity-bridge');

  // 5. Kiểm tra read_file với tệp cấm (.env)
  console.log('- Đang kiểm tra read_file với tệp cấm (.env)...');
  const envPath = path.resolve('.env');
  // Tạo file .env giả để test nếu chưa có
  let createdEnv = false;
  try {
    await fs.access(envPath);
  } catch {
    await fs.writeFile(envPath, 'SECRET_KEY=12345');
    createdEnv = true;
  }

  try {
    const envResult = await readFile.execute({
      filePath: envPath
    });
    assert.strictEqual(envResult.isError, true, 'read_file phải báo lỗi khi đọc file .env');
    const envData = JSON.parse(envResult.content[0].text);
    assert.strictEqual(envData.success, false);
    assert.ok(envData.error.includes('forbidden secret or credential store'), 'Lỗi phải chỉ ra vi phạm bảo mật đối với secret store');
  } finally {
    if (createdEnv) {
      await fs.unlink(envPath).catch(() => {});
    }
  }

  // 6. Kiểm tra read_file với tệp nhị phân
  console.log('- Đang kiểm tra read_file với tệp nhị phân giả lập...');
  const binaryFilePath = path.resolve('test_binary.bin');
  // Ghi tệp nhị phân chứa null byte
  await fs.writeFile(binaryFilePath, Buffer.from([0x00, 0x01, 0x02]));
  try {
    const binResult = await readFile.execute({
      filePath: binaryFilePath
    });
    assert.strictEqual(binResult.isError, true, 'read_file phải báo lỗi khi đọc tệp nhị phân');
    const binData = JSON.parse(binResult.content[0].text);
    assert.strictEqual(binData.success, false);
    assert.ok(
      binData.error.includes('Reading binary file') || binData.error.includes('Binary content detected'),
      'Lỗi phải chỉ ra vi phạm bảo mật khi đọc tệp nhị phân'
    );
  } finally {
    await fs.unlink(binaryFilePath).catch(() => {});
  }

  // 7. Kiểm tra chặn liên kết tượng trưng (symlink)
  console.log('- Đang kiểm tra chặn symlink cho read_file...');
  const symlinkPath = path.resolve('test_symlink.txt');
  const targetPath = path.resolve('package.json'); // Trỏ tới một tệp tồn tại
  let symlinkCreated = false;
  try {
    await fs.symlink(targetPath, symlinkPath);
    symlinkCreated = true;
  } catch (err) {
    console.log('  [Bỏ qua test tạo symlink thực tế do không đủ quyền EPERM hoặc Developer Mode chưa bật]');
  }

  if (symlinkCreated) {
    try {
      const symResult = await readFile.execute({
        filePath: symlinkPath
      });
      assert.strictEqual(symResult.isError, true, 'read_file phải báo lỗi khi đọc symlink');
      const symData = JSON.parse(symResult.content[0].text);
      assert.strictEqual(symData.success, false);
      assert.ok(
        symData.error.toLowerCase().includes('symbolic link'),
        `Lỗi phải chỉ ra vi phạm bảo mật đối với symbolic link, thực tế nhận: ${symData.error}`
      );
    } finally {
      await fs.unlink(symlinkPath).catch(() => {});
    }
  }

  console.log('Tất cả các Unit Test cho Discovery and Read Tools đều đạt (PASSED) thành công!');
}

runTests().catch((err) => {
  console.error('Unit test thất bại:', err);
  process.exit(1);
});

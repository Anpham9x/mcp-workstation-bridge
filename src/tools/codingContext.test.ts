import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateWorkspacePolicy } from '../security/index.js';
import { listPackageScripts, projectProfile, readManyFiles, registerCodingContextTools, runPackageScript, searchCode } from './codingContext.js';

console.log('Bắt đầu chạy Unit Test cho Coding Context Tools...');

const fixtureRoot = path.resolve('tmp-coding-context-test');

async function resetFixture(): Promise<void> {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'node_modules', 'unsafe'), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        typecheck: 'tsc --noEmit',
        check: 'node -e "console.log(\\"fixture-check-pass\\")"',
        lint: 'rm -rf important-files'
      },
      dependencies: {
        react: '^19.0.0',
        vite: '^6.0.0'
      },
      devDependencies: {
        typescript: '^5.0.0'
      }
    }, null, 2),
    'utf8'
  );
  await fs.writeFile(path.join(fixtureRoot, 'package-lock.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'vite.config.ts'), 'export default {};\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'src', 'Hero.tsx'), [
    'export function Hero() {',
    '  return <section className="hero">Hero Title</section>;',
    '}'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'src', 'style.css'), '.hero { color: red; }\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'src', 'main.tsx'), 'import { Hero } from "./Hero";\nHero();\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'node_modules', 'unsafe', 'Hero.js'), 'const Hero = "should not appear";\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, '.env'), 'SECRET_HERO=hidden\n', 'utf8');
}

const mockServer = new McpServer({
  name: "test-server",
  version: "1.0.0"
});
registerCodingContextTools(mockServer);

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

async function runTests(): Promise<void> {
  await resetFixture();
  try {
    console.log('- Đang kiểm tra evaluateWorkspacePolicy...');
    const readDecision = evaluateWorkspacePolicy({
      workspacePath: fixtureRoot,
      action: 'read',
      targetPath: path.join(fixtureRoot, 'package.json')
    });
    assert.strictEqual(readDecision.allowed, true, 'package.json phải được phép đọc');

    const secretDecision = evaluateWorkspacePolicy({
      workspacePath: fixtureRoot,
      action: 'read',
      targetPath: path.join(fixtureRoot, '.env')
    });
    assert.strictEqual(secretDecision.allowed, false, '.env phải bị chặn');

    console.log('- Đang kiểm tra searchCode helper...');
    const searchResult = await searchCode({
      workspacePath: fixtureRoot,
      query: 'Hero',
      maxResults: 10,
      includeLineContext: 1
    });
    assert.ok(searchResult.totalMatches >= 2, 'phải tìm thấy Hero trong source');
    assert.ok(searchResult.results.some(result => result.relativePath === 'src/Hero.tsx'), 'phải có kết quả trong src/Hero.tsx');
    assert.strictEqual(
      searchResult.results.some(result => result.relativePath.includes('node_modules')),
      false,
      'không được trả kết quả trong node_modules'
    );
    assert.strictEqual(
      searchResult.results.some(result => result.relativePath === '.env'),
      false,
      'không được trả kết quả trong .env'
    );
    assert.ok(searchResult.results[0].before || searchResult.results[0].after, 'phải có context khi yêu cầu includeLineContext');

    console.log('- Đang kiểm tra search_code tool registration...');
    const searchTool = getTool('search_code');
    const toolResult = await searchTool.execute({
      workspacePath: fixtureRoot,
      query: 'hero',
      fileGlob: 'src/**',
      caseSensitive: false,
      regex: false,
      maxResults: 5,
      includeLineContext: 0
    });
    assert.strictEqual(toolResult.isError, undefined, 'search_code không được báo lỗi');
    const toolData = JSON.parse(toolResult.content[0].text);
    assert.strictEqual(toolData.query, 'hero');
    assert.ok(toolData.results.length >= 1, 'tool phải trả kết quả');
    assert.ok(toolData.results.every((result: any) => result.relativePath.startsWith('src/')), 'fileGlob phải giới hạn trong src/**');

    console.log('- Đang kiểm tra listPackageScripts helper...');
    const packageData = await listPackageScripts({ workspacePath: fixtureRoot });
    assert.strictEqual(packageData.packageManager, 'npm');
    assert.strictEqual(packageData.scripts.build, 'vite build');
    assert.strictEqual(packageData.dependenciesSummary.dependenciesCount, 2);
    assert.strictEqual(packageData.dependenciesSummary.devDependenciesCount, 1);
    assert.deepStrictEqual(packageData.dependenciesSummary.mainFrameworks.sort(), ['react', 'vite']);

    console.log('- Đang kiểm tra list_package_scripts tool registration...');
    const listTool = getTool('list_package_scripts');
    const listResult = await listTool.execute({ workspacePath: fixtureRoot });
    assert.strictEqual(listResult.isError, undefined, 'list_package_scripts không được báo lỗi');
    const listData = JSON.parse(listResult.content[0].text);
    assert.strictEqual(listData.packageJsonPath, path.join(fixtureRoot, 'package.json'));
    assert.strictEqual(listData.scripts.typecheck, 'tsc --noEmit');

    console.log('- Đang kiểm tra runPackageScript helper...');
    const runData = await runPackageScript({
      workspacePath: fixtureRoot,
      script: 'check',
      timeoutMs: 30000,
      maxOutputLines: 10
    });
    assert.strictEqual(runData.exitCode, 0);
    assert.strictEqual(runData.timedOut, false);
    assert.ok(runData.stdout.includes('fixture-check-pass'), 'phải trả stdout của script check');

    console.log('- Đang kiểm tra run_package_script tool và chặn script nguy hiểm...');
    const runTool = getTool('run_package_script');
    const runToolResult = await runTool.execute({ workspacePath: fixtureRoot, script: 'check', timeoutMs: 30000 });
    assert.strictEqual(runToolResult.isError, undefined, 'run_package_script không được báo lỗi với check');
    const blockedRun = await runTool.execute({ workspacePath: fixtureRoot, script: 'lint' });
    assert.strictEqual(blockedRun.isError, true, 'script chứa rm -rf phải bị chặn');
    const blockedRunData = JSON.parse(blockedRun.content[0].text);
    assert.ok(blockedRunData.error.includes('SCRIPT_NOT_ALLOWED'), 'lỗi phải báo SCRIPT_NOT_ALLOWED');

    console.log('- Đang kiểm tra projectProfile helper và tool...');
    const profile = await projectProfile({ workspacePath: fixtureRoot });
    assert.strictEqual(profile.framework, 'Vite React');
    assert.ok(profile.language.includes('TypeScript'), 'phải detect TypeScript');
    assert.strictEqual(profile.packageManager, 'npm');
    assert.ok(profile.likelyEntryPoints.includes('src/main.tsx'), 'phải detect entry point');
    const profileTool = getTool('project_profile');
    const profileToolResult = await profileTool.execute({ workspacePath: fixtureRoot });
    assert.strictEqual(profileToolResult.isError, undefined, 'project_profile không được báo lỗi');

    console.log('- Đang kiểm tra readManyFiles helper và tool...');
    const many = await readManyFiles({
      workspacePath: fixtureRoot,
      files: ['package.json', 'src/Hero.tsx', '.env', 'missing.ts'],
      includeLineNumbers: true
    });
    assert.strictEqual(many.files.length, 4);
    assert.strictEqual(many.files[0].ok, true);
    assert.ok(many.files[0].content?.startsWith('1: {'), 'phải thêm line numbers');
    assert.strictEqual(many.files[2].ok, false, '.env phải bị chặn theo từng file');
    assert.strictEqual(many.files[3].ok, false, 'file thiếu phải báo lỗi theo từng file');
    const readManyTool = getTool('read_many_files');
    const readManyToolResult = await readManyTool.execute({ workspacePath: fixtureRoot, files: ['src/Hero.tsx'] });
    assert.strictEqual(readManyToolResult.isError, undefined, 'read_many_files không được báo lỗi toàn cục');

    console.log('- Đang kiểm tra list_package_scripts khi thiếu package.json...');
    const missingDir = path.join(fixtureRoot, 'src');
    const missingResult = await listTool.execute({ workspacePath: missingDir });
    assert.strictEqual(missingResult.isError, true, 'phải báo lỗi khi thiếu package.json');

    console.log('Tất cả Unit Test cho Coding Context Tools đều đạt (PASSED) thành công!');
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('Unit test thất bại:', err);
  process.exit(1);
});

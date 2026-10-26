import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppendToFileTool,
  registerReplaceTextOnceTool,
  registerReadFileRangeTool,
  registerWriteTextFileTool
} from './directTextEdits.js';
import { getGitReviewSnapshot } from '../git/snapshot.js';

console.log('Starting Unit Tests for Direct Guarded Text Tools...');

const mockServer = new McpServer({
  name: "test-server",
  version: "1.0.0"
});

registerAppendToFileTool(mockServer);
registerReplaceTextOnceTool(mockServer);
registerReadFileRangeTool(mockServer);
registerWriteTextFileTool(mockServer);

function getTool(name: string) {
  const registeredTools = (mockServer as any)._registeredTools;
  const tool = registeredTools?.[name];
  if (!tool) {
    throw new Error(`Tool '${name}' not found on the server.`);
  }
  return {
    execute: async (args: any) => {
      return await tool.handler(args);
    }
  };
}

async function runTests() {
  const appendToFile = getTool('append_to_file');
  const replaceTextOnce = getTool('replace_text_once');
  const readFileRange = getTool('read_file_range');
  const writeTextFile = getTool('write_text_file');

  const testDir = path.resolve('scratch/test_edits');
  await fs.mkdir(testDir, { recursive: true });

  const tempFilePath = path.join(testDir, 'temp_test.txt');

  try {
    // ==========================================
    // 1. Testing WRITE_TEXT_FILE
    // ==========================================
    console.log('- Testing write_text_file...');
    
    // Test write new file
    await fs.rm(tempFilePath, { force: true });
    const writeResult1 = await writeTextFile.execute({
      filePath: tempFilePath,
      content: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
      overwrite: false,
      createParents: true
    });
    assert.strictEqual(writeResult1.isError, undefined);
    let writeData = JSON.parse(writeResult1.content[0].text);
    assert.strictEqual(writeData.success, true);
    assert.strictEqual(writeData.dryRun, false);

    // Test overwrite when overwrite is false -> must fail
    const writeResultFail = await writeTextFile.execute({
      filePath: tempFilePath,
      content: 'New Content',
      overwrite: false
    });
    assert.strictEqual(writeResultFail.isError, true);
    let failData = JSON.parse(writeResultFail.content[0].text);
    assert.strictEqual(failData.success, false);
    assert.ok(failData.error.includes('already exists'));

    // Test dryRun overwrite
    const writeDryRun = await writeTextFile.execute({
      filePath: tempFilePath,
      content: 'New Content',
      overwrite: true,
      dryRun: true
    });
    assert.strictEqual(writeDryRun.isError, undefined);
    let dryData = JSON.parse(writeDryRun.content[0].text);
    assert.strictEqual(dryData.success, true);
    assert.strictEqual(dryData.dryRun, true);
    
    // Verify file remains unmodified after dryRun
    const contentAfterDryRun = await fs.readFile(tempFilePath, 'utf-8');
    assert.strictEqual(contentAfterDryRun, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

    // Test overwrite true
    const writeOverwrite = await writeTextFile.execute({
      filePath: tempFilePath,
      content: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
      overwrite: true
    });
    assert.strictEqual(writeOverwrite.isError, undefined);
    assert.strictEqual(JSON.parse(writeOverwrite.content[0].text).success, true);

    // Test project config file restriction (package.json)
    const writeConfigFail = await writeTextFile.execute({
      filePath: path.resolve('package.json'),
      content: '{}',
      overwrite: true
    });
    assert.strictEqual(writeConfigFail.isError, true);
    assert.ok(JSON.parse(writeConfigFail.content[0].text).error.toLowerCase().includes('restricted'));

    // Test unsafe/unknown extension rejection (e.g. .sqlite3, .custom) -> must fail
    const unsafeFilePath = path.join(testDir, 'test_db.sqlite3');
    const writeUnsafeExt = await writeTextFile.execute({
      filePath: unsafeFilePath,
      content: 'Some data',
      overwrite: true
    });
    assert.strictEqual(writeUnsafeExt.isError, true);
    assert.ok(JSON.parse(writeUnsafeExt.content[0].text).error.toLowerCase().includes('safe text extension'));

    const writeNoExt = await writeTextFile.execute({
      filePath: path.join(testDir, 'extensionless_file'),
      content: 'Some data',
      overwrite: true
    });
    assert.strictEqual(writeNoExt.isError, true);
    assert.ok(JSON.parse(writeNoExt.content[0].text).error.toLowerCase().includes('safe text extension'));


    // ==========================================
    // 2. Testing APPEND_TO_FILE
    // ==========================================
    console.log('- Testing append_to_file...');

    // Test append to existing file
    const appendResult1 = await appendToFile.execute({
      filePath: tempFilePath,
      text: '\nLine 6'
    });
    assert.strictEqual(appendResult1.isError, undefined);
    let appendData = JSON.parse(appendResult1.content[0].text);
    assert.strictEqual(appendData.success, true);

    // Verify content appended
    let currentContent = await fs.readFile(tempFilePath, 'utf-8');
    assert.strictEqual(currentContent, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6');

    // Test append to non-existent file with createIfMissing false -> must fail
    const missingFilePath = path.join(testDir, 'missing_file.txt');
    const appendMissingFail = await appendToFile.execute({
      filePath: missingFilePath,
      text: 'Test',
      createIfMissing: false
    });
    assert.strictEqual(appendMissingFail.isError, true);
    assert.ok(JSON.parse(appendMissingFail.content[0].text).error.includes('does not exist'));

    // Test append to non-existent file with createIfMissing true -> success and creates file
    const appendMissingSuccess = await appendToFile.execute({
      filePath: missingFilePath,
      text: 'New File Created',
      createIfMissing: true
    });
    assert.strictEqual(appendMissingSuccess.isError, undefined);
    assert.strictEqual(JSON.parse(appendMissingSuccess.content[0].text).success, true);
    
    const missingContent = await fs.readFile(missingFilePath, 'utf-8');
    assert.strictEqual(missingContent, 'New File Created');
    await fs.rm(missingFilePath, { force: true });

    // Test append to unsafe extension -> must fail
    const appendUnsafeExt = await appendToFile.execute({
      filePath: unsafeFilePath,
      text: 'Append attempt',
      createIfMissing: true
    });
    assert.strictEqual(appendUnsafeExt.isError, true);
    assert.ok(JSON.parse(appendUnsafeExt.content[0].text).error.toLowerCase().includes('safe text extension'));


    // ==========================================
    // 3. Testing REPLACE_TEXT_ONCE
    // ==========================================
    console.log('- Testing replace_text_once...');

    await fs.writeFile(tempFilePath, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6', 'utf-8');

    // Test replace exactly once
    const replaceResult1 = await replaceTextOnce.execute({
      filePath: tempFilePath,
      findText: 'Line 3',
      replaceText: 'Line 3 Modified'
    });
    assert.strictEqual(replaceResult1.isError, undefined);
    assert.strictEqual(JSON.parse(replaceResult1.content[0].text).success, true);

    let replacedContent = await fs.readFile(tempFilePath, 'utf-8');
    assert.strictEqual(replacedContent, 'Line 1\nLine 2\nLine 3 Modified\nLine 4\nLine 5\nLine 6');

    // Test replace zero matches -> must fail
    const replaceResultZero = await replaceTextOnce.execute({
      filePath: tempFilePath,
      findText: 'Non-existent text',
      replaceText: 'Failure'
    });
    assert.strictEqual(replaceResultZero.isError, true);
    assert.ok(JSON.parse(replaceResultZero.content[0].text).error.includes('not found'));

    // Test replace multiple matches -> must fail
    await fs.writeFile(tempFilePath, 'Repeat\nLine 2\nRepeat', 'utf-8');
    const replaceResultMulti = await replaceTextOnce.execute({
      filePath: tempFilePath,
      findText: 'Repeat',
      replaceText: 'Change'
    });
    assert.strictEqual(replaceResultMulti.isError, true);
    assert.ok(JSON.parse(replaceResultMulti.content[0].text).error.includes('Multiple occurrences'));

    // Verify file remains unchanged after multi-match failure
    let contentAfterMultiFail = await fs.readFile(tempFilePath, 'utf-8');
    assert.strictEqual(contentAfterMultiFail, 'Repeat\nLine 2\nRepeat');

    // Test replace to unsafe extension -> must fail
    const replaceUnsafeExt = await replaceTextOnce.execute({
      filePath: unsafeFilePath,
      findText: 'Something',
      replaceText: 'Else'
    });
    assert.strictEqual(replaceUnsafeExt.isError, true);
    assert.ok(JSON.parse(replaceUnsafeExt.content[0].text).error.toLowerCase().includes('safe text extension'));


    // ==========================================
    // 4. Testing READ_FILE_RANGE
    // ==========================================
    console.log('- Testing read_file_range...');

    const baseContent = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join('\n');
    await fs.writeFile(tempFilePath, baseContent, 'utf-8');

    // Test read range (Line 3 to Line 7)
    const readRangeResult = await readFileRange.execute({
      filePath: tempFilePath,
      startLine: 3,
      endLine: 7
    });
    assert.strictEqual(readRangeResult.isError, undefined);
    let readRangeData = JSON.parse(readRangeResult.content[0].text);
    assert.strictEqual(readRangeData.success, true);
    assert.strictEqual(readRangeData.linesRead, 5);
    assert.strictEqual(readRangeData.isTruncated, false);
    assert.strictEqual(readRangeData.content, '3: Line 3\n4: Line 4\n5: Line 5\n6: Line 6\n7: Line 7');

    // Test startLine > endLine -> must fail
    const readRangeInvalid = await readFileRange.execute({
      filePath: tempFilePath,
      startLine: 5,
      endLine: 2
    });
    assert.strictEqual(readRangeInvalid.isError, true);
    assert.ok(JSON.parse(readRangeInvalid.content[0].text).error.toLowerCase().includes('invalid range'));

    // Test limit maxLines
    const readRangeMaxLines = await readFileRange.execute({
      filePath: tempFilePath,
      startLine: 3,
      endLine: 7,
      maxLines: 3
    });
    assert.strictEqual(readRangeMaxLines.isError, undefined);
    let readRangeMaxLinesData = JSON.parse(readRangeMaxLines.content[0].text);
    assert.strictEqual(readRangeMaxLinesData.success, true);
    assert.strictEqual(readRangeMaxLinesData.linesRead, 3);
    assert.strictEqual(readRangeMaxLinesData.isTruncated, true);
    assert.strictEqual(readRangeMaxLinesData.content, '3: Line 3\n4: Line 4\n5: Line 5');

    // Test limit maxBytes
    const readRangeMaxBytes = await readFileRange.execute({
      filePath: tempFilePath,
      startLine: 1,
      endLine: 10,
      maxBytes: 25
    });
    assert.strictEqual(readRangeMaxBytes.isError, undefined);
    let readRangeMaxBytesData = JSON.parse(readRangeMaxBytes.content[0].text);
    assert.strictEqual(readRangeMaxBytesData.success, true);
    assert.ok(readRangeMaxBytesData.linesRead < 10);
    assert.strictEqual(readRangeMaxBytesData.isTruncated, true);


    // =========================================================================
    // 5. Testing Large-File Append Behavior (Without reading entire large file)
    // =========================================================================
    console.log('- Testing append large-file behavior without reading entire file...');
    const largeFilePath = path.join(testDir, 'temp_large_file.txt');
    const chunk = 'This is a line of text that we will repeat to create a large file.\n';
    const repeats = 100000; // ~6.8 MB
    const largeContent = chunk.repeat(repeats);
    await fs.writeFile(largeFilePath, largeContent, 'utf-8');

    // Spy on fs.readFile
    const originalReadFile = fs.readFile;
    let readFileCalled = false;
    (fs as any).readFile = async (pathArg: any, optionsArg: any) => {
      if (typeof pathArg === 'string' && pathArg.includes('temp_large_file.txt')) {
        readFileCalled = true;
      }
      return originalReadFile.call(fs, pathArg, optionsArg);
    };

    try {
      const appendLargeResult = await appendToFile.execute({
        filePath: largeFilePath,
        text: 'The absolute end of the large file.'
      });
      assert.strictEqual(appendLargeResult.isError, undefined);
      const appendLargeData = JSON.parse(appendLargeResult.content[0].text);
      assert.strictEqual(appendLargeData.success, true);
      assert.strictEqual(readFileCalled, false, 'fs.readFile should not be called when appending to a large file');

      // Verify final file size has increased
      const finalStat = await fs.stat(largeFilePath);
      assert.strictEqual(finalStat.size, Buffer.byteLength(largeContent, 'utf-8') + Buffer.byteLength('The absolute end of the large file.', 'utf-8'));
    } finally {
      // Restore original fs.readFile
      (fs as any).readFile = originalReadFile;
      await fs.rm(largeFilePath, { force: true });
    }


    // ==========================================
    // 6. Testing Dry-Run for Append & Replace
    // ==========================================
    console.log('- Testing dry-run for append_to_file & replace_text_once...');
    const tempFileDryRun = path.join(testDir, 'temp_dry_run.txt');
    await fs.writeFile(tempFileDryRun, 'Original Content', 'utf-8');

    // Dry-run for append
    const appendDry = await appendToFile.execute({
      filePath: tempFileDryRun,
      text: '\nAppended Content',
      dryRun: true
    });
    assert.strictEqual(appendDry.isError, undefined);
    const appendDryData = JSON.parse(appendDry.content[0].text);
    assert.strictEqual(appendDryData.success, true);
    assert.strictEqual(appendDryData.dryRun, true);
    assert.strictEqual(await fs.readFile(tempFileDryRun, 'utf-8'), 'Original Content');

    // Dry-run for replace
    const replaceDry = await replaceTextOnce.execute({
      filePath: tempFileDryRun,
      findText: 'Original Content',
      replaceText: 'New Content',
      dryRun: true
    });
    assert.strictEqual(replaceDry.isError, undefined);
    const replaceDryData = JSON.parse(replaceDry.content[0].text);
    assert.strictEqual(replaceDryData.success, true);
    assert.strictEqual(replaceDryData.dryRun, true);
    assert.strictEqual(await fs.readFile(tempFileDryRun, 'utf-8'), 'Original Content');

    await fs.rm(tempFileDryRun, { force: true });


    // ==========================================
    // 7. Testing Missing File Errors
    // ==========================================
    console.log('- Testing missing file errors for replace & read_file_range...');
    const nonExistentFile = path.join(testDir, 'does_not_exist.txt');

    // Replace on non-existent file
    const replaceMissing = await replaceTextOnce.execute({
      filePath: nonExistentFile,
      findText: 'something',
      replaceText: 'other'
    });
    assert.strictEqual(replaceMissing.isError, true);
    assert.ok(JSON.parse(replaceMissing.content[0].text).error.includes('ENOENT') || JSON.parse(replaceMissing.content[0].text).error.includes('does not exist'));

    // Read range on non-existent file
    const readMissing = await readFileRange.execute({
      filePath: nonExistentFile,
      startLine: 1,
      endLine: 10
    });
    assert.strictEqual(readMissing.isError, true);
    assert.ok(JSON.parse(readMissing.content[0].text).error.includes('ENOENT') || JSON.parse(readMissing.content[0].text).error.includes('does not exist'));


    // =========================================================================
    // 8. Testing Extension Allowlist Rejection
    // =========================================================================
    console.log('- Testing extension allowlist rejection...');
    const invalidExtFile = path.join(testDir, 'temp_db.sqlite3');
    const binExtFile = path.join(testDir, 'temp_image.png');

    // Write on invalid extension
    const writeInvalidExt = await writeTextFile.execute({
      filePath: invalidExtFile,
      content: 'data',
      overwrite: true
    });
    assert.strictEqual(writeInvalidExt.isError, true);
    assert.ok(JSON.parse(writeInvalidExt.content[0].text).error.toLowerCase().includes('safe text extension'));

    // Append on invalid extension
    const appendInvalidExt = await appendToFile.execute({
      filePath: invalidExtFile,
      text: 'data',
      createIfMissing: true
    });
    assert.strictEqual(appendInvalidExt.isError, true);
    assert.ok(JSON.parse(appendInvalidExt.content[0].text).error.toLowerCase().includes('safe text extension'));

    // Replace on invalid extension
    const replaceInvalidExt = await replaceTextOnce.execute({
      filePath: invalidExtFile,
      findText: 'data',
      replaceText: 'new'
    });
    assert.strictEqual(replaceInvalidExt.isError, true);
    assert.ok(JSON.parse(replaceInvalidExt.content[0].text).error.toLowerCase().includes('safe text extension'));

    // Read range on binary extension (blocks via validatePathForRead)
    await fs.writeFile(binExtFile, 'Some fake text inside png');
    const readBinExt = await readFileRange.execute({
      filePath: binExtFile,
      startLine: 1,
      endLine: 5
    });
    assert.strictEqual(readBinExt.isError, true);
    assert.ok(JSON.parse(readBinExt.content[0].text).error.toLowerCase().includes('binary file'));
    await fs.rm(binExtFile, { force: true });


    // ==========================================
    // 9. Testing Path Traversal Rejection
    // ==========================================
    console.log('- Testing path traversal / outside-root rejection...');
    const outsideRootPath = path.resolve('C:\\Windows\\System32\\cmd.exe');

    // Write outside root
    const writeOutside = await writeTextFile.execute({
      filePath: outsideRootPath,
      content: 'test',
      overwrite: true
    });
    assert.strictEqual(writeOutside.isError, true);
    assert.ok(JSON.parse(writeOutside.content[0].text).error.toLowerCase().includes('outside configured workspace roots'));

    // Append outside root
    const appendOutside = await appendToFile.execute({
      filePath: outsideRootPath,
      text: 'test'
    });
    assert.strictEqual(appendOutside.isError, true);
    assert.ok(JSON.parse(appendOutside.content[0].text).error.toLowerCase().includes('outside configured workspace roots'));

    // Replace outside root
    const replaceOutside = await replaceTextOnce.execute({
      filePath: outsideRootPath,
      findText: 'test',
      replaceText: 'new'
    });
    assert.strictEqual(replaceOutside.isError, true);
    assert.ok(JSON.parse(replaceOutside.content[0].text).error.toLowerCase().includes('outside configured workspace roots'));

    // Read range outside root
    const readOutside = await readFileRange.execute({
      filePath: outsideRootPath,
      startLine: 1,
      endLine: 10
    });
    assert.strictEqual(readOutside.isError, true);
    assert.ok(JSON.parse(readOutside.content[0].text).error.toLowerCase().includes('outside configured workspace roots'));


    // =========================================================================
    // 10. Testing Binary Content Rejection for Existing Files
    // =========================================================================
    console.log('- Testing binary content rejection for existing files...');
    const binaryContentFile = path.join(testDir, 'temp_binary_content.txt'); // safe extension, binary content
    const binaryData = Buffer.from([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100]); // "Hello\0World"
    await fs.writeFile(binaryContentFile, binaryData);

    // Append on binary content file -> must fail
    const appendBinContent = await appendToFile.execute({
      filePath: binaryContentFile,
      text: 'append'
    });
    assert.strictEqual(appendBinContent.isError, true);
    assert.ok(JSON.parse(appendBinContent.content[0].text).error.includes('Binary content detected'));

    // Replace on binary content file -> must fail
    const replaceBinContent = await replaceTextOnce.execute({
      filePath: binaryContentFile,
      findText: 'Hello',
      replaceText: 'Hi'
    });
    assert.strictEqual(replaceBinContent.isError, true);
    assert.ok(JSON.parse(replaceBinContent.content[0].text).error.includes('Binary content detected'));

    // Read range on binary content file -> must fail
    const readBinContent = await readFileRange.execute({
      filePath: binaryContentFile,
      startLine: 1,
      endLine: 5
    });
    assert.strictEqual(readBinContent.isError, true);
    assert.ok(JSON.parse(readBinContent.content[0].text).error.includes('Binary content detected'));

    // Write overwrite on binary content file -> must fail
    const writeBinContent = await writeTextFile.execute({
      filePath: binaryContentFile,
      content: 'new text content',
      overwrite: true
    });
    assert.strictEqual(writeBinContent.isError, true);
    assert.ok(JSON.parse(writeBinContent.content[0].text).error.includes('Cannot overwrite a binary file'));

    await fs.rm(binaryContentFile, { force: true });


    // =========================================================================
    // 11. Testing Git Review Snapshot from Test Fixture
    // =========================================================================
    console.log('- Testing Git Review Snapshot from test fixture...');
    const gitTestDir = path.resolve('scratch/test_edits_git');
    await fs.mkdir(gitTestDir, { recursive: true });
    try {
      execSync('git init', { cwd: gitTestDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: gitTestDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: gitTestDir, stdio: 'ignore' });

      const sampleFile = path.join(gitTestDir, 'sample_git.txt');
      await fs.writeFile(sampleFile, 'Original Line 1\nOriginal Line 2\nOriginal Line 3\n', 'utf-8');

      execSync('git add sample_git.txt', { cwd: gitTestDir, stdio: 'ignore' });
      execSync('git commit -m "initial commit"', {
        cwd: gitTestDir,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com'
        }
      });

      // Modify the file using replaceTextOnce
      const replaceGitFile = await replaceTextOnce.execute({
        filePath: sampleFile,
        findText: 'Original Line 2',
        replaceText: 'Modified Line 2'
      });
      assert.strictEqual(replaceGitFile.isError, undefined);

      // Generate snapshot
      const snapshot = await getGitReviewSnapshot(gitTestDir);
      assert.ok(snapshot.changedFiles.includes('sample_git.txt'), 'Changed files should include sample_git.txt');
      assert.ok(snapshot.status.includes('M sample_git.txt') || snapshot.status.includes('M  sample_git.txt'), 'Status should contain M sample_git.txt');
      assert.ok(snapshot.diffStat.includes('sample_git.txt'), 'diffStat should contain sample_git.txt');

      console.log('Deterministic Git Review Snapshot verified successfully.');
    } finally {
      await fs.rm(gitTestDir, { recursive: true, force: true });
    }

  } finally {
    await fs.rm(tempFilePath, { force: true });
    await fs.rm(testDir, { recursive: true, force: true });
  }

  console.log('All Unit Tests for Direct Guarded Text Tools Passed Successfully!');
}

runTests().catch((err) => {
  console.error('Unit test execution failed:', err);
  process.exit(1);
});

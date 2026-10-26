import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createJob, getJob, updateJob } from './registry.js';
import { checkAndUpdateStaleJob, isProcessRunning, STALE_THRESHOLD_MS, startAntigravityTask, waitForJobCompletion, cancelAntigravityJob, isAntigravityJobStale, getAntigravityLastError } from './task.js';

console.log('Bắt đầu chạy Unit Test cho Job Stale, Timeout & Process Cleanup...');

async function runTests() {
  // Test case 1: Job đang chạy bình thường với tiến trình còn sống và heartbeat mới
  console.log('- Đang kiểm tra job bình thường (không stale)...');
  const job1 = createJob('Gemini 3.5 Flash (Medium)', 'test-prompt-1', 60, './logs/test1.log', '.');
  updateJob(job1.id, { pid: process.pid });
  
  const updatedJob1 = getJob(job1.id)!;
  const isStale1 = await checkAndUpdateStaleJob(updatedJob1);
  assert.strictEqual(isStale1, false, 'Job có PID đang chạy và heartbeat mới không được coi là stale');
  const checkedJob1 = getJob(job1.id);
  assert.strictEqual(checkedJob1?.status, 'running', 'Status của job phải là running');

  // Test case 2: Job có process bị mất (gone)
  console.log('- Đang kiểm tra job có process không tồn tại (process gone)...');
  const job2 = createJob('Gemini 3.5 Flash (Medium)', 'test-prompt-2', 60, './logs/test2.log', '.');
  updateJob(job2.id, { pid: 99999 });
  
  const updatedJob2 = getJob(job2.id)!;
  const isStale2 = await checkAndUpdateStaleJob(updatedJob2);
  assert.strictEqual(isStale2, true, 'Job có PID không chạy nữa phải được chuyển thành stale');
  const checkedJob2 = getJob(job2.id);
  assert.strictEqual(checkedJob2?.status, 'stale', 'Status của job phải chuyển sang stale');
  assert.ok(checkedJob2?.error?.includes('is no longer running'), 'Lỗi phải báo process is no longer running');

  // Test case 3: Job bị đơ heartbeat (heartbeat stale) nhưng process vẫn chạy
  console.log('- Đang kiểm tra job bị stale do thiếu heartbeat (heartbeat stale)...');
  const job3 = createJob('Gemini 3.5 Flash (Medium)', 'test-prompt-3', 60, './logs/test3.log', '.');
  
  // Spawn một dummy child process chạy ngầm để có một PID thực sự đang chạy
  const dummyProcess = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
    shell: false,
    detached: true
  });
  
  // Đảm bảo dummyProcess đã start và có PID
  assert.ok(dummyProcess.pid, 'Dummy process phải được spawn thành công');
  
  updateJob(job3.id, {
    pid: dummyProcess.pid,
    // Đặt lastSeenAt lùi về quá khứ 3 phút trước
    lastSeenAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 60000)).toISOString()
  });

  const updatedJob3 = getJob(job3.id)!;
  const isStale3 = await checkAndUpdateStaleJob(updatedJob3);
  assert.strictEqual(isStale3, true, 'Job có heartbeat quá cũ phải chuyển thành stale');
  const checkedJob3 = getJob(job3.id);
  assert.strictEqual(checkedJob3?.status, 'stale', 'Status của job phải chuyển sang stale');
  assert.ok(checkedJob3?.error?.includes('no progress/heartbeat'), 'Lỗi phải báo lack of heartbeat');

  // Kiểm tra xem dummy process đã bị dọn dẹp (killed) bởi hàm checkAndUpdateStaleJob chưa
  // Đợi 2 giây để process cleanup hoàn thành
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const processStillRunning = isProcessRunning(dummyProcess.pid);
  assert.strictEqual(processStillRunning, false, 'Dummy process tree phải được dọn dẹp sạch sẽ sau khi job bị stale');
  console.log('  -> Dummy process đã bị kill thành công!');

  // Test case 4: Gọi startAntigravityTask thực sự với timeout ngắn (2s) để kích hoạt cơ chế timeout thực tế của agy.exe
  console.log('- Đang kiểm tra cơ chế timeout thực tế của startAntigravityTask...');
  
  const job4 = await startAntigravityTask({
    model: 'Gemini 3.5 Flash (Medium)',
    prompt: 'Hãy thực hiện phân tích cấu trúc dự án hiện tại một cách ngắn gọn.',
    timeout: 2, // 2 giây
    workspacePath: 'C:\\Users\\ExampleUser\\Documents\\mcp-antigravity-bridge'
  });
  
  assert.ok(job4.id, 'Phải tạo được job ID');
  assert.strictEqual(job4.status, 'running', 'Job mới start phải ở trạng thái running');
  
  // Đợi job close (timeout trigger)
  // Vì timeout là 2s, ta đợi tối đa 5s để xem trạng thái cuối cùng
  console.log('  -> Đang đợi job timeout (khoảng 5 giây)...');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  
  const checkedJob4 = getJob(job4.id);
  console.log(`  -> Trạng thái cuối của job timeout thực tế: ${checkedJob4?.status}`);
  assert.strictEqual(checkedJob4?.status, 'timeout', 'Job phải chuyển thành trạng thái timeout sau khi hết thời gian');
  assert.ok(checkedJob4?.error?.includes('timed out'), 'Tin nhắn lỗi phải chứa thông tin timeout');
  
  if (checkedJob4?.pid) {
    const isRunning = isProcessRunning(checkedJob4.pid);
    assert.strictEqual(isRunning, false, 'Tiến trình agy.exe bị timeout phải được dọn dẹp sạch sẽ khỏi hệ thống');
    console.log('  -> Tiến trình agy.exe đã được dọn dẹp sạch sẽ thành công!');
  }

  // Test case 5: cancelAntigravityJob
  console.log('- Checking cancelAntigravityJob...');
  const job5 = createJob('Gemini 3.5 Flash (Medium)', 'test-cancel-prompt', 60, './logs/test5.log', '.');
  const dummyCancelProc = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { shell: false });
  assert.ok(dummyCancelProc.pid, 'Dummy cancel process should spawn successfully');
  updateJob(job5.id, { pid: dummyCancelProc.pid });

  const cancelSummary = await cancelAntigravityJob(job5.id);
  assert.strictEqual(cancelSummary.status, 'cancelled', 'Job status after cancel should be cancelled');
  assert.strictEqual(cancelSummary.exitCode, null, 'Exit code after cancel should be null');
  assert.ok(cancelSummary.durationMs !== undefined && typeof cancelSummary.durationMs === 'number', 'durationMs should be present');
  assert.ok(cancelSummary.duration !== undefined && typeof cancelSummary.duration === 'string', 'duration should be present');
  assert.ok(Array.isArray(cancelSummary.changedFiles), 'changedFiles should be an array');
  assert.ok(typeof cancelSummary.lastLogLines === 'string', 'lastLogLines should be a string');

  // Wait for process tree cleanup to complete
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const cancelProcRunning = isProcessRunning(dummyCancelProc.pid);
  assert.strictEqual(cancelProcRunning, false, 'Cancel process should be killed');
  console.log('  -> cancelAntigravityJob works correctly!');

  // Test case 6: waitForJobCompletion
  console.log('- Checking waitForJobCompletion...');
  const job6 = createJob('Gemini 3.5 Flash (Medium)', 'test-wait-prompt', 60, './logs/test6.log', '.');
  // Schedule job6 to complete after 1.5 seconds
  setTimeout(() => {
    updateJob(job6.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      exitCode: 0
    });
  }, 1500);

  const waitStart = Date.now();
  const waitResult = await waitForJobCompletion(job6.id, 5000, 500);
  const waitDuration = Date.now() - waitStart;

  assert.strictEqual(waitResult.waitStatus, 'completed', 'Wait status should be completed');
  assert.strictEqual(waitResult.timedOut, false, 'timedOut should be false');
  assert.strictEqual(waitResult.job.status, 'completed', 'Job status should be completed');
  assert.strictEqual(waitResult.job.exitCode, 0, 'Exit code should be 0');
  assert.ok(waitDuration < 4000, 'waitForJobCompletion should return early when job completes');
  console.log(`  -> waitForJobCompletion finished in ${waitDuration}ms (as expected)`);

  // Test case 7: isAntigravityJobStale (custom threshold)
  console.log('- Checking isAntigravityJobStale with custom threshold...');
  const job7 = createJob('Gemini 3.5 Flash (Medium)', 'test-stale-custom-prompt', 60, './logs/test7.log', '.');
  const dummyStaleProc = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { shell: false });
  assert.ok(dummyStaleProc.pid, 'Dummy stale process should spawn');
  updateJob(job7.id, {
    pid: dummyStaleProc.pid,
    // Heartbeat from 20 seconds ago
    lastSeenAt: new Date(Date.now() - 20000).toISOString()
  });

  // Call isAntigravityJobStale with 10 seconds threshold (staleAfterMs = 10000)
  const isStaleCustom = await isAntigravityJobStale(job7.id, 10000);
  assert.strictEqual(isStaleCustom, true, 'Job with heartbeat older than staleAfterMs should be stale');
  const checkedJob7 = getJob(job7.id);
  assert.strictEqual(checkedJob7?.status, 'stale', 'Registry status should be updated to stale');
  
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const staleProcRunning = isProcessRunning(dummyStaleProc.pid);
  assert.strictEqual(staleProcRunning, false, 'Stale process should be cleaned up');
  console.log('  -> isAntigravityJobStale works correctly!');

  // Test case 8: getAntigravityLastError
  console.log('- Checking getAntigravityLastError...');
  const job8 = createJob('Gemini 3.5 Flash (Medium)', 'test-error-prompt', 60, './logs/test8.log', '.');
  const secretError = 'API_KEY="sk-123456" failed connection';
  updateJob(job8.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: secretError
  });

  const specificErrorResult = getAntigravityLastError(job8.id);
  assert.strictEqual(specificErrorResult.jobId, job8.id, 'Job ID should match');
  assert.ok(specificErrorResult.error !== undefined, 'Error message should be returned');
  assert.ok(!specificErrorResult.error.includes('sk-123456'), 'Error message must be redacted');

  const generalErrorResult = getAntigravityLastError();
  assert.strictEqual(generalErrorResult.jobId, job8.id, 'Should return the most recent failed job error');
  assert.ok(generalErrorResult.error !== undefined);
  assert.ok(!generalErrorResult.error.includes('sk-123456'));
  console.log('  -> getAntigravityLastError works correctly!');

  // Test case 9: waitForJobCompletion wait timeout behavior
  console.log('- Checking waitForJobCompletion wait timeout behavior...');
  const job9 = createJob('Gemini 3.5 Flash (Medium)', 'test-wait-timeout-prompt', 60, './logs/test9.log', '.');
  
  const timeoutStart = Date.now();
  const timeoutResult = await waitForJobCompletion(job9.id, 1500, 500);
  const timeoutDuration = Date.now() - timeoutStart;

  assert.strictEqual(timeoutResult.waitStatus, 'timeout', 'Wait status must be timeout when bounded wait expires');
  assert.strictEqual(timeoutResult.timedOut, true, 'timedOut flag must be true');
  assert.strictEqual(timeoutResult.job.status, 'running', 'Job itself must still be running');
  assert.ok(timeoutDuration >= 1000, 'Wait duration should be close to wait timeout');
  console.log(`  -> waitForJobCompletion wait timeout behavior verified in ${timeoutDuration}ms`);

  console.log('Tất cả các Unit Test cho Job Stale, Timeout & Process Cleanup đều đạt (PASSED) thành công!');
}

runTests().catch((error) => {
  console.error('Unit Test stale/timeout/cleanup failed:', error);
  process.exit(1);
});

# MCP Workstation Bridge

MCP server cho Windows: đọc/sửa file có kiểm soát, Git, kiểm tra dự án, PowerShell và thao tác desktop. Dùng với client/CLI hỗ trợ MCP Streamable HTTP. Node CLI đi kèm quản lý dịch vụ và tự chạy lại khi tiến trình lỗi.

## Cài đặt

Yêu cầu Windows 10/11, Node.js 22 trở lên, npm và Git. Chạy bằng tài khoản Windows thông thường. Antigravity (`agy`) là tùy chọn; không cần cho các công cụ file/Git/desktop.

```powershell
git clone https://github.com/Anpham9x/mcp-workstation-bridge.git
cd mcp-workstation-bridge
npm ci
npm run typecheck
npm run build
npm run bridge -- start
npm run check:local
```

`start` chạy nền. Dùng `npm run bridge -- status`, `npm run bridge -- restart`, `npm run bridge -- stop` để điều khiển. Chỉ CLI này quản lý tiến trình do chính nó tạo; không giết tiến trình khác đang chiếm cổng. `status` báo trạng thái tiến trình; `check:local` mới kiểm tra giao thức MCP và danh mục công cụ.

## Kết nối CLI AI

Ví dụ với Claude Code đã cài và đăng nhập trên cùng máy:

```powershell
claude mcp add --transport http workstation http://127.0.0.1:3011/mcp
claude mcp get workstation
```

Trong phiên Claude Code, dùng `/mcp` để xem kết nối. Cú pháp theo [tài liệu MCP chính thức của Claude Code](https://code.claude.com/docs/en/mcp). Bridge đã được kiểm thử bằng giao thức MCP; ví dụ Claude Code được đối chiếu tài liệu, chưa kiểm thử E2E bằng tài khoản Claude.

Các CLI/client khác cần hỗ trợ **MCP Streamable HTTP** và URL `http://127.0.0.1:3011/mcp`. Cấu hình chính xác tùy client; ví dụ JSON mô tả:

```json
{"mcpServers":{"workstation":{"type":"http","url":"http://127.0.0.1:3011/mcp"}}}
```

Đây là ví dụ mô tả, không phải file cấu hình dùng chung cho mọi CLI. Các client chỉ hỗ trợ stdio cần adapter riêng. CLI quản lý dịch vụ ở trên là công cụ Node có sẵn trong repo và chạy được không cần AI.

## Cấu hình máy riêng

Tạo `.env` tại thư mục repo nếu cần. CLI tự đọc file này; không đưa file lên GitHub.

```dotenv
PORT=3011
MCP_WORKSPACE_ROOTS=C:\Projects\my-project;D:\Work\another-project
```

Mặc định chỉ cho phép thư mục repo hiện tại. Dùng đường dẫn tuyệt đối; nhiều root cách nhau bằng dấu `;` trên Windows. Nếu đổi `PORT`, chạy kiểm tra với `$env:MCP_LOCAL_URL = 'http://127.0.0.1:PORT_MOI/mcp'` trước `npm run check:local`. Sửa `.env` khi supervisor đang chạy: `stop`, rồi `start` để nạp lại cấu hình.

Không có owner policy được đóng gói: quyền owner luôn tắt mặc định. Một số công cụ ghi/thực thi yêu cầu grant theo dự án và có thể trả `AUTHORIZATION_REQUIRED`; xem `src/reliability/policy.ts` và `src/tools/projectBootstrap.ts`. Việc kết nối MCP không đồng nghĩa tự cấp quyền ghi mọi nơi. PowerShell local yêu cầu xác nhận tại máy; không có sandbox filesystem cho lệnh PowerShell tùy ý.

## Tự kích hoạt lại

Khi server con thoát, supervisor thử chạy lại với khoảng chờ tăng dần, tối đa 30 giây. Nhật ký: `logs/supervisor.log`. Nếu chính supervisor bị tắt, có thể dùng Windows Task Scheduler để khôi phục:

```powershell
npm run autostart:install
```

Tác vụ chạy lúc tài khoản hiện tại đăng nhập và kiểm tra mỗi 5 phút, ở quyền thường, trong phiên desktop tương tác. Không chạy trước khi đăng nhập, không tự mở khóa máy và không phát hiện mọi trường hợp server bị treo. Windows có thể yêu cầu quyền tạo Scheduled Task; nếu bị từ chối, tiếp tục dùng CLI thủ công hoặc nhờ quản trị viên cho phép tác vụ của tài khoản hiện tại.

Gỡ bằng `npm run autostart:remove`. Khi watchdog còn bật, `stop` chỉ dừng tạm thời, watchdog sẽ khởi động lại; muốn dừng hẳn, gỡ autostart rồi `stop`. Sau khi di chuyển thư mục hoặc đổi đường dẫn Node, gỡ tác vụ cũ tại thư mục cũ trước, rồi cài lại.

## Quyền riêng tư và remote

Bản nguồn không chứa ảnh cá nhân, logs, token, danh tính OAuth, chính sách owner hay lịch sử repo gốc. Mỗi máy tự tạo dữ liệu runtime trong `.ai`, `.runtime`, `logs` (đều được Git bỏ qua). Đọc [SECURITY.md](SECURITY.md) trước khi sử dụng.

Chế độ mặc định chỉ dành cho máy local. Không đưa cổng này ra Internet. Muốn dùng remote phải tự thiết lập HTTPS + OAuth riêng theo `src/security/oauth.ts`; không dùng endpoint hoặc tài khoản của người chia sẻ repo.

## Kiểm tra và xử lý lỗi

- `npm run typecheck` và `npm run build`: kiểm tra/biên dịch nguồn.
- `npm run check:local`: kiểm tra MCP initialize và tools/list (50 tools ở local mode).
- `node scripts/cli.test.mjs`: kiểm thử start/restart/stop, tự phục hồi và bảo vệ cổng trên cổng thử riêng; hãy dừng CLI đang chạy trong bản repo này trước khi chạy test.
- Cổng bị chiếm: dừng dịch vụ của bạn đang sử dụng cổng đó hoặc chọn `PORT` khác; CLI không tự giết tiến trình lạ.
- `start` thất bại: xem `logs/supervisor.log`; kiểm tra Node, build và cấu hình `.env`.
- Không chia sẻ `.env`, `.ai`, `.runtime`, ảnh chụp màn hình hay logs chưa rà soát.

Không chạy toàn bộ các test lịch sử một cách mù quáng: một số suite thao tác Git, file, PowerShell hoặc desktop thật. Chạy từng suite sau khi xem fixture và phạm vi của nó.

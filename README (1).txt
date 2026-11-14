YUNO BABYBU — MINECRAFT BOT DASHBOARD

Cài đặt:
1. Giải nén ZIP.
2. Đưa toàn bộ nội dung vào GitHub repository.
3. Cài Node.js 22 trở lên.
4. Chạy npm install, sau đó npm start.

Biến môi trường nên cấu hình trên hosting:
- BOT_HOST=vangioinetwork
- BOT_PORT=25565
- BOT_USERNAME=tên tài khoản Minecraft
- BOT_PASSWORD=mật khẩu server nếu server yêu cầu /l
- PORT=10000 (hosting thường tự cấp PORT)

Lưu ý:
- Dashboard hiện không có đăng nhập. Chỉ triển khai trên hosting riêng/tin cậy.
- Nếu không đặt BOT_PASSWORD, bot sẽ không tự gửi lệnh /l.
- Hình đại diện và hình nền của dashboard được nhúng trực tiếp trong index.js.

🎮 Điều Khiển Bot:
- Có nút bật bot, tắt bot, kết nối lại, xóa nhật ký lỗi.
- Lệnh /tusat là nút riêng, không còn gắn với Ô 1 và không chạy theo chu kỳ hotbar.
- Nút Túi Đồ gửi lệnh [inv] vào máy chủ.
- Thanh Công Cụ (Ô 1–9) nằm trong danh mục 🎮 Điều Khiển Bot. Chọn các ô muốn luân chuyển và thời gian giữ mỗi ô.

Quỳ Lạy tự động: /quylay được gửi mỗi 15 giây khi bật.

Công Pháp tự động:
- Công Pháp 1: /fightingskill_1, chu kỳ 5 giây.
- Công Pháp 2: /fightingskill_2, chu kỳ 15 giây.
- Công Pháp 3: /fightingskill_3, chu kỳ 40 giây.
Bật/tắt từng công pháp trong mục 🎮 Điều Khiển Bot > Công Pháp & Kỹ Năng.

Chế độ kết nối và tự kết nối lại:
- Dashboard chỉ kết nối Minecraft khi cấu hình được lưu và cấp quyền kết nối.
- Nhập tên nhân vật, mật khẩu và IP server, sau đó nhấn “Lưu Cấu Hình & Tải Kết Nối Ngay”.
- Lần đầu mở trang, Tên nhân vật mặc định là YunoBabybu và Server là vangioinetwork; mật khẩu chưa được cung cấp nên ô mật khẩu hiển thị dấu chấm gợi ý, không phải mật khẩu mặc định.
- Sau khi nhập mật khẩu thật và nhấn Lưu Cấu Hình, username/password/host/port được lưu trong bot-config.json. Khi Minecraft văng, ping timeout hoặc server reset, tiến trình reconnect không xóa file cấu hình này.
- Khi đổi tài khoản, nhập username mới và mật khẩu mới rồi nhấn Lưu Cấu Hình. Nếu chỉ muốn giữ mật khẩu cũ, để trống ô mật khẩu.
- Trên Render, filesystem mặc định có thể bị làm mới khi redeploy. Để giữ bot-config.json qua redeploy, gắn Persistent Disk và đặt BOT_CONFIG_FILE trỏ vào thư mục trên disk; hoặc dùng Environment Variables cho thông tin đăng nhập.
- Nếu dùng Render Persistent Disk, mount disk tại `/var/data` và đặt biến môi trường `BOT_CONFIG_FILE=/var/data/bot-config.json` để giữ cả tài khoản và mật khẩu qua redeploy.
- Trên trang Cài Đặt, mật khẩu đã lưu không hiển thị lại vì lý do bảo mật; ô mật khẩu sẽ báo đã lưu. Để trống khi lưu lần sau sẽ giữ nguyên mật khẩu cũ.
- Mật khẩu trong bot-config.json được lưu dạng văn bản; không commit file này lên GitHub công khai. Ưu tiên dùng Environment Variables và bảo vệ Dashboard.
- Nút TẮT BOT thủ công vẫn là lệnh dừng có chủ ý; bật lại sẽ kết nối lại.

Thiền: Khi bật/tắt sẽ gửi lệnh /thien; khi bot kết nối lại và Thiền đang bật, bot cũng gửi /thien một lần. Dashboard ghi lại lệnh đã gửi; cần xem phản hồi trong nhật ký chat để xác nhận server chấp nhận.

CẬP NHẬT TỰ KẾT NỐI LẠI:
- Theo dõi ping mỗi 5 giây; ping >= 2500ms được ghi cảnh báo. Ping cao một mình không làm bot reconnect.
- Theo dõi world packet; nếu server không cập nhật quá 90 giây, watchdog sẽ reconnect.
- Socket/client error, socket close/end/timeout, Mineflayer end/kicked đều kích hoạt reconnect có chống gọi lặp.
- Khi vào lại game: tự gửi /l nếu có mật khẩu, sau đó khôi phục các tính năng đang bật và Hotbar.
- Trạng thái toggle, Hotbar và tốc độ click được lưu trong bot-config.json, vì vậy có thể khôi phục sau khi tắt/bật bot hoặc tiến trình khởi động lại.
- Muốn giữ file cấu hình qua Render redeploy, dùng Persistent Disk và đặt BOT_CONFIG_FILE=/var/data/bot-config.json.
- Nút TẮT BOT thủ công vẫn vô hiệu hóa reconnect cho đến khi người dùng bật lại.

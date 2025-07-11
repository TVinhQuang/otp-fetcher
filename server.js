// server.js

// ✨ 1. Load biến môi trường từ .env
require('dotenv').config();                 
//   • process.env.EMAIL, process.env.PASS sẽ được nạp

// —— TEST ENVIRONMENT ——
console.log('=== ENVIRONMENT VARIABLES ===');
console.log('EMAIL =', process.env.EMAIL);
console.log('PASS  =', process.env.PASS);
console.log('=============================')
// ————————————————

// ✨ 2. Import các thư viện cần thiết
const express      = require('express');     // Web framework
const path = require('path');        // ✔️ Dùng để xử lý đường dẫn cho an toàn
const bodyParser   = require('body-parser'); // Để parse JSON và form data
const imaps        = require('imap-simple'); // Kết nối IMAP
const { simpleParser } = require('mailparser'); // Parse MIME email

// ✨ 3. Tạo app Express
const app = express();

// Dùng path.join để đảm bảo Express tìm đúng thư mục 'public'
app.use(express.static(path.join(__dirname, 'public')));                           

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ✨ 5. Route test GET cơ bản
app.get('/', (req, res) => {
  res.send('OTP Fetcher is running. POST /get-otp để lấy mã.');
});

// 2) Sau đó, nếu vẫn muốn GET / trả index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✨ 6. Route POST /get-otp
app.post('/get-otp', async (req, res) => {
  // 6.1. Nhận email & password từ body (có thể bỏ nếu dùng ENV cứng)
  const email    = req.body.email    || process.env.EMAIL;
  const password = req.body.password || process.env.PASS;

  // 6.2. Cấu hình IMAP
  const config = {
    imap: {
      user:       email,            
      password:   password,         
      host:       'imap.gmail.com', 
      port:       993,              
      tls:        true,             
      authTimeout: 10000,
      tlsOptions: {                  // ← thêm cái này
        rejectUnauthorized: false    // cho phép self-signed certs
      }             
    }
  };

  try {
    // 6.3. Kết nối IMAP
    const connection = await imaps.connect(config);

    // 6.4. Mở mailbox INBOX
    await connection.openBox('INBOX');

    // 6.5. Đặt khoảng thời gian tìm kiếm (5 phút gần nhất)
    const delay      = 5 * 60 * 1000;              // ms
    const since      = new Date(Date.now() - delay);
    const searchCriteria = [
      'UNSEEN',                                   // chỉ mail chưa đọc
      ['SINCE', since.toISOString()]              // gửi sau `since`
    ];
    const fetchOptions = { bodies: [''] };        // lấy toàn bộ body

    // 6.6. Thực hiện tìm kiếm
    const messages = await connection.search(searchCriteria, fetchOptions);

    // 6.7. Duyệt qua mail, parse và tìm OTP
    for (let item of messages) {
      const raw  = item.parts.find(p => p.which === '').body;
      const parsed = await simpleParser(raw);     // tách text/plain
      const text   = parsed.text || '';

      // Regex tìm 6 chữ số liên tiếp
      const match  = text.match(/\b\d{6}\b/);
      if (match) {
        await connection.end();                   // đóng kết nối IMAP
        return res.json({ otp: match[0] });       // trả về JSON
      }
    }

    // 6.8. Nếu không tìm thấy
    await connection.end();
    return res.status(404).json({ error: 'Không tìm thấy mã OTP mới.' });

     } catch (err) {
    console.error('==== CHI TIẾT LỖI IMAP / MAIL ====');
    console.error(err);
    console.error('===================================');
    // Trả nguyên message lỗi về client để debug (sau khi sửa xong bạn nên đổi lại như ban đầu)
    return res.status(500).json({ error: err.message });
  }
});

// ✨ 7. Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

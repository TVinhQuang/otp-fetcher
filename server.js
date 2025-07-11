// server.js

// ✨ 1. Load biến môi trường từ .env
require('dotenv').config();                 
//   • process.env.EMAIL, process.env.PASS sẽ được nạp

// // —— TEST ENVIRONMENT ——
// console.log('=== ENVIRONMENT VARIABLES ===');
// console.log('EMAIL =', process.env.EMAIL);
// console.log('PASS  =', process.env.PASS);
// console.log('=============================')
// // ————————————————

// ✨ 2. Import các thư viện cần thiết
const express      = require('express');     // Web framework
const path = require('path');        // ✔️ Dùng để xử lý đường dẫn cho an toàn
const bodyParser   = require('body-parser'); // Để parse JSON và form data
const imaps        = require('imap-simple'); // Kết nối IMAP
const { simpleParser } = require('mailparser'); // Parse MIME email

// Lấy CREDENTIALS từ env, parse JSON
const credentials = JSON.parse(process.env.CREDENTIALS || '{}');

// ✨ 3. Tạo app Express
const app = express();

// Dùng path.join để đảm bảo Express tìm đúng thư mục 'public'
app.use(express.static(path.join(__dirname, 'public')));                           

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// 2) Sau đó, nếu vẫn muốn GET / trả index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✨ 6. Route POST /get-otp
app.post('/get-otp', async (req, res) => {
  // 6.1. Nhận email & password từ body (có thể bỏ nếu dùng ENV cứng)
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Thiếu email.' });
  }

  const password = credentials[email];
  if (!password) {
    return res.status(400).json({ error: 'Email này không được hỗ trợ.' });
  }

  // detect IMAP host dựa vào domain
  function getImapHost(email) {
    const domain = email.split('@')[1].toLowerCase();
    switch (domain) {
      case 'gmail.com':
        return { host: 'imap.gmail.com', port: 993, tls: true };
      case 'yahoo.com':
        return { host: 'imap.mail.yahoo.com', port: 993, tls: true };
      case 'outlook.com':
      case 'hotmail.com':
        return { host: 'imap-mail.outlook.com', port: 993, tls: true };
      default:
        throw new Error('Chưa hỗ trợ nhà cung cấp này.');
    }
  }

  let cfg;
  try {
    hostCfg = getImapHost(email);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // 6.2. Cấu hình IMAP
  const config = {
    imap: {
      user:       email,            
      password:   password,         
      host:       hostCfg.host,
      port:       hostCfg.port,            
      tls:        hostCfg.tls,           
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

   // 1. Nếu không có message nào thì trả về lỗi
    if (!messages || messages.length === 0) {
      await connection.end();
      return res.status(404).json({ error: 'Không tìm thấy mã OTP mới.' });
    }

    // 2. Sắp xếp messages theo internalDate (hoặc attributes.date) giảm dần
    messages.sort((a, b) => {
      // với imap-simple, ngày nằm ở a.attributes.date
      return b.attributes.date - a.attributes.date;
    });

    // 3. Chọn message đầu tiên (mới nhất)
    const latest = messages[0];
    const raw = latest.parts.find(p => p.which === '').body;

    // 4. Parse và trả về OTP
    const parsed = await simpleParser(raw);
    const match = (parsed.text || '').match(/\b\d{6}\b/);
    await connection.end();

    if (match) {
      return res.json({ otp: match[0] });
    } else {
      return res.status(404).json({ error: 'Không tìm thấy mã OTP trong email mới nhất.' });
    }

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

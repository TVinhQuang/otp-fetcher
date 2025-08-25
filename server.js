// server.js

// ✨ 1. Load biến môi trường từ .env
require('dotenv').config();     

const bcrypt = require('bcrypt');              // 👈 thêm

function isBcryptHash(s) {
  return typeof s === 'string' && s.startsWith('$2'); // bcrypt thường bắt đầu bằng $2
}

async function verifyPinFlexible(pin, stored) {
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    // stored là bcrypt-hash -> so sánh bằng bcrypt
    return bcrypt.compare(pin, stored);
  }
  // stored là plaintext -> so sánh trực tiếp
  return pin === stored;
}


// ✨ 2. Import các thư viện cần thiết
const express      = require('express');     // Web framework
const path = require('path');        // ✔️ Dùng để xử lý đường dẫn cho an toàn
const bodyParser   = require('body-parser'); // Để parse JSON và form data
const imaps        = require('imap-simple'); // Kết nối IMAP
const { simpleParser } = require('mailparser'); // Parse MIME email
const speakeasy  = require('speakeasy');

// ✨ 3. Thêm hàm này vào ngay dưới các require:
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
      throw new Error('Chưa hỗ trợ nhà cung cấp mail này.');
  }
}

// Lấy CREDENTIALS từ env, parse JSON
const credentials = JSON.parse(process.env.CREDENTIALS);

// ✨ 3. Tạo app Express
const app = express();

// Dùng path.join để đảm bảo Express tìm đúng thư mục 'public'
app.use(express.static(path.join(__dirname, 'public')));                           

app.use(bodyParser.json());

// 2) Sau đó, nếu vẫn muốn GET / trả index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✨ 6. Route POST /get-otp
app.post('/get-otp', async (req, res) => {
  // 6.1. Nhận email & password từ body (có thể bỏ nếu dùng ENV cứng)
  const { email, pin } = req.body;
  if (!email || !pin) {
    return res.status(400).json({ error: 'Thiếu Email hoặc PIN.' });
  }

  const cred = credentials[req.body.email];
  if (!cred) return res.status(400).json({ error:'Email không được hỗ trợ' });

  // XÁC THỰC PIN:
  // - Ưu tiên pinHash riêng cho email (nếu cấu hình trong .env)
  // - Nếu không có thì fallback qua GLOBAL_PIN_HASH
  const pinHash = cred.pinHash;
  if (!pinHash) {
    return res.status(403).json({ error: 'Server chưa cấu hình PIN.' });
  }

  try {
    const ok = await verifyPinFlexible(pin, pinHash);
    if (!ok) {
      return res.status(401).json({ error: 'PIN không đúng.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Lỗi xác thực PIN.' });
  }

  const { appPass, totpSecret } = cred; 

  // 1) Nếu có totpSecret → gen TOTP và trả luôn
  if (cred.totpSecret) {
    try {
      const token = speakeasy.totp({
        secret: cred.totpSecret,
        encoding: 'base32',
        step: 30          // thời gian hợp lệ mặc định 30s
      });
      return res.json({ otp: token, source: 'otp' });
    } catch (e) {
      return res.status(500).json({ error: 'Sinh otp lỗi: ' + e.message });
    }
  }

  // 2) Fallback qua IMAP nếu có appPass
  if(!cred.appPass){
    return res.status(400).json({ error:'Chưa được set up để đọc mail.' });
  }

  const password = cred.appPass;
  let hostCfg;
  try {
    hostCfg = getImapHost(email);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  
  const config = {
    imap: {
      user:        email,
      password:    password,
      host:        hostCfg.host,
      port:        hostCfg.port,
      tls:         hostCfg.tls,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
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
      ['SINCE', since.toISOString()],              // gửi sau `since`
      ['FROM', 'noreply@openai.com']              // chỉ lấy mail từ ChatGPT
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

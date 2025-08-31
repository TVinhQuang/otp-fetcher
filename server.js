// server.js

// ✨ 1. Load biến môi trường từ .env
require('dotenv').config();     

const bcrypt = require('bcrypt');              // 👈 thêm
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const fs = require('fs');
const ExcelJS = require('exceljs');

const SHEETS_ID  = process.env.SHEETS_ID || null;
const SHEETS_TAB = process.env.SHEETS_TAB || 'Sheet1';
const GS_CLIENT_EMAIL = process.env.GS_CLIENT_EMAIL || null;
const GS_PRIVATE_KEY  = process.env.GS_PRIVATE_KEY  || null;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || null;

let _sheets = null;
async function getSheetsClient() {
  if (_sheets) return _sheets;
  if (!SHEETS_ID) { console.warn('[Sheet] SHEETS_ID missing'); return null; }

  try {
    // ✅ ƯU TIÊN Cách B (env variables)
    if (GS_CLIENT_EMAIL && GS_PRIVATE_KEY) {
      // Lưu ý: GS_PRIVATE_KEY trong .env là 1 dòng có \n -> convert thành newline thật
      const auth = new google.auth.JWT({
        email: GS_CLIENT_EMAIL,
        key: GS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      await auth.authorize(); // đảm bảo có danh tính trước khi gọi API
      _sheets = google.sheets({ version: 'v4', auth });
      console.log('[Sheet] auth=ServiceAccount (env):', GS_CLIENT_EMAIL);
      return _sheets;
    }

    // ➜ Cách A: keyFile (chỉ dùng khi thực sự set và file tồn tại)
    if (GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS)) {
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        keyFile: GOOGLE_APPLICATION_CREDENTIALS,
      });
      _sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
      console.log('[Sheet] auth=keyFile:', GOOGLE_APPLICATION_CREDENTIALS);
      return _sheets;
    }

    throw new Error('No Sheets credentials: set GS_CLIENT_EMAIL + GS_PRIVATE_KEY (or GOOGLE_APPLICATION_CREDENTIALS).');
  } catch (e) {
    console.error('[Sheet] auth error:', e.response?.data || e.message);
    throw e;
  }
}


const USE_GLOBAL_PIN = String(process.env.USE_GLOBAL_PIN || 'false').toLowerCase() === 'true';
const PER_ACC_MAX = parseInt(process.env.GLOBAL_PIN_MAX_USES_PER_ACCOUNT || '3', 10);

// PIN hiện hành & bộ đếm theo từng tài khoản
let currentGlobalPin = process.env.GLOBAL_PIN || null;
const perAccUsage = new Map(); // key: `${email}|${currentGlobalPin}` -> count
let rotating = false;

// SMTP transporter
const EMAIL_DISABLED = String(process.env.EMAIL_DISABLED || 'false').toLowerCase() === 'true';

const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // 👇 timeouts để không treo quá lâu
  connectionTimeout: Number(process.env.SMTP_CONN_TIMEOUT || 8000),
  greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 8000),
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 10000),
});

async function safeSendRotateEmail(triggerEmail, newPin) {
  if (EMAIL_DISABLED) { 
    console.log('[PIN] email disabled; skip sending');
    return;
  }
  try {
    const to = process.env.PIN_NOTIFY_TO;
    if (!to) { console.warn('[PIN] PIN_NOTIFY_TO missing'); return; }
    const body = `${triggerEmail}, ${newPin}`;
    await smtpTransport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject: 'PIN mới', text: body,
    });
    console.log('[PIN] Sent new PIN to', to, '=>', body);
  } catch (e) {
    console.warn('[PIN] email send failed:', e.message);
  }
}


function gen4DigitPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

async function sendRotateEmail(triggerEmail, newPin) {
  const to = process.env.PIN_NOTIFY_TO;
  if (!to) { console.warn('[PIN] PIN_NOTIFY_TO chưa cấu hình'); return; }
  const body = `${triggerEmail}, ${newPin}`;          // đúng format yêu cầu

  await smtpTransport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'PIN mới',
    text: body,
  });
  console.log('[PIN] Sent new PIN to', to, '=>', body);
}

async function rotateGlobalPin(triggerEmail) {
  if (rotating) return;
  rotating = true;
  try {
    const newPin = gen4DigitPin();
    currentGlobalPin = newPin;
    perAccUsage.clear();               // reset bộ đếm cho PIN mới
    await Promise.allSettled([
      safeSendRotateEmail(triggerEmail, newPin),
      upsertPinToGoogleSheet(triggerEmail, newPin),
      // (tuỳ) chỉ ghi Excel cục bộ khi có biến cấu hình
      process.env.PIN_LIST_XLSX ? upsertPinToExcel(triggerEmail, newPin) : Promise.resolve()
    ]);

  } catch (e) {
    console.error('[PIN] Rotate failed:', e.message);
  } finally {
    rotating = false;
  }
}

// Lock tránh xoay trùng cho cùng 1 email
const rotatingPerEmail = new Set();

function resetPerEmailUsage(email) {
  for (const k of perAccountPinUsage.keys()) {
    if (k.startsWith(email + '|')) perAccountPinUsage.delete(k);
  }
}

async function rotatePerAccountPin(email) {
  if (rotatingPerEmail.has(email)) return;
  rotatingPerEmail.add(email);
  try {
    if (!credentials[email]) throw new Error('Email không tồn tại trong CREDENTIALS.');
    const newPin = gen4DigitPin();

    // cập nhật pinHash (plaintext) cho email này trong bộ nhớ
    credentials[email].pinHash = newPin;

    // reset bộ đếm cho email này
    resetPerEmailUsage(email);

    await Promise.allSettled([
      safeSendRotateEmail(email, newPin),
      upsertPinToGoogleSheet(email, newPin),
      process.env.PIN_LIST_XLSX ? upsertPinToExcel(email, newPin) : Promise.resolve()
    ]);

  } catch (e) {
    console.error('[PIN] rotatePerAccountPin failed:', e.message);
  } finally {
    rotatingPerEmail.delete(email);
  }
}

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

// Giới hạn số lần dùng PIN (mặc định 3) — có thể chỉnh bằng env
const PIN_MAX_USES_PER_ACCOUNT = parseInt(process.env.PIN_MAX_USES_PER_ACCOUNT || '3', 10);

// Bộ đếm số lần dùng theo mỗi (email, PIN)
// Reset khi server restart (nếu cần lưu lâu dài, tớ có thể ghi ra Sheet/DB)
const perAccountPinUsage = new Map(); // key: `${email}|${pin}` -> số lần đã dùng

function consumeStaticPinForAccount(email, pin) {
  const key = `${email}|${pin}`;
  const used = perAccountPinUsage.get(key) || 0;
  if (used >= PIN_MAX_USES_PER_ACCOUNT) return false; // đã vượt hạn mức
  perAccountPinUsage.set(key, used + 1);
  return true;
}

async function upsertPinToGoogleSheet(mail, pin) {
  if (!SHEETS_ID) return null;
  const sheets = await getSheetsClient();
  const tab = SHEETS_TAB;

  // Đọc A:B để tìm dòng trùng email (không phân biệt hoa/thường)
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: `${tab}!A:B`,
  });
  const rows = read.data.values || [];

  // Đảm bảo header
  const hasHeader = rows.length >= 1 &&
    String(rows[0][0] || '').trim() === 'Mail' &&
    String(rows[0][1] || '').trim() === 'Pin mới';

  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: `${tab}!A1:B1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Mail', 'Pin mới']] }
    });
    rows.unshift(['Mail','Pin mới']);
  }

  // Tìm row có mail
  let targetRow = -1; // 1-based
  for (let i = 1; i < rows.length; i++) {
    const v = (rows[i][0] || '').toString().trim();
    if (v && v.toLowerCase() === mail.toLowerCase()) {
      targetRow = i + 1; // vì rows[0] là header -> +1 để ra số dòng thực
      break;
    }
  }

  if (targetRow === -1) {
    // Append ngay dưới dữ liệu (đúng quy tắc: lần đầu thêm dòng)
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: `${tab}!A:B`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[mail, pin]] }
    });
    console.log('[PIN][Sheet] inserted:', mail, pin);
    return 'insert';
  } else {
    // Update đúng dòng có email (không thêm dòng mới)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: `${tab}!A${targetRow}:B${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[mail, pin]] }
    });
    console.log('[PIN][Sheet] updated row', targetRow, ':', mail, pin);
    return 'update';
  }
}

// === Upsert vào Excel: nếu Mail chưa có -> thêm ở dòng kế tiếp sau header (row ≥ 2);
// có rồi -> chỉ sửa "Pin mới".
async function upsertPinToExcel(mail, pin) {
  const file = process.env.PIN_LIST_XLSX || path.join(__dirname, 'List Pin.xlsx');
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(file)) await wb.xlsx.readFile(file);
  let ws = wb.getWorksheet('Sheet1');
  if (!ws) ws = wb.addWorksheet('Sheet1');

  // 1) Bảo đảm header
  const hdrA = (ws.getCell('A1').value || '').toString().trim();
  const hdrB = (ws.getCell('B1').value || '').toString().trim();
  if (hdrA !== 'Mail' || hdrB !== 'Pin mới') {
    ws.getCell('A1').value = 'Mail';
    ws.getCell('B1').value = 'Pin mới';
  }

  // 2) Tìm dòng đã có email (không phân biệt hoa thường)
  let rowToUpdate = null;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return; // bỏ header
    const val = (row.getCell(1).value || '').toString().trim();
    if (val && val.toLowerCase() === mail.toLowerCase()) rowToUpdate = row;
  });

  if (rowToUpdate) {
    // 3) Đã có -> update cột B
    rowToUpdate.getCell(2).value = pin;
    if (rowToUpdate.commit) rowToUpdate.commit();
    await wb.xlsx.writeFile(file);
    console.log('[PIN][Excel] updated:', mail, pin, '->', file);
    return 'update';
  }

  // 4) Chưa có -> tìm "last data row" thực sự (không tính định dạng/blank)
  const lastDataRow = (() => {
    let last = 1; // header
    // xét cả 2 cột A/B – dòng nào có dữ liệu thật thì coi là "used"
    ws.getColumn(1).eachCell({ includeEmpty: false }, (cell, r) => {
      if (r > 1 && String(cell.value || '').trim() !== '') last = Math.max(last, r);
    });
    ws.getColumn(2).eachCell({ includeEmpty: false }, (cell, r) => {
      if (r > 1 && String(cell.value || '').trim() !== '') last = Math.max(last, r);
    });
    return last;
  })();

  const nextRow = Math.max(2, lastDataRow + 1); // luôn bắt đầu từ row 2
  ws.getCell(nextRow, 1).value = mail;
  ws.getCell(nextRow, 2).value = pin;
  if (ws.getRow(nextRow).commit) ws.getRow(nextRow).commit();

  await wb.xlsx.writeFile(file);
  console.log('[PIN][Excel] inserted @row', nextRow, ':', mail, pin, '->', file);
  return 'insert';
}

// === Lấy thông tin hộp thư cần đọc (ưu tiên ROTATION_INBOX_*; fallback CREDENTIALS)
function getRotationInboxCreds(credentials) {
  const inboxEmail =
    process.env.ROTATION_INBOX_EMAIL ||
    (process.env.PIN_NOTIFY_TO || '').split(',')[0]?.trim();
  if (!inboxEmail) throw new Error('Chưa cấu hình ROTATION_INBOX_EMAIL / PIN_NOTIFY_TO');

  const appPass =
    process.env.ROTATION_INBOX_APP_PASS ||
    (credentials[inboxEmail] && credentials[inboxEmail].appPass);

  if (!appPass) {
    throw new Error(
      `Không tìm thấy appPass cho hộp thư ${inboxEmail}. Thêm vào CREDENTIALS hoặc đặt ROTATION_INBOX_APP_PASS.`
    );
  }
  return { email: inboxEmail, appPass };
}

// === Đọc mail có subject "PIN mới", parse "<mail>, <4digits>", upsert Excel
async function syncRotatedPinsFromMail(credentials) {
  const { email, appPass } = getRotationInboxCreds(credentials);

  // dùng hàm getImapHost(email) sẵn có trong code của cậu
  const hostCfg = getImapHost(email);
  const config = {
    imap: {
      user: email,
      password: appPass,
      host: hostCfg.host,
      port: hostCfg.port,
      tls: hostCfg.tls,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  const imaps = require('imap-simple');
  const { simpleParser } = require('mailparser');

  const conn = await imaps.connect(config);
  await conn.openBox('INBOX');

  // lọc thư có subject "PIN mới" (do chính server gửi) trong 7 ngày gần đây
  const since = new Date(Date.now() - 7*24*60*60*1000);
  const searchCriteria = [
    ['SINCE', since],
    ['HEADER', 'SUBJECT', 'PIN mới']   // <-- subject trùng với code gửi mail xoay PIN hiện tại
  ];
  const fetchOptions = { bodies: [''] };

  const messages = await conn.search(searchCriteria, fetchOptions);

  let inserted = 0, updated = 0, skipped = 0;
  for (const m of messages) {
    const raw = m.parts.find(p => p.which === '').body;
    const parsed = await simpleParser(raw);
    const text = (parsed.text || '').trim();

    // format: "<email>, <4digits>"
    const match = text.match(/^\s*([^,\n]+?)\s*,\s*(\d{4})\s*$/m);
    if (!match) { skipped++; continue; }
    const mail = match[1].trim();
    const pin  = match[2].trim();

    const r = await upsertPinToExcel(mail, pin);
    await upsertPinToGoogleSheet(mail, pin);
    if (r === 'insert') inserted++; else if (r === 'update') updated++; else skipped++;
  }

  await conn.end();
  return { inspected: messages.length, inserted, updated, skipped };
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

  // ===== ƯU TIÊN: PIN dùng chung + giới hạn THEO EMAIL =====
  if (USE_GLOBAL_PIN) {
    if (!currentGlobalPin) {
      return res.status(500).json({ error: 'Server chưa cấu hình GLOBAL_PIN.' });
    }
    if (pin !== currentGlobalPin) {
      return res.status(401).json({ error: 'PIN không đúng.' });
    }

    const key = `${email}|${currentGlobalPin}`;
    const used = perAccUsage.get(key) || 0;

    if (used >= PER_ACC_MAX) {
      // Tài khoản "email" đã dùng quá 3 lần với PIN này -> chặn & xoay PIN mới
      await rotateGlobalPin(email);   // email kích hoạt xoay sẽ in ở trước dấu phẩy
      return res.status(429).json({
        error: 'PIN cho tài khoản này đã vượt quá giới hạn.',
      });
    }

    perAccUsage.set(key, used + 1);
  } else {
    // ===== PIN theo từng email (pinHash trong CREDENTIALS) =====
    const pinHash = cred.pinHash;
    if (!pinHash) {
      return res.status(403).json({ error: 'Server chưa cấu hình PIN.' });
    }

    // So khớp PIN (hỗ trợ cả bcrypt lẫn plaintext)
    const ok = await verifyPinFlexible(pin, pinHash);
    if (!ok) {
      return res.status(401).json({ error: 'PIN không đúng.' });
    }

    // 👇 Giới hạn 3 lần cho mỗi tài khoản với PIN này
    if (!consumeStaticPinForAccount(email, pin)) {
      await rotatePerAccountPin(email);   // 👈 xoay PIN riêng cho email này
      return res.status(429).json({
        error: 'PIN cho tài khoản này đã vượt quá giới hạn.'
      });
    }

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
      ['SINCE', since],              // gửi sau `since`
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

// Gọi để đọc mail "PIN mới" và ghi vào Excel theo yêu cầu
app.post('/sync-rotated-pins', async (req, res) => {
  try {
    const result = await syncRotatedPinsFromMail(credentials);
    return res.json(result);
  } catch (e) {
    console.error('[PIN] sync error:', e);
    return res.status(500).json({ error: e.message });
  }
});


// ✨ 7. Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

require('dotenv').config();
const imaps = require('imap-simple');

(async () => {
  try {
    console.log('🔌 Kết nối IMAP với', process.env.EMAIL);
    const connection = await imaps.connect({
      imap: {
        user:       process.env.EMAIL,
        password:   process.env.PASS,
        host:       'imap.gmail.com',
        port:       993,
        tls:        true,
        authTimeout: 10000,
        // ↓ cho phép chấp nhận self-signed cert:
        tlsOptions: { rejectUnauthorized: false }
      }
    });
    console.log('✅ IMAP connected!');
    await connection.end();
  } catch (err) {
    console.error('❌ IMAP Error:', err);
  }
})();

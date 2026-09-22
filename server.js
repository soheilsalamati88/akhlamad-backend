/**
 * بک‌اند ساده سایت اخلمد
 * وظیفه: ارسال/تأیید کد پیامکی از طریق کاوه‌نگار + ایجاد و تأیید پرداخت از طریق زرین‌پال
 *
 * نکته امنیتی مهم:
 * این نسخه برای شروع سریع، اطلاعات نشست (session) و کدهای OTP را در حافظه (RAM) نگه می‌دارد.
 * یعنی با هر بار ری‌استارت شدن سرور، همه چیز پاک می‌شود و روی چند سرور هم‌زمان کار نمی‌کند.
 * برای پروژه واقعی و پرترافیک، این Map‌ها را با یک دیتابیس ساده (مثل Redis یا SQLite) جایگزین کنید.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Kavenegar = require('kavenegar');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000/akhlamad.html';
const ENTRY_FEE_TOMAN = Number(process.env.ENTRY_FEE_TOMAN || 10000);

const kavenegarApi = Kavenegar.KavenegarApi({ apikey: process.env.KAVENEGAR_API_KEY });
const OTP_TEMPLATE = process.env.KAVENEGAR_OTP_TEMPLATE || 'verify-akhlamad';

const ZARINPAL_MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID;
const ZARINPAL_SANDBOX = String(process.env.ZARINPAL_SANDBOX).toLowerCase() === 'true';
const ZARINPAL_BASE = ZARINPAL_SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/v4/payment'
  : 'https://payment.zarinpal.com/pg/v4/payment';
const ZARINPAL_STARTPAY = ZARINPAL_SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/StartPay/'
  : 'https://www.zarinpal.com/pg/StartPay/';

// ---------- حافظه موقت (در پروژه واقعی با دیتابیس جایگزین کنید) ----------
const otpStore = new Map();       // phone -> { code, expiresAt }
const sessionStore = new Map();   // token -> { phone, verified, paid }
const paymentStore = new Map();   // authority -> { token, phone }

function isValidIranPhone(v) {
  return /^09\d{9}$/.test(String(v || ''));
}
function makeToken() {
  return 'tok_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ============================================================
// 1) ارسال کد تأیید پیامکی (کاوه‌نگار - Verify Lookup)
// ============================================================
app.post('/api/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!isValidIranPhone(phone)) {
    return res.status(400).json({ ok: false, error: 'شماره موبایل معتبر نیست.' });
  }

  const code = String(Math.floor(1000 + Math.random() * 9000));
  otpStore.set(phone, { code, expiresAt: Date.now() + 2 * 60 * 1000 }); // 2 دقیقه اعتبار

  kavenegarApi.VerifyLookup(
    {
      receptor: phone,
      token: code,
      template: OTP_TEMPLATE,
    },
    (response, status) => {
      if (status === 200) {
        return res.json({ ok: true, message: 'کد تأیید ارسال شد.' });
      }
      console.error('Kavenegar error:', status, response);
      return res.status(502).json({ ok: false, error: 'ارسال پیامک با خطا مواجه شد.' });
    }
  );
});

// ============================================================
// 2) تأیید کد پیامکی
// ============================================================
app.post('/api/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  const record = otpStore.get(phone);

  if (!record || Date.now() > record.expiresAt) {
    return res.status(400).json({ ok: false, error: 'کد منقضی شده، دوباره درخواست دهید.' });
  }
  if (record.code !== String(code)) {
    return res.status(400).json({ ok: false, error: 'کد وارد شده صحیح نیست.' });
  }

  otpStore.delete(phone);
  const token = makeToken();
  sessionStore.set(token, { phone, verified: true, paid: false });

  return res.json({ ok: true, token });
});

// ============================================================
// 3) ایجاد تراکنش پرداخت (زرین‌پال)
// ============================================================
app.post('/api/payment/request', async (req, res) => {
  const { token } = req.body;
  const session = sessionStore.get(token);

  if (!session || !session.verified) {
    return res.status(401).json({ ok: false, error: 'ابتدا شماره موبایل خود را تأیید کنید.' });
  }

  try {
    const response = await fetch(`${ZARINPAL_BASE}/request.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: ZARINPAL_MERCHANT_ID,
        amount: ENTRY_FEE_TOMAN, // زرین‌پال از نسخه v4 به بعد مبلغ را به تومان می‌پذیرد
        callback_url: `${SITE_URL.replace(/\/[^/]*$/, '')}/api/payment/callback`,
        description: 'هزینه ورود به پایگاه گردشگری اخلمد',
        metadata: { mobile: session.phone },
      }),
    });
    const data = await response.json();

    if (data?.data?.code === 100) {
      const authority = data.data.authority;
      paymentStore.set(authority, { token, phone: session.phone });
      return res.json({ ok: true, paymentUrl: `${ZARINPAL_STARTPAY}${authority}` });
    }
    console.error('Zarinpal request error:', data);
    return res.status(502).json({ ok: false, error: 'ایجاد تراکنش پرداخت ناموفق بود.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'خطا در ارتباط با درگاه پرداخت.' });
  }
});

// ============================================================
// 4) بازگشت از درگاه پرداخت + تأیید تراکنش
// ============================================================
app.get('/api/payment/callback', async (req, res) => {
  const { Authority, Status } = req.query;
  const record = paymentStore.get(Authority);

  if (!record) {
    return res.redirect(`${SITE_URL}?payment=failed&reason=unknown`);
  }
  if (Status !== 'OK') {
    return res.redirect(`${SITE_URL}?payment=failed&token=${record.token}`);
  }

  try {
    const response = await fetch(`${ZARINPAL_BASE}/verify.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: ZARINPAL_MERCHANT_ID,
        amount: ENTRY_FEE_TOMAN,
        authority: Authority,
      }),
    });
    const data = await response.json();

    if (data?.data?.code === 100 || data?.data?.code === 101) {
      const session = sessionStore.get(record.token);
      if (session) session.paid = true;
      return res.redirect(`${SITE_URL}?payment=success&token=${record.token}`);
    }
    console.error('Zarinpal verify error:', data);
    return res.redirect(`${SITE_URL}?payment=failed&token=${record.token}`);
  } catch (err) {
    console.error(err);
    return res.redirect(`${SITE_URL}?payment=failed&token=${record.token}`);
  }
});

// ============================================================
// 5) بررسی وضعیت نشست (برای صفحه بعد از بازگشت از درگاه)
// ============================================================
app.get('/api/session/status', (req, res) => {
  const { token } = req.query;
  const session = sessionStore.get(token);
  if (!session) return res.status(404).json({ ok: false });
  return res.json({ ok: true, phone: session.phone, verified: session.verified, paid: session.paid });
});

app.listen(PORT, () => {
  console.log(`سرور اخلمد روی پورت ${PORT} در حال اجراست.`);
});

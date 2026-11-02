import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const E = process.env;
const pool = new pg.Pool({ connectionString: E.DATABASE_URL, max: 5 });
const app = express();
const dir = path.dirname(fileURLToPath(import.meta.url));
const SIGNUP_BONUS = Number(E.SIGNUP_BONUS ?? 0.02);
const DEPOSIT_COMMISSION = Number(E.DEPOSIT_COMMISSION ?? 0.5);

// Page coin name -> OxaPay pay_currency + network.
// CHECK these names against OxaPay "Accepted Currencies" before going live. GRAM may not be supported.
const COINS = {
  'TRX': ['TRX', 'TRC20'], 'BNB (BEP20)': ['BNB', 'BEP20'], 'DOGE': ['DOGE', 'Dogecoin'],
  'LTC': ['LTC', 'Litecoin'], 'SOL': ['SOL', 'Solana'], 'POL': ['POL', 'Polygon'],
  'USDT (TRC20)': ['USDT', 'TRC20'], 'USDT (BEP20)': ['USDT', 'BEP20'],
  'USDT (POLYGON)': ['USDT', 'Polygon'], 'USDT (SOLANA)': ['USDT', 'Solana'], 'USDT (TON)': ['USDT', 'TON'],
};

const q = (text, p) => pool.query(text, p);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });

// ---------- OxaPay webhook (must read the RAW body, so it is registered before express.json) ----------
app.post('/oxapay/webhook', express.raw({ type: '*/*' }), wrap(async (req, res) => {
  const raw = req.body.toString('utf8');
  const mine = crypto.createHmac('sha512', E.OXAPAY_MERCHANT_KEY).update(raw).digest('hex');
  const got = String(req.headers['hmac'] || '');
  if (mine.length !== got.length || !crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(got))) throw bad('bad signature', 400);
  const d = JSON.parse(raw);
  const track = String(d.track_id ?? d.trackId ?? '');
  const status = String(d.status || '').toLowerCase();
  if (track && status === 'paid') await creditDeposit(track);
  else if (track && status === 'expired') await q("UPDATE deposits SET status='expired' WHERE track_id=$1 AND status='pending'", [track]);
  res.status(200).send('ok');
}));

// Credits a deposit exactly once, then pays the referrer's deposit commission.
async function creditDeposit(track) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM deposits WHERE track_id=$1 AND status='pending' FOR UPDATE", [track]);
    const d = rows[0]; if (!d) return;                       // unknown or already credited
    const coins = d.amount_usd;                              // 1 USD = 1 coin (same as the page)
    await c.query("UPDATE deposits SET status='paid', coins_credited=$2, paid_at=now() WHERE id=$1", [d.id, coins]);
    await c.query('UPDATE users SET balance=balance+$2 WHERE id=$1', [d.user_id, coins]);
    await c.query("INSERT INTO balance_log(user_id,delta,reason,ref_id) VALUES ($1,$2,'deposit',$3)", [d.user_id, coins, d.id]);
    const u = (await c.query('SELECT referrer_id FROM users WHERE id=$1', [d.user_id])).rows[0];
    if (u?.referrer_id && DEPOSIT_COMMISSION > 0) {
      await c.query(`INSERT INTO referral_commissions(referrer_id,referred_id,kind,deposit_id,amount)
        VALUES ($1,$2,'deposit',$3,$4) ON CONFLICT DO NOTHING`, [u.referrer_id, d.user_id, d.id, Number(coins) * DEPOSIT_COMMISSION]);
    }
  });
}

app.use(express.json());
app.use(express.static(path.join(dir, 'public')));   // serves the user pages (index.html)

// ---------- Telegram Mini App auth: header X-Init-Data on every request ----------
function parseInitData(initData) {
  const p = new URLSearchParams(initData); const hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(E.BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (!hash || calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  return { user: JSON.parse(p.get('user') || 'null'), start: p.get('start_param') || '' };
}
const auth = async (req, res, next) => {
  try {
    const info = parseInitData(String(req.headers['x-init-data'] || ''));
    if (!info?.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const id = info.user.id, refId = /^ref_(\d+)$/.exec(info.start)?.[1];
    await tx(async (c) => {
      const ex = await c.query('SELECT id FROM users WHERE id=$1', [id]);
      if (ex.rowCount) return;
      let ref = null;
      if (refId && Number(refId) !== id) ref = (await c.query('SELECT id FROM users WHERE id=$1', [refId])).rows[0]?.id ?? null;
      await c.query('INSERT INTO users(id,username,referrer_id) VALUES ($1,$2,$3)', [id, info.user.username || null, ref]);
      if (ref && SIGNUP_BONUS > 0) await c.query("INSERT INTO referral_commissions(referrer_id,referred_id,kind,amount) VALUES ($1,$2,'signup',$3)", [ref, id, SIGNUP_BONUS]);
    });
    req.uid = id; next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
};

// ---------- User API ----------
app.get('/api/me', auth, wrap(async (req, res) => {
  const me = (await q('SELECT id,username,balance FROM users WHERE id=$1', [req.uid])).rows[0];
  const s = (await q(`SELECT count(DISTINCT referred_id) AS referrals,
      COALESCE(sum(amount),0) AS total_income,
      COALESCE(sum(amount) FILTER (WHERE NOT collected),0) AS collectable
      FROM referral_commissions WHERE referrer_id=$1`, [req.uid])).rows[0];
  const cnt = (await q('SELECT count(*) FROM users WHERE referrer_id=$1', [req.uid])).rows[0].count;
  res.json({ ...me, referrals: Number(cnt), total_income: s.total_income, collectable: s.collectable });
}));

app.get('/api/referrals', auth, wrap(async (req, res) => {   // the history table on the referral page
  const { rows } = await q(`SELECT u.username, u.id AS user_id, u.created_at AS date,
      COALESCE((SELECT sum(amount_usd) FROM deposits WHERE user_id=u.id AND status='paid'),0) AS deposit,
      COALESCE((SELECT sum(amount) FROM referral_commissions WHERE referrer_id=$1 AND referred_id=u.id),0) AS income
      FROM users u WHERE u.referrer_id=$1 ORDER BY u.created_at DESC LIMIT 200`, [req.uid]);
  res.json(rows);
}));

app.post('/api/collect', auth, wrap(async (req, res) => {
  const out = await tx(async (c) => {
    const { rows } = await c.query('SELECT id,amount FROM referral_commissions WHERE referrer_id=$1 AND NOT collected FOR UPDATE', [req.uid]);
    const total = rows.reduce((a, r) => a + Number(r.amount), 0);
    if (!rows.length) return { collected: 0 };
    await c.query('UPDATE referral_commissions SET collected=true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    await c.query('UPDATE users SET balance=balance+$2 WHERE id=$1', [req.uid, total]);
    await c.query("INSERT INTO balance_log(user_id,delta,reason) VALUES ($1,$2,'commission_collect')", [req.uid, total]);
    return { collected: total };
  });
  res.json(out);
}));

app.get('/api/deposits', auth, wrap(async (req, res) => res.json((await q('SELECT id,coin,amount_usd,coins_credited,status,created_at,paid_at FROM deposits WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.uid])).rows)));
app.get('/api/withdrawals', auth, wrap(async (req, res) => res.json((await q('SELECT id,coin,address,amount_coins,status,note,created_at,decided_at FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.uid])).rows)));

app.post('/api/deposit', auth, wrap(async (req, res) => {
  const { coin, amount } = req.body, amt = Number(amount), pair = COINS[coin];
  if (!pair) throw bad('Unsupported coin');
  if (!(amt >= 1)) throw bad('Minimum deposit is 1.00');
  const r = await fetch('https://api.oxapay.com/v1/payment/white-label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', merchant_api_key: E.OXAPAY_MERCHANT_KEY },
    body: JSON.stringify({ amount: amt, currency: 'USD', pay_currency: pair[0], network: pair[1], lifetime: 60,
      callback_url: `${E.PUBLIC_URL}/oxapay/webhook`, order_id: `u${req.uid}-${Date.now()}`, description: 'Deposit' }),
  });
  const j = await r.json();
  const data = j.data; if (!r.ok || !data?.track_id) { console.error(j); throw bad('Payment provider error', 502); }
  await q('INSERT INTO deposits(user_id,coin,address,amount_usd,track_id) VALUES ($1,$2,$3,$4,$5)', [req.uid, coin, data.address, amt, String(data.track_id)]);
  res.json({ address: data.address, network: data.network, pay_amount: data.pay_amount, expired_at: data.expired_at });
}));

app.post('/api/withdraw', auth, wrap(async (req, res) => {
  const { coin, address, amount } = req.body, amt = Number(amount);
  if (!COINS[coin]) throw bad('Unsupported coin');
  if (typeof address !== 'string' || address.trim().length < 20) throw bad('Invalid address');
  if (!(amt >= 1)) throw bad('Minimum withdrawal is 1.00');
  const id = await tx(async (c) => {
    const up = await c.query('UPDATE users SET balance=balance-$2 WHERE id=$1 AND balance>=$2 RETURNING id', [req.uid, amt]);
    if (!up.rowCount) throw bad('Not enough balance');
    const w = await c.query('INSERT INTO withdrawals(user_id,coin,address,amount_coins,amount_usd) VALUES ($1,$2,$3,$4,$4) RETURNING id', [req.uid, coin, address.trim(), amt]);
    await c.query("INSERT INTO balance_log(user_id,delta,reason,ref_id) VALUES ($1,$2,'withdraw',$3)", [req.uid, -amt, w.rows[0].id]);
    return w.rows[0].id;
  });
  res.json({ id });
}));

// ---------- Admin: /hyper ----------
const admin = (req, res, next) => {
  const a = Buffer.from(String((req.headers.authorization || '').replace(/^Bearer /, '')));
  const b = Buffer.from(String(E.ADMIN_PASSWORD || ''));
  if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return setTimeout(() => res.status(401).json({ error: 'Unauthorized' }), 800);
  next();
};
app.get(['/hyper', '/hyper/'], (req, res) => res.sendFile(path.join(dir, 'public/hyper-admin.html')));
app.get('/hyper/api/withdrawals', admin, wrap(async (req, res) => {
  const { rows } = await q(`SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 500`);
  res.json(rows.map((r) => ({ id: 'W-' + r.id, user: r.username ? '@' + r.username : String(r.user_id), uid: String(r.user_id),
    coin: r.coin, amount: Number(r.amount_coins), addr: r.address, status: r.status, ts: new Date(r.created_at).getTime(), note: r.note || '' })));
}));
app.patch('/hyper/api/withdrawals/:id', admin, wrap(async (req, res) => {
  const id = Number(String(req.params.id).replace(/^W-/, '')), { status, note } = req.body;
  if (!['approved', 'rejected'].includes(status)) throw bad('Bad status');
  await tx(async (c) => {
    const w = (await c.query("SELECT * FROM withdrawals WHERE id=$1 AND status='pending' FOR UPDATE", [id])).rows[0];
    if (!w) throw bad('Already decided or not found', 409);
    await c.query('UPDATE withdrawals SET status=$2, note=$3, decided_at=now() WHERE id=$1', [id, status, note || null]);
    if (status === 'rejected') {                               // refund
      await c.query('UPDATE users SET balance=balance+$2 WHERE id=$1', [w.user_id, w.amount_coins]);
      await c.query("INSERT INTO balance_log(user_id,delta,reason,ref_id) VALUES ($1,$2,'withdraw_refund',$3)", [w.user_id, w.amount_coins, id]);
    }
  });
  res.json({ ok: true });
}));

app.listen(E.PORT || 3000, () => console.log('listening'));

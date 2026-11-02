# Hyper project

hyper-project/
  server.js            backend (Node.js)
  schema.sql           Neon database tables
  package.json
  .env.example         copy to .env and fill in
  public/index.html    user pages (Referrals, Deposit, Withdraw)
  public/hyper-admin.html   admin panel, opens at /hyper

## Setup
1. Neon: create a project, open the SQL editor, run schema.sql.
2. Copy .env.example to .env, fill in DATABASE_URL, BOT_TOKEN, a NEW OXAPAY_MERCHANT_KEY, ADMIN_PASSWORD, PUBLIC_URL.
3. npm install
4. node --env-file=.env server.js   (Node 20+)
5. Admin: https://your-domain.com/hyper
6. In the OxaPay dashboard / API calls the webhook URL is PUBLIC_URL/oxapay/webhook

## Not finished yet
- public/index.html does not call the server yet (balance, deposit, withdraw, collect are still screen-only).
- Check the COINS names in server.js against OxaPay Accepted Currencies.
- Test one small deposit and one withdrawal before going live.

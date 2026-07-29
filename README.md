# MAXBACHAT Maintenance Department - Production Setup

This package has two parts:

- `backend/` - Node.js API. Talks to DigitalOcean Postgres and Spaces. Holds all secrets.
- `frontend/` - Static dashboard (`index.html` + `app.js`). Runs in the browser and talks only to the backend API.

## 1. Rotate Credentials First

If database or Spaces credentials were ever pasted in chat, treat them as exposed:

1. DigitalOcean Databases: reset the app database password.
2. DigitalOcean Spaces API: regenerate the key/secret pair.
3. Use only the new values in production `.env`.

Never commit or share the real `.env` file.

## 2. Database Setup

Run this once against the DigitalOcean Postgres database:

```bash
psql "postgresql://USERNAME:NEWPASSWORD@HOST:PORT/maxbachat?sslmode=require" -f backend/schema.sql
```

This creates/updates:

- `branches`
- `users`
- `user_routes`
- `issues`
- `issue_media`

The schema includes `users.must_change_password`, so seeded users are forced to change their initial password after first login.

## 3. Backend Setup

```bash
cd backend
cp .env.example .env
# Fill: JWT_SECRET, DATABASE_URL, SPACES_KEY, SPACES_SECRET,
# SPACES_BUCKET, SPACES_REGION, SPACES_ENDPOINT, SPACES_URL,
# MEDIA_PUBLIC_READ, CORS_ORIGIN
# CEO_APPROVAL_THRESHOLD, NOTIFICATION_PROVIDER, GREEN_API_INSTANCE_ID,
# GREEN_API_TOKEN, NOTIFICATION_WEBHOOK_URL
npm install
npm run seed
npm start
```

Generate `JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The API runs on `PORT` from `.env`, default `4000`.

Keep proof media private in production:

```env
MEDIA_PUBLIC_READ=false
```

Issues at or above `CEO_APPROVAL_THRESHOLD` need CEO/admin approval before maintenance can close them. Notification events are always logged in the database. Set `NOTIFICATION_PROVIDER=greenapi` with `GREEN_API_INSTANCE_ID` and `GREEN_API_TOKEN` to send WhatsApp messages through GREEN-API. If a custom `NOTIFICATION_WEBHOOK_URL` is set instead, the backend POSTs each event to that webhook.

## 4. Seeded Login IDs

| Role | IDs | Initial password |
|---|---|---|
| Captain | CAP-BR1 / BR2 / BR3 / BR4 | 14512 / 24512 / 34512 / 44512 |
| Auditor | AUD-BR1 / BR2 / BR3 / BR4 | 15623 / 25623 / 35623 / 45623 |
| Maintenance Team | MT-BR1 (Head) / BR2 / BR3 / BR4 | 16734 / 26734 / 36734 / 46734 |
| Reporter | REP-JDC, REP-MANDI | 58121 / 58231 |
| Head Office Admin | ADMIN-HQ | 90909 |
| CEO | CEO-HQ | 70701 |

Every seeded login is forced to set a new private password after first login.

## 5. Deploy Backend

Recommended: DigitalOcean App Platform.

1. Push `backend/` to a GitHub repo.
2. Create a Node app from the repo.
3. Set run command: `npm start`.
4. Add `.env` values in App Platform environment variables.
5. Mark `JWT_SECRET`, `DATABASE_URL`, and `SPACES_SECRET` as encrypted.
6. Deploy and confirm `/health` returns `{ "ok": true }`.
7. Confirm `/health/db` returns `{ "ok": true, "db": true }`.

After frontend deployment, set `CORS_ORIGIN` to the exact frontend URL, for example:

```env
CORS_ORIGIN=https://maintenance.maxbachat.com
```

## 6. Deploy Frontend

Edit the first config line in `frontend/app.js`:

```js
const API_BASE = 'https://your-backend-url/api';
```

Then host `frontend/index.html` and `frontend/app.js` on any static host:

- DigitalOcean App Platform static site
- DigitalOcean Spaces static website
- Netlify
- Existing website hosting

## 7. What Is Production-Pilot Ready

- Data lives in Postgres, not browser local data.
- Passwords are bcrypt-hashed.
- First login forces password change.
- Backend blocks workflow API access until first-login password change is complete.
- Users can change password later from the Account button.
- Admin can create users, reset passwords, and disable/enable accounts from the dashboard.
- Admin can save phone numbers for users.
- Disabled accounts are blocked even if an old JWT token still exists.
- Login returns a 12-hour JWT session.
- Login attempts are rate-limited.
- API sends standard security headers.
- Media uploads use short-lived presigned Spaces URLs.
- Backend checks media type and file size before issuing an upload URL.
- Spaces secret key never reaches the browser.
- Proof media is private by default and shown through temporary signed view URLs.
- Issue reads are role scoped.
- Audit logs record password changes, issue creation, verification, closure, and admin user actions.
- High-cost issues can require CEO approval before maintenance closure.
- Notification logs are created for issue movement and approval events.
- Issue movement notifications go to all active Maintenance Team users with phone numbers saved.

## 8. Pilot Rollout Checklist

- Rotate any credentials that were shared outside DigitalOcean.
- Apply `backend/schema.sql`.
- Run `npm run seed`.
- Deploy backend.
- Update `frontend/app.js` with backend API URL.
- Deploy frontend.
- Lock `CORS_ORIGIN` to the frontend URL.
- Enable daily database backups in DigitalOcean.
- Test login, forced password change, issue creation, audit verification, maintenance closure, and photo/video upload.
- Test admin user create/reset/disable and audit log visibility.

## 9. Milestone 2 Hardening Added

- Private media mode with signed read URLs.
- Admin user management inside the dashboard.
- Account disable enforcement on existing sessions.
- Audit log table and admin audit log view.
- Role-scoped issue visibility.
- DB health endpoint for deployment checks.

## 10. Next Improvements Before Wider Rollout

- Add automated tests and CI.
- Add monitoring/log alerts for API errors.
- Add branch/route management UI for maintenance-team routing beyond seed defaults.
- Add CSV/PDF reporting exports for management review.

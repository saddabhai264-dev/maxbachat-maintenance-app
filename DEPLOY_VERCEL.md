# Deploy on Vercel Without Card

Use this when Render asks for card verification.

## 1. Import Project

1. Open https://vercel.com
2. Sign up / login with GitLab.
3. Add New Project.
4. Import `maxbachat-group/maxbachat-maintenance-app`.
5. Framework Preset: Other.
6. Root Directory: leave blank.

Vercel will use `vercel.json`.

## 2. Environment Variables

Add the same production env vars:

```env
NODE_ENV=production
JWT_SECRET=<long random secret>
DATABASE_URL=postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>?sslmode=require
SPACES_KEY=<SPACES_KEY>
SPACES_SECRET=<SPACES_SECRET>
SPACES_BUCKET=<SPACES_BUCKET>
SPACES_REGION=<SPACES_REGION>
SPACES_ENDPOINT=https://<SPACES_REGION>.digitaloceanspaces.com
SPACES_URL=https://<SPACES_BUCKET>.<SPACES_REGION>.digitaloceanspaces.com
MEDIA_PUBLIC_READ=false
CEO_APPROVAL_THRESHOLD=300000
NOTIFICATION_PROVIDER=greenapi
GREEN_API_INSTANCE_ID=<green_api_instance_id>
GREEN_API_TOKEN=<green_api_token>
NOTIFICATION_WEBHOOK_URL=
CORS_ORIGIN=*
```

## 3. Deploy

Click Deploy. The Vercel build runs:

```bash
npm run vercel-build
```

That applies database schema and seeds default users.

## 4. Test

Open:

- `/health`
- `/health/db`
- `/`

Vercel Hobby is a short-term testing workaround. For company production, move to a paid/company-owned host when possible.

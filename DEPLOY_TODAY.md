# Deploy Today - Render Single Service

Fastest setup for team testing:

- One Render Web Service hosts both frontend and backend.
- The frontend automatically calls the same service at `/api`.
- DigitalOcean Postgres and Spaces stay external through environment variables.

## 1. Push to GitHub

Push the `maxbachat-production/` folder as a GitHub repository.

## 2. Create Render Service

1. Open Render.
2. New + Web Service.
3. Connect the GitHub repo.
4. Use these settings:
   - Root Directory: leave blank if repo root is `maxbachat-production`; otherwise set `maxbachat-production`
   - Build Command: `cd backend && npm install && npm run migrate && npm run seed`
   - Start Command: `cd backend && npm start`
   - Health Check Path: `/health`

## 3. Add Environment Variables

Add these in Render dashboard. Do not put real secrets in code.

```env
NODE_ENV=production
PORT=10000
JWT_SECRET=<click Generate or use a long random value>

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
GREEN_API_INSTANCE_ID=<your_green_api_instance_id>
GREEN_API_TOKEN=<your_green_api_token>
NOTIFICATION_WEBHOOK_URL=
CORS_ORIGIN=*
```

After deploy, replace `CORS_ORIGIN=*` with your Render app URL when testing is stable.

## 4. Database Setup

Render build runs `npm run migrate && npm run seed`, so schema and initial users are created automatically during deploy.

The seed script does not reset existing passwords on later deploys.

## 5. Smoke Test

Open:

- `https://YOUR-RENDER-APP.onrender.com/health`
- `https://YOUR-RENDER-APP.onrender.com/health/db`
- `https://YOUR-RENDER-APP.onrender.com`

Then test:

- Admin login
- Forced password change
- Create issue
- Verify issue
- Close issue with photo/video
- Admin user create/reset/disable
- Audit log
- Phone numbers in admin user management
- CEO approval queue for expensive issues

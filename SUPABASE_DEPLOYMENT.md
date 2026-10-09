# Prayer Reminder App - Supabase Deployment Guide

## Overview
This guide covers deploying the Prayer Reminder App to Supabase with PostgreSQL database and Supabase Auth.

## Prerequisites
- Supabase account and project created
- Node.js 18+ installed
- Git repository (optional, for deployment)

## Step 1: Apply Database Schema to Supabase

### Option A: Using Supabase Dashboard (Recommended)
1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor** (left sidebar)
3. Click **"New Query"**
4. Copy the contents of `supabase/schema.sql`
5. Paste it into the SQL Editor
6. Click **"Run"** to execute the schema

### Option B: Using Supabase CLI
```bash
# Install Supabase CLI (if not already installed)
npm install -g supabase

# Login to Supabase
supabase login

# Link to your project
supabase link --project-ref mpvmzwxsvufbfzhelwri

# Push the schema
supabase db push
```

### Step 1b: Incremental migrations (for projects created from an older schema)

`supabase/schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so re-running it on an
existing project does **not** add columns introduced later. If features like
**Email preferences** fail with a "column ... does not exist" error (or the
dashboard shows "We couldn't save your preferences ... the database may still
need its one-time update"), apply these once in the SQL Editor. They are
idempotent and safe to re-run:

```sql
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS notification_prefs JSONB;
ALTER TABLE responses     ADD COLUMN IF NOT EXISTS mark_source        TEXT;
```

- `user_profiles.notification_prefs` — per-user email opt-ins (`{ prayers, pre, post }`). `NULL` means all reminders enabled.
- `responses.mark_source` — who/what set a status (`manual` | `email` | `auto`), so an auto-marked "missed" is distinguishable from a user tap. Powers the "Missed · auto" badge.

No app restart is needed after running them — the columns are read live.

## Step 2: Configure Environment Variables

1. Copy the example environment file:
```bash
cp .env.supabase .env
```

2. Update the following values in `.env`:
   - `SESSION_SECRET`: Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `TOKEN_SECRET`: Generate another random secret
   - `BASE_URL`: Update to your deployment URL (if not localhost)
   - `SMTP_*`: Configure your email provider settings
   - `EMAIL_FROM`: Set your sender email

## Step 3: Install Dependencies

```bash
npm install
```

## Step 4: Run the Application

### Development Mode
```bash
npm start
```

The app will be available at `http://localhost:3000`

### Production Mode
For production deployment, you have several options:

#### Option 1: Deploy to Render/Vercel/Railway
The app can be deployed to any Node.js hosting platform. See the existing deployment guides for:
- `RENDER_DEPLOYMENT.md` for Render deployment
- `DEPLOYMENT.md` for general deployment options

#### Option 2: Deploy to VPS
```bash
# Install PM2 for process management
npm install -g pm2

# Start the app with PM2
pm2 start src/server.js --name prayer-app

# Configure PM2 to start on boot
pm2 startup
pm2 save
```

## Step 5: Configure Supabase Auth

1. Go to your Supabase project dashboard
2. Navigate to **Authentication** → **Providers**
3. Enable **Email** provider (should be enabled by default)
4. Configure email settings if needed:
   - **Confirm email**: Enable for production
   - **Secure email change**: Enable for production

## Step 6: Test the Application

1. **Test Sign Up**:
   - Navigate to `http://localhost:3000/signup`
   - Create a test account
   - Verify the user is created in Supabase Auth

2. **Test Prayer Times**:
   - Set your city and country in profile
   - Verify prayer times load from Aladhan API

3. **Test Group Creation**:
   - Create a new group
   - Verify group is created in Supabase database

4. **Test Email Notifications**:
   - Configure SMTP settings
   - Test email sending functionality

## Step 7: Configure Cron Jobs

### Development Mode
The internal node-cron scheduler runs every 5 minutes automatically.

### Production Mode
For production, use external cron services:

#### Using Render Cron Jobs
1. Deploy web service to Render
2. Add a cron job in Render dashboard
3. Set schedule to `*/5 * * * *`
4. Set command to `npm run cron`

#### Using GitHub Actions
Create `.github/workflows/scheduler.yml`:
```yaml
name: Prayer Scheduler
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

jobs:
  scheduler:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Prayer Scheduler
        run: |
          curl -X POST https://your-app.com/api/cron/prayer-scheduler \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

## Database Schema Overview

The following tables are created in Supabase:

- `groups`: Group information and codes
- `user_profiles`: Additional user data (linked to Supabase Auth)
- `prayer_times`: Cached prayer times per user per date
- `responses`: User prayer completion status
- `notifications_log`: Email notification tracking
- `group_invitations`: Email-based group invitations

## Security Considerations

1. **Row Level Security (RLS)**: Enabled on all tables
2. **API Keys**: 
   - Use `SUPABASE_ANON_KEY` for client-side operations
   - Use `SUPABASE_SERVICE_ROLE_KEY` for admin operations (keep secret!)
3. **Environment Variables**: Never commit `.env` file
4. **Email Credentials**: Use app passwords, not regular passwords

## Troubleshooting

### Connection Issues
- Verify Supabase URL and keys in `.env`
- Check network connectivity to Supabase
- Verify Supabase project is active

### Authentication Issues
- Check Supabase Auth email provider is enabled
- Verify email confirmation settings
- Check user exists in `auth.users` and `user_profiles`

### Database Issues
- Verify schema was applied correctly
- Check RLS policies are not too restrictive
- Use Supabase dashboard to inspect data

### Email Issues
- Verify SMTP credentials are correct
- Check email provider logs
- Test with Mailtrap for development

## Migration Notes

### Key Changes from SQLite
- **Database**: SQLite → PostgreSQL (Supabase)
- **Authentication**: Custom → Supabase Auth
- **User IDs**: Integer → UUID
- **Timestamps**: SQLite datetime → PostgreSQL TIMESTAMPTZ
- **Query Methods**: Prepared statements → Supabase client

### Data Migration (if needed)
If you have existing SQLite data, you'll need to migrate it manually:
1. Export SQLite data
2. Transform data formats (UUIDs, timestamps)
3. Import to Supabase via SQL Editor or API

## Performance Optimization

Supabase provides built-in optimizations:
- Connection pooling
- Automatic backups
- CDN for static assets
- Edge functions for global distribution

Consider implementing:
- Database indexes (already included in schema)
- Response caching
- Rate limiting for API endpoints

## Monitoring

### Supabase Dashboard
- Monitor database performance
- Track Auth usage
- View API logs
- Check storage usage

### Application Monitoring
- Use PM2 logs for Node.js monitoring
- Implement error tracking (Sentry, etc.)
- Monitor email delivery rates

## Scaling

Supabase free tier includes:
- 500MB database storage
- 1GB file storage
- 2GB bandwidth per month
- 50,000 API requests per month

Upgrade plans available for higher requirements.

## Support Resources

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase Discord](https://discord.supabase.com)
- [Aladhan Prayer Times API](https://aladhan.com/prayer-times-api)
- [Node.js Documentation](https://nodejs.org/docs)

Your app is now ready for Supabase deployment!
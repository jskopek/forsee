# Heroku Deployment Guide

This guide covers deploying EyeSpeak (Eye-Tracking Keyboard) to Heroku.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Configuration Issues & Fixes](#configuration-issues--fixes)
3. [Required Files](#required-files)
4. [Environment Variables](#environment-variables)
5. [Step-by-Step Deployment](#step-by-step-deployment)
6. [Keyboard-UI Deployment Strategy](#keyboard-ui-deployment-strategy)
7. [Post-Deployment Tasks](#post-deployment-tasks)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Heroku CLI installed
- Heroku account
- Git repository connected to Heroku
- Pusher account (for real-time updates)
- OpenAI API key (for AI suggestions)

---

## Configuration Issues & Fixes

### Issues Identified

The current codebase requires several changes for Heroku deployment:

| Issue | Status | Solution |
|-------|--------|----------|
| No Procfile | Missing | Create Procfile with web and worker processes |
| No runtime.txt | Missing | Create to specify Python 3.11 |
| No WhiteNoise | Missing | Add to dependencies and configure for static files |
| No Gunicorn | Missing | Add to dependencies as production WSGI server |
| No psycopg2 | Missing | Add for PostgreSQL support |
| keyboard-ui build | Needs setup | Build React app and copy to Django static |
| Static file hashing | Issue | CRA outputs hashed filenames; need adjustment |

### Keyboard-UI Specific Issues

The React app (keyboard-ui) has a build output mismatch:

- **Current template expects**: `{% static 'keyboard-ui/static/js/main.js' %}`
- **CRA outputs**: `build/static/js/main.[hash].js`

**Solution**: Modify the build process to either:
1. Disable filename hashing in CRA (recommended)
2. Or dynamically load the correct hashed filename

---

## Required Files

### 1. Procfile

Create `Procfile` in the project root:

```
web: gunicorn app.wsgi --log-file -
worker: python manage.py rqworker default
```

### 2. runtime.txt

Create `runtime.txt` in the project root:

```
python-3.11.9
```

### 3. Add Python Dependencies

Add these to `pyproject.toml` dependencies:

```toml
"gunicorn (>=21.0.0,<22.0.0)",
"whitenoise (>=6.6.0,<7.0.0)",
"psycopg2-binary (>=2.9.0,<3.0.0)",
```

### 4. Update Django Settings

Add WhiteNoise to `app/settings.py`:

```python
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',  # Add after SecurityMiddleware
    # ... rest of middleware
]

# Static files configuration for production
STATICFILES_STORAGE = 'whitenoise.storage.CompressedManifestStaticFilesStorage'
```

### 5. Update ALLOWED_HOSTS

Ensure Heroku domains are allowed in `app/settings.py`:

```python
ALLOWED_HOSTS = os.getenv('ALLOWED_HOSTS', '').split(',') if os.getenv('ALLOWED_HOSTS') else []
ALLOWED_HOSTS = [host.strip() for host in ALLOWED_HOSTS if host.strip()]

# Allow Heroku domains
if not DEBUG:
    ALLOWED_HOSTS.extend(['.herokuapp.com'])
```

### 6. Configure CSRF Trusted Origins

For production in `app/settings.py`:

```python
if not DEBUG:
    CSRF_TRUSTED_ORIGINS.extend([
        'https://*.herokuapp.com',
    ])
```

---

## Environment Variables

Set these environment variables on Heroku:

### Required Variables

```bash
# Django
heroku config:set SECRET_KEY='your-secure-secret-key'
heroku config:set DEBUG=False
heroku config:set ALLOWED_HOSTS='your-app.herokuapp.com'

# Database (auto-configured by Heroku Postgres addon)
# DATABASE_URL is set automatically

# Pusher (real-time updates)
heroku config:set PUSHER_APP_ID='your-app-id'
heroku config:set PUSHER_KEY='your-key'
heroku config:set PUSHER_API_SECRET='your-secret'
heroku config:set PUSHER_CLUSTER='us2'

# OpenAI (AI suggestions)
heroku config:set OPENAI_API_KEY='your-api-key'
heroku config:set OPENAI_RESPONSES_MODEL='gpt-4.1-mini'

# Redis (for background jobs)
# REDIS_URL is set automatically by Redis addon
```

### React App Build Variables

For the keyboard-ui React app build:

```bash
# These are used at BUILD time for the React app
heroku config:set REACT_APP_PUSHER_KEY='your-pusher-key'
heroku config:set REACT_APP_PUSHER_CLUSTER='us2'
```

---

## Keyboard-UI Deployment Strategy

### Option 1: Disable Filename Hashing (Recommended)

Create `keyboard-ui/.env.production`:

```
GENERATE_SOURCEMAP=false
INLINE_RUNTIME_CHUNK=false
```

Create `keyboard-ui/build-for-django.sh`:

```bash
#!/bin/bash
set -e

# Build React app
npm run build

# Remove hashes from JS filenames
cd build/static/js
for file in main.*.js; do
    mv "$file" "main.js"
done
for file in main.*.js.map; do
    [ -f "$file" ] && mv "$file" "main.js.map"
done
cd -

# Copy to Django static directory
mkdir -p ../static/keyboard-ui
cp -r build/* ../static/keyboard-ui/

echo "Build complete! Files copied to ../static/keyboard-ui/"
```

### Option 2: Use Heroku Post-Build Script

Add to root `package.json`:

```json
{
  "scripts": {
    "build": "esbuild static/js/main.js --bundle --outfile=static/dist/bundle.js --minify",
    "heroku-postbuild": "cd keyboard-ui && npm install && npm run build && cd .. && node scripts/copy-keyboard-ui.js"
  }
}
```

Create `scripts/copy-keyboard-ui.js`:

```javascript
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '../keyboard-ui/build');
const targetDir = path.join(__dirname, '../static/keyboard-ui');

// Copy build directory
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Rename hashed files
function renameHashedFiles(dir) {
    const jsDir = path.join(dir, 'static/js');
    if (fs.existsSync(jsDir)) {
        const files = fs.readdirSync(jsDir);
        for (const file of files) {
            if (file.match(/^main\.[a-f0-9]+\.js$/)) {
                fs.renameSync(
                    path.join(jsDir, file),
                    path.join(jsDir, 'main.js')
                );
            }
        }
    }
}

copyDir(buildDir, targetDir);
renameHashedFiles(targetDir);

console.log('Keyboard UI copied to static/keyboard-ui/');
```

---

## Step-by-Step Deployment

### 1. Install Dependencies

```bash
# Add Python production dependencies
poetry add gunicorn whitenoise psycopg2-binary
```

### 2. Create Required Files

```bash
# Create Procfile
echo 'web: gunicorn app.wsgi --log-file -
worker: python manage.py rqworker default' > Procfile

# Create runtime.txt
echo 'python-3.11.9' > runtime.txt
```

### 3. Update Settings

Update `app/settings.py` with WhiteNoise and production configurations (see above).

### 4. Create Heroku App

```bash
# Login to Heroku
heroku login

# Create new app
heroku create your-app-name

# Set buildpacks (Node.js first for React build, then Python)
heroku buildpacks:add --index 1 heroku/nodejs
heroku buildpacks:add --index 2 heroku/python
```

### 5. Add Heroku Addons

```bash
# PostgreSQL database
heroku addons:create heroku-postgresql:essential-0

# Redis for background jobs
heroku addons:create heroku-redis:mini
```

### 6. Set Environment Variables

```bash
# Set all required environment variables (see Environment Variables section)
heroku config:set SECRET_KEY='...' DEBUG=False ...
```

### 7. Deploy

```bash
# Push to Heroku
git push heroku main

# Run database migrations
heroku run python manage.py migrate

# Create superuser
heroku run python manage.py createsuperuser

# Create initial site object for django-allauth
heroku run python manage.py shell -c "from django.contrib.sites.models import Site; Site.objects.update_or_create(id=1, defaults={'domain': 'your-app.herokuapp.com', 'name': 'EyeSpeak'})"
```

### 8. Scale Dynos

```bash
# Scale web dyno
heroku ps:scale web=1

# Scale worker dyno (for background jobs)
heroku ps:scale worker=1
```

---

## Post-Deployment Tasks

### 1. Verify Static Files

```bash
heroku run python manage.py collectstatic --noinput
```

### 2. Check Logs

```bash
heroku logs --tail
```

### 3. Test the Application

1. Visit `https://your-app.herokuapp.com`
2. Create an account and log in
3. Create a contact and start a conversation
4. Open the keyboard to verify keyboard-ui loads correctly

### 4. Configure Pusher Webhooks (Optional)

If using Pusher webhooks, configure them in the Pusher dashboard to point to your Heroku app URL.

---

## Troubleshooting

### Static Files Not Loading

1. Ensure WhiteNoise is properly configured
2. Run `collectstatic` again
3. Check that `STATIC_ROOT` is set correctly

```bash
heroku run python manage.py collectstatic --noinput
```

### Keyboard UI Not Loading

1. Check browser console for errors
2. Verify the React build files are in `static/keyboard-ui/`
3. Confirm the file paths match what the template expects

```bash
heroku run ls -la staticfiles/keyboard-ui/static/js/
```

### Database Connection Issues

1. Verify `DATABASE_URL` is set
2. Check Postgres addon status

```bash
heroku config:get DATABASE_URL
heroku pg:info
```

### Background Jobs Not Running

1. Ensure Redis addon is provisioned
2. Check worker dyno is running
3. Verify `REDIS_URL` is set

```bash
heroku ps
heroku config:get REDIS_URL
```

### Pusher Not Working

1. Verify Pusher credentials in Heroku config
2. Check browser console for WebSocket errors
3. Ensure `REACT_APP_PUSHER_KEY` was set before build

---

## File Structure After Setup

```
eye-tracking-keyboard/
├── Procfile                    # NEW
├── runtime.txt                 # NEW
├── scripts/
│   └── copy-keyboard-ui.js     # NEW (for build process)
├── static/
│   ├── dist/                   # Django bundle
│   └── keyboard-ui/            # Built React app
│       ├── index.html
│       └── static/
│           ├── js/
│           │   └── main.js     # Renamed from main.[hash].js
│           └── css/
├── staticfiles/                # Collected static (gitignored)
├── app/
│   ├── settings.py             # MODIFIED (WhiteNoise, ALLOWED_HOSTS)
│   └── ...
├── keyboard-ui/
│   ├── .env.production         # NEW
│   └── ...
└── pyproject.toml              # MODIFIED (new dependencies)
```

---

## Cost Considerations

### Heroku Dynos

- **Basic**: $7/month per dyno (web + worker = $14/month)
- **Standard**: $25/month per dyno

### Addons

- **Postgres Essential-0**: $5/month
- **Redis Mini**: $3/month
- **Total minimum**: ~$22/month

### External Services

- **Pusher**: Free tier available (100K messages/day)
- **OpenAI**: Pay per use (varies by usage)

---

## Security Checklist

- [ ] Set strong `SECRET_KEY`
- [ ] Set `DEBUG=False`
- [ ] Configure `ALLOWED_HOSTS` correctly
- [ ] Set up `CSRF_TRUSTED_ORIGINS`
- [ ] Use HTTPS (Heroku provides this)
- [ ] Keep API keys secure (use Heroku config vars)
- [ ] Review CORS settings for production

---

## Summary

Deploying to Heroku requires:

1. **Creating** Procfile, runtime.txt
2. **Adding** gunicorn, whitenoise, psycopg2-binary dependencies
3. **Configuring** WhiteNoise for static files
4. **Building** keyboard-ui React app and copying to Django static
5. **Setting** all environment variables
6. **Adding** Postgres and Redis addons
7. **Running** migrations and collectstatic

The main challenge is the keyboard-ui React build process, which requires handling CRA's hashed filenames to work with Django's static file serving.

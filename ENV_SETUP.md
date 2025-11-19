# Environment Variables

## Django (.env in project root)

Create a `.env` file in the project root with:

```bash
# Django Settings
SECRET_KEY=your-secret-key-here
DEBUG=True
ALLOWED_HOSTS=localhost,127.0.0.1

# Database (optional - defaults to SQLite)
# DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# Pusher Configuration
PUSHER_APP_ID=your-pusher-app-id
PUSHER_KEY=your-pusher-key
PUSHER_API_SECRET=your-pusher-api-secret
PUSHER_CLUSTER=us2

# React Dev Server (for CORS)
REACT_DEV_SERVER_URL=http://localhost:3000
```

## React App (.env in keyboard-ui/)

Create a `.env` file in `keyboard-ui/` with:

```bash
# Pusher Configuration
REACT_APP_PUSHER_KEY=your-pusher-key-here
REACT_APP_PUSHER_CLUSTER=us2

# API Base URL (optional - defaults to http://localhost:8000 in development)
# REACT_APP_API_BASE_URL=http://localhost:8000
```

**Note:** The `REACT_APP_PUSHER_KEY` should match the `PUSHER_KEY` value from your Django `.env` file.


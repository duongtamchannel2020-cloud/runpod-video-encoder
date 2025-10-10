# Google OAuth Credentials Template

Create the following files in this directory:

## credentials.json
```json
{
  "web": {
    "client_id": "your-client-id.apps.googleusercontent.com",
    "project_id": "your-project-id",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "your-client-secret",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
```

## token.json
```json
{
  "access_token": "your-access-token",
  "refresh_token": "your-refresh-token",
  "scope": "https://www.googleapis.com/auth/drive.readonly",
  "token_type": "Bearer",
  "expiry_date": 1234567890000
}
```

## Docker Build
These files will be copied into the Docker container during build:
```dockerfile
COPY credentials.json /app/credentials.json
COPY token.json /app/token.json
```

**Important**: Never commit these files to git. They contain sensitive OAuth tokens.
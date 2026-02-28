# API Contracts (Scaffold)

## Public
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `GET /api/workspace`
- `POST /api/workspace`
- `POST /api/workspace/select`
- `GET /api/connections`
- `POST /api/connections/:platform/oauth/start`
- `GET /api/connections/:platform/oauth/callback`
- `DELETE /api/connections/:id`
- `POST /api/posts`
- `PATCH /api/posts/:id`
- `POST /api/posts/:id/publish-now`
- `POST /api/posts/:id/schedule`
- `GET /api/posts/:id/status`
- `GET /api/posts?status=&platform=&dateRange=`

## Internal
- `POST /internal/publish/dispatch`
- `POST /internal/publish/execute/:jobId`

## Error Envelope
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body.",
    "details": {}
  }
}
```

## Success Envelope
```json
{
  "data": {}
}
```

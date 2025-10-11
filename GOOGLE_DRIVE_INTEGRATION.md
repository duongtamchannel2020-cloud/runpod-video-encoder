# Google Drive Integration with RunPod

## Mục đích

Cập nhật RunPod handler để:
1. **Download trực tiếp từ Google Drive** thay vì cần upload video trước
2. **Upload tất cả segments và M3U8** lên OSS từ RunPod
3. **Trả về M3U8 URL hoàn chỉnh** cho server chính

## Payload mới cho RunPod

### Format cũ (deprecated):
```json
{
  "input": {
    "action": "encode",
    "videoUrl": "https://storage.example.com/temp-video.mp4",
    "quality": "medium",
    "segments": { "duration": 2 },
    "output": { "uploadToStorage": true, "fakeExtensions": true },
    "ossConfig": { ... }
  }
}
```

### Format mới (recommended):
```json
{
  "input": {
    "action": "encode",
    "driveId": "1BxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxC",
    "md5DriveId": "abc123def456789",
    "googleToken": {
      "access_token": "ya29.a0AfH6SMC...",
      "refresh_token": "1//04...",
      "scope": "https://www.googleapis.com/auth/drive.readonly",
      "token_type": "Bearer",
      "expiry_date": 1234567890123
    },
    "quality": "medium",
    "segments": { "duration": 2 },
    "output": {
      "uploadToStorage": true,
      "fakeExtensions": true
    },
    "ossConfig": {
      "region": "oss-ap-southeast-1",
      "accessKeyId": "LTAI5t...",
      "accessKeySecret": "zbIgFP...",
      "bucket": "hh3d",
      "cdnDomain": "s3.googleapicdn.com",
      "cdnDomainSegments": "cdn.googleapicdn.com"
    },
    "cdnDomains": {
      "m3u8": "s3.googleapicdn.com",
      "segments": "cdn.googleapicdn.com"
    }
  }
}
```

## Response Format

### Thành công - Hoàn tất tất cả:
```json
{
  "success": true,
  "status": "completed",
  "uploadedToStorage": true,
  "m3u8Url": "https://s3.googleapicdn.com/abc123def456789.m3u8",
  "segments": [
    {
      "fileName": "000.png",
      "url": "https://cdn.googleapicdn.com/abc123def456789/000.png",
      "size": 156789
    }
  ],
  "totalSegments": 150,
  "processingTime": 45000,
  "processingTimeSeconds": "45.0"
}
```

### Lỗi:
```json
{
  "error": "Failed to download from Google Drive: Invalid token",
  "details": "Google API returned 401 Unauthorized"
}
```

## Workflow mới

```
1. Server chính gọi RunPod với driveId + googleToken
2. RunPod handler:
   ├── Download video từ Google Drive
   ├── Encode thành HLS segments với NVENC
   ├── Upload segments lên OSS với fake extensions
   ├── Tạo và upload M3U8 lên OSS
   └── Trả về M3U8 URL hoàn chỉnh
3. Server chính nhận M3U8 URL và đánh dấu hoàn tất
4. Không cần download/upload gì thêm!
```

## Lợi ích

### Performance:
- ❌ **Cũ**: Download → Upload temp → RunPod → Download segments → Upload segments → Create M3U8
- ✅ **Mới**: Send token → RunPod does everything → Get M3U8 URL

### Security:
- ✅ Không cần upload file video lên temp storage
- ✅ Google token có thể có TTL ngắn
- ✅ RunPod xử lý trực tiếp từ source

### Efficiency:
- ✅ Giảm từ ~6 bước còn ~2 bước
- ✅ Bandwidth tiết kiệm (~2x ít hơn)
- ✅ Storage temp không cần thiết

## Cấu hình Environment

### Server chính (.env):
```bash
# RunPod
USE_RUNPOD=true
RUNPOD_API_KEY=rpa_...
RUNPOD_TEMPLATE_ID=8jr35xok5enozp
RUNPOD_QUALITY=medium

# OSS (sẽ gửi qua payload)
OSS_REGION=oss-ap-southeast-1
OSS_ACCESS_KEY_ID=LTAI5t...
OSS_ACCESS_KEY_SECRET=zbIgFP...
OSS_BUCKET_NAME=hh3d

# CDN domains
CDN_DOMAIN=s3.googleapicdn.com
CDN_DOMAIN_SEGMENTS=cdn.googleapicdn.com
```

### RunPod Container:
- Không cần environment variables cho OSS
- Nhận tất cả config qua payload
- Auto-cleanup temp files

## Testing

```bash
# Health check
curl -X POST https://api.runpod.ai/v2/YOUR_ENDPOINT/run \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": {"action": "health"}}'

# Google Drive encoding
curl -X POST https://api.runpod.ai/v2/YOUR_ENDPOINT/run \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d @test_payload.json
```

## Error Handling

- ✅ Invalid Google token → Clear error message
- ✅ Drive file not found → 404 with details  
- ✅ OSS upload failed → Retry with exponential backoff
- ✅ Encoding failed → Fallback to local processing
- ✅ Network timeout → Comprehensive logging

## Compatibility

- ✅ **Backward compatible**: Vẫn hỗ trợ `videoUrl` nếu không có `driveId`
- ✅ **Forward compatible**: Server có thể phát hiện RunPod đã hoàn tất
- ✅ **Fallback ready**: Lỗi RunPod → local processing tự động

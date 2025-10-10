# RunPod Serverless Video Encoder v2

GPU-accelerated video encoding using NVIDIA NVENC for RunPod serverless platform.

## Architecture

- **Python Wrapper** (`runpod_wrapper.py`): Bridges RunPod serverless SDK with Node.js handler
- **Node.js Handler** (`handler.js`): Core video processing logic with FFmpeg and NVENC
- **Docker Container**: Based on RunPod PyTorch image with CUDA support

## Features

✅ **Serverless Handler Format** - Proper RunPod integration  
✅ **NVIDIA NVENC Encoding** - Hardware GPU acceleration  
✅ **HLS Output** - Segmented video for streaming  
✅ **Health Monitoring** - System status and GPU checks  
✅ **Auto Cleanup** - Temporary file management  
✅ **Error Handling** - Comprehensive error reporting  

## Supported Actions

### `health`
Returns system status, GPU info, and available tools.

```json
{
  "input": {
    "action": "health"
  }
}
```

### `encode`
Encodes video with NVENC acceleration.

```json
{
  "input": {
    "action": "encode",
    "videoUrl": "https://example.com/video.mp4",
    "outputFormat": "hls",
    "quality": "medium",
    "segments": {
      "duration": 2,
      "format": "ts"
    }
  }
}
```

## Quality Settings

- **high**: CRF 18, slow preset (best quality)
- **medium**: CRF 23, medium preset (balanced)
- **low**: CRF 28, fast preset (fastest)

## Build Instructions

1. Update code in this directory
2. Commit and push to GitHub  
3. GitHub Actions will build and push to Docker Hub
4. Use the new image tag in RunPod template

## Files Structure

```
runpod/
├── Dockerfile              # Container definition
├── package.json           # Node.js dependencies  
├── handler.js             # Main video processing logic
├── runpod_wrapper.py      # Python-Node.js bridge
└── README.md             # This file
```

## Version History

- **v1**: HTTP server format (deprecated)
- **v2**: Serverless handler format (current)

## Docker Tags

- `duongtamchannel2020/video-encoder:v2-serverless` - Latest serverless version
- `duongtamchannel2020/video-encoder:latest-serverless` - Always latest serverless

Built: $(date)
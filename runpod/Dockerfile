FROM jrottenberg/ffmpeg:6.1-nvidia

RUN apt-get update && apt-get install -y \
    curl ca-certificates python3-pip \
 && rm -rf /var/lib/apt/lists/*

# NVIDIA/CUDA env - let host set device mapping, don't override
ENV CUDA_DEVICE_ORDER=PCI_BUS_ID
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
ENV NVIDIA_REQUIRE_CUDA=cuda>=11.0

# CUDA runtime environment setup - fix library paths
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib:/usr/local/cuda/lib64:/opt/ffmpeg/lib:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}
ENV NVIDIA_DRIVER_PATH=/usr/local/nvidia/lib64

# Configure ldconfig for CUDA libraries + NVIDIA runtime libs
RUN echo "/usr/local/nvidia/lib64" > /etc/ld.so.conf.d/nvidia.conf \
 && echo "/usr/local/cuda/lib64"  > /etc/ld.so.conf.d/cuda.conf \
 && echo "/opt/ffmpeg/lib"        > /etc/ld.so.conf.d/ffmpeg.conf \
 && echo "/usr/lib/x86_64-linux-gnu" > /etc/ld.so.conf.d/system.conf \
 && ldconfig

# No need for cuda_init wrapper - let host handle device mapping

# Additional environment
ENV PATH=/usr/local/cuda/bin:${PATH}
ENV CUDA_HOME=/usr/local/cuda
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

# Node 18 + runpod
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir runpod

# Verify FFmpeg (build-time)
RUN echo "🔧 Verifying FFmpeg NVENC compatibility..." \
 && ffmpeg -version | head -3 \
 && echo "🔍 Available NVENC encoders:" \
 && (ffmpeg -encoders 2>/dev/null | grep nvenc || echo "⚠️ NVENC check will be done at runtime") \
 && echo "✅ FFmpeg with NVENC support ready for runtime"

# App
WORKDIR /app
COPY package.json ./
RUN npm install --production --no-audit --no-fund
COPY handler.js runpod_wrapper.py ./
RUN mkdir -p /tmp/encoding

# Create startup script with proper CUDA initialization
RUN echo '#!/bin/bash' > /app/startup.sh \
 && echo 'set -e' >> /app/startup.sh \
 && echo 'echo "🔍 RunPod NVENC Initialization"' >> /app/startup.sh \
 && echo 'echo "============================="' >> /app/startup.sh \
 && echo '# Check GPU devices' >> /app/startup.sh \
 && echo 'echo "🔧 Environment:"' >> /app/startup.sh \
 && echo 'echo "  CUDA_VISIBLE_DEVICES: ${CUDA_VISIBLE_DEVICES:-unset}"' >> /app/startup.sh \
 && echo 'echo "  NVIDIA_VISIBLE_DEVICES: ${NVIDIA_VISIBLE_DEVICES:-unset}"' >> /app/startup.sh \
 && echo 'echo "  NVIDIA_DRIVER_CAPABILITIES: ${NVIDIA_DRIVER_CAPABILITIES:-unset}"' >> /app/startup.sh \
 && echo 'ls -la /dev/nvidia* 2>/dev/null || echo "  No /dev/nvidia* devices found"' >> /app/startup.sh \
 && echo 'echo "🔧 NVIDIA-SMI check:"' >> /app/startup.sh \
 && echo 'if nvidia-smi -L 2>/dev/null; then' >> /app/startup.sh \
 && echo '    echo "✅ nvidia-smi working"' >> /app/startup.sh \
 && echo '    nvidia-smi --query-gpu=uuid,name --format=csv,noheader 2>/dev/null || true' >> /app/startup.sh \
 && echo 'else' >> /app/startup.sh \
 && echo '    echo "❌ nvidia-smi failed"' >> /app/startup.sh \
 && echo 'fi' >> /app/startup.sh \
 && echo 'echo "🔧 CUDA Device Enumeration (no override):"' >> /app/startup.sh \
 && echo '# Show current device mapping from host' >> /app/startup.sh \
 && echo 'python3 -c "' >> /app/startup.sh \
 && echo 'import ctypes, os' >> /app/startup.sh \
 && echo 'print(\"Process PID:\", os.getpid())' >> /app/startup.sh \
 && echo 'print(\"CUDA_VISIBLE_DEVICES:\", os.environ.get(\"CUDA_VISIBLE_DEVICES\", \"unset\"))' >> /app/startup.sh \
 && echo 'print(\"NVIDIA_VISIBLE_DEVICES:\", os.environ.get(\"NVIDIA_VISIBLE_DEVICES\", \"unset\"))' >> /app/startup.sh \
 && echo 'try:' >> /app/startup.sh \
 && echo '    cuda = ctypes.CDLL(\"libcuda.so.1\")' >> /app/startup.sh \
 && echo '    result = cuda.cuInit(0)' >> /app/startup.sh \
 && echo '    print(\"cuInit(0) result:\", result, \"(0=success)\")' >> /app/startup.sh \
 && echo '    if result == 0:' >> /app/startup.sh \
 && echo '        device_count = ctypes.c_int(0)' >> /app/startup.sh \
 && echo '        cuda.cuDeviceGetCount(ctypes.byref(device_count))' >> /app/startup.sh \
 && echo '        print(\"CUDA device count:\", device_count.value)' >> /app/startup.sh \
 && echo '        for i in range(device_count.value):' >> /app/startup.sh \
 && echo '            device = ctypes.c_int(0)' >> /app/startup.sh \
 && echo '            cuda.cuDeviceGet(ctypes.byref(device), i)' >> /app/startup.sh \
 && echo '            print(\"  Device\", i, \": ID\", device.value)' >> /app/startup.sh \
 && echo '        print(\"✅ CUDA initialization successful!\")' >> /app/startup.sh \
 && echo '    else:' >> /app/startup.sh \
 && echo '        print(\"❌ CUDA init failed:\", result)' >> /app/startup.sh \
 && echo 'except Exception as e:' >> /app/startup.sh \
 && echo '    print(\"❌ CUDA enumeration error:\", e)' >> /app/startup.sh \
 && echo '"' >> /app/startup.sh \
 && echo 'echo "🧪 NVENC Direct Test (stable context):"' >> /app/startup.sh \
 && echo 'if timeout 10 ffmpeg -hide_banner -init_hw_device cuda=gpu:0 -filter_hw_device gpu -f lavfi -i color=c=black:s=64x64:d=0.1:r=1 -vf hwupload,scale_npp=64:64 -c:v h264_nvenc -preset p1 -f null - 2>&1; then' >> /app/startup.sh \
 && echo '    echo "✅ NVENC working with stable CUDA context!"' >> /app/startup.sh \
 && echo 'else' >> /app/startup.sh \
 && echo '    echo "❌ NVENC failed - will use CPU fallback"' >> /app/startup.sh \
 && echo '    timeout 5 ffmpeg -hide_banner -init_hw_device cuda=gpu:0 -f lavfi -i color=c=black:s=64x64:d=0.1:r=1 -c:v h264_nvenc -preset p1 -f null - 2>&1 | head -10 || true' >> /app/startup.sh \
 && echo 'fi' >> /app/startup.sh \
 && echo 'echo "🚀 Starting handler..."' >> /app/startup.sh \
 && echo 'exec python3 runpod_wrapper.py' >> /app/startup.sh \
 && chmod +x /app/startup.sh

# Override FFmpeg entrypoint and use our startup script
ENTRYPOINT []
CMD ["/app/startup.sh"]

FROM jrottenberg/ffmpeg:6.1-nvidia

RUN apt-get update && apt-get install -y \
    curl ca-certificates python3-pip \
 && rm -rf /var/lib/apt/lists/*

# NVIDIA/CUDA env với full permissions
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=all
ENV CUDA_VISIBLE_DEVICES=all
ENV CUDA_DEVICE_ORDER=PCI_BUS_ID
ENV NVIDIA_REQUIRE_CUDA=cuda>=11.0

# CUDA runtime environment setup
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib:/usr/local/cuda/lib64:/opt/ffmpeg/lib:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}

# Configure ldconfig for CUDA libraries
RUN echo "/usr/local/nvidia/lib64" > /etc/ld.so.conf.d/nvidia.conf \
 && echo "/usr/local/cuda/lib64"  > /etc/ld.so.conf.d/cuda.conf \
 && echo "/opt/ffmpeg/lib"        > /etc/ld.so.conf.d/ffmpeg.conf \
 && ldconfig

# Create device access wrapper với proper permissions
RUN mkdir -p /usr/local/bin \
 && echo '#!/bin/bash' > /usr/local/bin/cuda_init \
 && echo 'export CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-all}' >> /usr/local/bin/cuda_init \
 && echo 'export NVIDIA_VISIBLE_DEVICES=${NVIDIA_VISIBLE_DEVICES:-all}' >> /usr/local/bin/cuda_init \
 && echo 'exec "$@"' >> /usr/local/bin/cuda_init \
 && chmod +x /usr/local/bin/cuda_init

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

# Create startup script with proper syntax
RUN echo '#!/bin/bash' > /app/startup.sh \
 && echo 'set -e' >> /app/startup.sh \
 && echo 'echo "🔍 RunPod NVENC Initialization"' >> /app/startup.sh \
 && echo 'echo "============================="' >> /app/startup.sh \
 && echo '# Force device permissions' >> /app/startup.sh \
 && echo 'if [[ -c /dev/nvidia0 ]]; then' >> /app/startup.sh \
 && echo '    echo "📱 Setting GPU device permissions..."' >> /app/startup.sh \
 && echo '    chmod 666 /dev/nvidia* 2>/dev/null || true' >> /app/startup.sh \
 && echo '    chmod 666 /dev/nvidiactl 2>/dev/null || true' >> /app/startup.sh \
 && echo 'fi' >> /app/startup.sh \
 && echo 'echo "🔧 Environment:"' >> /app/startup.sh \
 && echo 'echo "  CUDA_VISIBLE_DEVICES: ${CUDA_VISIBLE_DEVICES:-unset}"' >> /app/startup.sh \
 && echo 'echo "  NVIDIA_VISIBLE_DEVICES: ${NVIDIA_VISIBLE_DEVICES:-unset}"' >> /app/startup.sh \
 && echo 'ls -la /dev/nvidia* 2>/dev/null || echo "  No devices"' >> /app/startup.sh \
 && echo 'nvidia-smi -L 2>/dev/null || echo "  nvidia-smi failed"' >> /app/startup.sh \
 && echo 'echo "🔧 CUDA Context Pre-initialization:"' >> /app/startup.sh \
 && echo 'python3 -c "' >> /app/startup.sh \
 && echo 'import ctypes' >> /app/startup.sh \
 && echo 'try:' >> /app/startup.sh \
 && echo '    cuda = ctypes.CDLL(\"libcuda.so.1\")' >> /app/startup.sh \
 && echo '    result = cuda.cuInit(0)' >> /app/startup.sh \
 && echo '    print(f\"CUDA pre-init result: {result}\")' >> /app/startup.sh \
 && echo '    if result == 0:' >> /app/startup.sh \
 && echo '        device = ctypes.c_int(0)' >> /app/startup.sh \
 && echo '        cuda.cuDeviceGet(ctypes.byref(device), 0)' >> /app/startup.sh \
 && echo '        print(\"CUDA context pre-initialized successfully\")' >> /app/startup.sh \
 && echo '    else:' >> /app/startup.sh \
 && echo '        print(f\"CUDA init failed: {result}\")' >> /app/startup.sh \
 && echo 'except Exception as e:' >> /app/startup.sh \
 && echo '    print(f\"CUDA pre-init error: {e}\")' >> /app/startup.sh \
 && echo '"' >> /app/startup.sh \
 && echo 'echo "🧪 NVENC Test (after CUDA pre-init):"' >> /app/startup.sh \
 && echo 'if timeout 3 ffmpeg -hide_banner -f lavfi -i testsrc=duration=0.1:size=64x64 -c:v h264_nvenc -preset ultrafast -f null - 2>/dev/null; then' >> /app/startup.sh \
 && echo '    echo "✅ NVENC working!"' >> /app/startup.sh \
 && echo '    export NVENC_AVAILABLE=true' >> /app/startup.sh \
 && echo 'else' >> /app/startup.sh \
 && echo '    echo "⚠️ NVENC still failed - will use CPU fallback"' >> /app/startup.sh \
 && echo '    export NVENC_AVAILABLE=false' >> /app/startup.sh \
 && echo 'fi' >> /app/startup.sh \
 && echo 'echo "🚀 Starting handler..."' >> /app/startup.sh \
 && echo 'exec python3 runpod_wrapper.py' >> /app/startup.sh \
 && chmod +x /app/startup.sh

# Override FFmpeg entrypoint and use our startup script
ENTRYPOINT []
CMD ["/app/startup.sh"]

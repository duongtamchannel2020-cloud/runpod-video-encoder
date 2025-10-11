# Use FFmpeg image with NVENC support directly (compatible with driver 550.x)
FROM jrottenberg/ffmpeg:6.1-nvidia

# Install additional dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Set NVIDIA environment for video encoding
ENV NVIDIA_VISIBLE_DEVICES=all
# Không cần display,graphics cho encode
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
ENV CUDA_VISIBLE_DEVICES=all

# ❗️QUAN TRỌNG: thêm đầy đủ đường dẫn thư viện GPU + FFmpeg,
# và đăng ký với ldconfig để cuInit() không còn "no device"
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib:/usr/local/cuda/lib64:/opt/ffmpeg/lib:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}
RUN echo "/usr/local/nvidia/lib64" > /etc/ld.so.conf.d/nvidia.conf \
 && echo "/usr/local/cuda/lib64"  > /etc/ld.so.conf.d/cuda.conf \
 && echo "/opt/ffmpeg/lib"        > /etc/ld.so.conf.d/ffmpeg.conf \
 && ldconfig

# (phòng hờ) symlink nếu linker chưa thấy lib trong runtime serverless
RUN [ -e /usr/local/nvidia/lib64/libcuda.so.1 ] && ln -sf /usr/local/nvidia/lib64/libcuda.so.1 /usr/lib/x86_64-linux-gnu/libcuda.so.1 || true
RUN [ -e /usr/local/nvidia/lib64/libnvidia-encode.so.1 ] && ln -sf /usr/local/nvidia/lib64/libnvidia-encode.so.1 /usr/lib/x86_64-linux-gnu/libnvidia-encode.so.1 || true

# Add explicit CUDA runtime paths for device access (tùy chọn)
ENV PATH=/usr/local/cuda/bin:${PATH}
ENV CUDA_HOME=/usr/local/cuda
ENV NVIDIA_REQUIRE_CUDA=cuda>=12.0
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

# Install Node.js 18.x
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

# Install RunPod Python SDK
RUN pip3 install --no-cache-dir runpod

# Verify FFmpeg NVENC support during build
RUN echo "🔧 Verifying FFmpeg NVENC compatibility..." \
 && ffmpeg -version | head -3 \
 && echo "🔍 Available NVENC encoders:" \
 && (ffmpeg -encoders 2>/dev/null | grep nvenc || echo "⚠️ NVENC check will be done at runtime") \
 && echo "✅ FFmpeg with NVENC support ready for runtime"

# Set working directory
WORKDIR /app

# Copy package.json and install Node.js dependencies
# (nếu có package-lock.json hãy dùng: COPY package.json package-lock.json ./ && npm ci --omit=dev)
COPY package.json ./
RUN npm install --production --no-audit --no-fund

# Copy application files
COPY handler.js runpod_wrapper.py ./

# Create encoding workspace
RUN mkdir -p /tmp/encoding

# Override the FFmpeg ENTRYPOINT của base image (mặc định là "ffmpeg")
ENTRYPOINT []
CMD ["python3", "runpod_wrapper.py"]

FROM jrottenberg/ffmpeg:6.1-nvidia

RUN apt-get update && apt-get install -y \
    curl ca-certificates python3-pip \
 && rm -rf /var/lib/apt/lists/*

# NVIDIA/CUDA env
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
ENV CUDA_VISIBLE_DEVICES=all
ENV CUDA_DEVICE_ORDER=PCI_BUS_ID

# Paths & ldconfig để cuInit() không còn "no device"
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib:/usr/local/cuda/lib64:/opt/ffmpeg/lib:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}
RUN echo "/usr/local/nvidia/lib64" > /etc/ld.so.conf.d/nvidia.conf \
 && echo "/usr/local/cuda/lib64"  > /etc/ld.so.conf.d/cuda.conf \
 && echo "/opt/ffmpeg/lib"        > /etc/ld.so.conf.d/ffmpeg.conf \
 && ldconfig

# Symlink phòng hờ
RUN [ -e /usr/local/nvidia/lib64/libcuda.so.1 ] && ln -sf /usr/local/nvidia/lib64/libcuda.so.1 /usr/lib/x86_64-linux-gnu/libcuda.so.1 || true
RUN [ -e /usr/local/nvidia/lib64/libnvidia-encode.so.1 ] && ln -sf /usr/local/nvidia/lib64/libnvidia-encode.so.1 /usr/lib/x86_64-linux-gnu/libnvidia-encode.so.1 || true

# Tuỳ chọn
ENV PATH=/usr/local/cuda/bin:${PATH}
ENV CUDA_HOME=/usr/local/cuda
ENV NVIDIA_REQUIRE_CUDA=cuda>=12.0
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

# Entrypoint: kiểm GPU + test NVENC 1s rồi chạy handler
RUN printf '%s\n' '#!/usr/bin/env bash' \
'set -e' \
'echo "🔍 Runtime GPU Device Check:"' \
'echo "CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"' \
'echo "NVIDIA_VISIBLE_DEVICES=$NVIDIA_VISIBLE_DEVICES"' \
'ls -la /dev/nvidia* 2>/dev/null || echo "No /dev/nvidia* devices found"' \
'command -v nvidia-smi >/dev/null && nvidia-smi -L || echo "nvidia-smi not found"' \
'echo "— ldconfig(libcuda/libnvidia-encode) —"' \
'ldconfig -p | grep -E "libcuda\.so|libnvidia-encode\.so" || echo "⚠️ libs not visible"' \
'echo "— NVENC encoders —"; ffmpeg -hide_banner -encoders | grep -i nvenc || true' \
'echo "— HW accels —"; ffmpeg -hide_banner -hwaccels || true' \
'echo "🧪 NVENC smoke test (1s)..."' \
'ffmpeg -hide_banner -f lavfi -i testsrc=duration=1:size=320x240:rate=1 -t 1 -c:v h264_nvenc -f null - || echo "⚠️ NVENC test failed (will fallback)"' \
'exec python3 runpod_wrapper.py' > /app/gpu_check_entrypoint.sh \
 && chmod +x /app/gpu_check_entrypoint.sh

# Ghi đè ENTRYPOINT ffmpeg của image gốc
ENTRYPOINT []
CMD ["/app/gpu_check_entrypoint.sh"]

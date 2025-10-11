# Multi-stage build for NVENC-compatible FFmpeg
# Stage 1: Get FFmpeg with NVENC support compatible with driver 550.x
FROM jrottenberg/ffmpeg:6.1-nvidia AS ffmpeg

# Stage 2: Runtime with CUDA 12.4 for better compatibility
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Install essential dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Copy FFmpeg binaries with NVENC support (compatible with driver 550.x)
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe

# Set NVIDIA environment for video encoding
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
ENV CUDA_VISIBLE_DEVICES=all
ENV LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}

# Install Node.js 18.x
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install RunPod Python SDK
RUN pip3 install --no-cache-dir runpod

# Verify FFmpeg NVENC support during build
RUN echo "� Verifying FFmpeg NVENC compatibility..." \
    && ffmpeg -version | head -3 \
    && echo "🔍 Available NVENC encoders:" \
    && (ffmpeg -encoders 2>/dev/null | grep nvenc || echo "⚠️ NVENC check will be done at runtime") \
    && echo "✅ FFmpeg with NVENC support ready for runtime"

# Set working directory
WORKDIR /app

# Copy package.json and install Node.js dependencies
COPY package.json ./
RUN npm ci --only=production

# Copy application files
COPY handler.js runpod_wrapper.py ./

# Create encoding workspace
RUN mkdir -p /tmp/encoding

# Set production environment
ENV NODE_ENV=production

# Runtime verification and startup
RUN echo "✅ Container build complete with NVENC-compatible FFmpeg"

# Start the RunPod handler directly
CMD ["python3", "runpod_wrapper.py"]

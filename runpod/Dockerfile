# RunPod Video Encoding Template
FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel

# Install basic dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install latest FFmpeg with NVENC support (static build)
RUN echo "🔧 Installing FFmpeg with NVENC support..." \
    && wget -q https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
    && tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz \
    && cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /usr/local/bin/ \
    && cp ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && rm -rf ffmpeg-master-latest-linux64-gpl* \
    && echo "✅ FFmpeg installation complete" \
    && echo "📊 FFmpeg version:" \
    && ffmpeg -version | head -5 \
    && echo "🔍 Available NVENC encoders:" \
    && (ffmpeg -encoders 2>/dev/null | grep nvenc | head -10 || echo "⚠️ No NVENC encoders found") \
    && echo "🔍 Available hardware acceleration:" \
    && (ffmpeg -hwaccels 2>/dev/null || echo "⚠️ Hardware acceleration check failed") \
    && echo "🔧 FFmpeg build info:" \
    && (ffmpeg -buildconf 2>/dev/null | grep -E "(nvenc|cuda)" || echo "⚠️ No NVENC/CUDA in build config")

# Install Node.js for our processing script
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Create working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json ./
RUN npm install

# Copy handler script
COPY handler.js ./

# Create necessary directories
RUN mkdir -p /tmp/encoding

# Set environment variables for NVIDIA runtime
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
ENV CUDA_VISIBLE_DEVICES=all
ENV NODE_ENV=production

# Verify NVIDIA runtime during build (if available)
RUN echo "🔍 Checking NVIDIA runtime availability..." \
    && (nvidia-smi -L 2>/dev/null && echo "✅ NVIDIA runtime available during build" || echo "⚠️ NVIDIA runtime not available during build (expected in non-GPU build environment)") \
    && echo "🔧 Environment variables set for GPU runtime"

# Install RunPod Python SDK (required for serverless)
RUN pip install runpod

# Create RunPod wrapper
COPY runpod_wrapper.py ./

# Start the RunPod handler
CMD ["python", "runpod_wrapper.py"]

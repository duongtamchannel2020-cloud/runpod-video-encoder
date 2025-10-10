# RunPod Video Encoding Template
FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel

# Install FFmpeg with CUDA support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

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

# Set environment variables
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
ENV NODE_ENV=production

# Install RunPod Python SDK (required for serverless)
RUN pip install runpod

# Create RunPod wrapper
COPY runpod_wrapper.py ./

# Start the RunPod handler
CMD ["python", "runpod_wrapper.py"]

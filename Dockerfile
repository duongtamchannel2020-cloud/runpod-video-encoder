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

# Copy encoding script
COPY encode-worker.js ./

# Create necessary directories
RUN mkdir -p /app/temp /app/output

# Set environment variables
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

# Expose port for health check
EXPOSE 8080

# Start the worker
CMD ["node", "encode-worker.js"]

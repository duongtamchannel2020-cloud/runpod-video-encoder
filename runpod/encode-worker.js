import express from 'express'
import multer from 'multer'
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import winston from 'winston'

const app = express()
const port = process.env.RUNPOD_TCP_PORT_8080 || 8080

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
})

// Multer setup for file uploads
const upload = multer({ 
  dest: '/app/temp/',
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB limit
})

app.use(express.json())

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    gpu: process.env.NVIDIA_VISIBLE_DEVICES || 'not_available',
    timestamp: new Date().toISOString()
  })
})

// Main encoding endpoint
app.post('/encode', upload.single('video'), async (req, res) => {
  const startTime = Date.now()
  logger.info('Encoding request received')

  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded' })
  }

  const { 
    segmentTime = 2,
    quality = 'medium',
    outputFormat = 'hls'
  } = req.body

  const inputPath = req.file.path
  const outputDir = `/app/output/${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  
  try {
    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true })
    fs.mkdirSync(path.join(outputDir, 'ts'), { recursive: true })

    // Get video properties
    const videoProps = await getVideoProperties(inputPath)
    logger.info(`Video properties: ${JSON.stringify(videoProps)}`)

    // Encode with NVIDIA NVENC
    const encodeResult = await encodeWithNVENC(inputPath, outputDir, {
      segmentTime: Number(segmentTime),
      quality,
      videoProps
    })

    // Rename segments with fake extensions
    await renameSegmentsWithFakeExtensions(path.join(outputDir, 'ts'))

    // Prepare response
    const outputFiles = fs.readdirSync(path.join(outputDir, 'ts'))
    const m3u8Content = fs.readFileSync(path.join(outputDir, 'index.m3u8'), 'utf8')

    const processingTime = Date.now() - startTime
    logger.info(`Encoding completed in ${processingTime}ms`)

    res.json({
      success: true,
      processingTime,
      segmentCount: outputFiles.length,
      m3u8Content,
      downloadUrl: `/download/${path.basename(outputDir)}`
    })

  } catch (error) {
    logger.error(`Encoding error: ${error.message}`)
    res.status(500).json({ 
      error: 'Encoding failed', 
      details: error.message 
    })
  } finally {
    // Cleanup input file
    fs.unlinkSync(inputPath)
  }
})

// Download encoded results
app.get('/download/:outputId', (req, res) => {
  const outputDir = `/app/output/${req.params.outputId}`
  
  if (!fs.existsSync(outputDir)) {
    return res.status(404).json({ error: 'Output not found' })
  }

  // Create tar archive of the output
  const { spawn } = require('child_process')
  const tar = spawn('tar', ['-czf', '-', '-C', outputDir, '.'])
  
  res.setHeader('Content-Type', 'application/gzip')
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.outputId}.tar.gz"`)
  
  tar.stdout.pipe(res)
  
  tar.on('close', () => {
    // Cleanup output directory after download
    fs.rmSync(outputDir, { recursive: true, force: true })
    logger.info(`Cleaned up output directory: ${outputDir}`)
  })
})

// Get video properties
const getVideoProperties = (videoPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err)

      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video')
      if (!videoStream) return reject(new Error('No video stream found'))

      let fps = 30
      if (videoStream.avg_frame_rate) {
        const [num, den] = videoStream.avg_frame_rate.split('/').map(Number)
        fps = den ? num / den : num
      }

      resolve({
        fps,
        width: videoStream.width,
        height: videoStream.height,
        duration: metadata.format.duration
      })
    })
  })
}

// Encode with NVIDIA NVENC
const encodeWithNVENC = (inputPath, outputDir, options) => {
  return new Promise((resolve, reject) => {
    const { segmentTime, quality, videoProps } = options
    const { fps, width, height } = videoProps

    // Quality settings
    let cq, maxrate, bufsize
    if (height >= 1080) {
      cq = quality === 'high' ? '18' : quality === 'low' ? '28' : '23'
      maxrate = '6000k'
      bufsize = '12000k'
    } else if (height >= 720) {
      cq = quality === 'high' ? '20' : quality === 'low' ? '30' : '25'
      maxrate = '4000k'
      bufsize = '8000k'
    } else {
      cq = quality === 'high' ? '22' : quality === 'low' ? '32' : '27'
      maxrate = '2500k'
      bufsize = '5000k'
    }

    const gopSize = Math.round(fps * segmentTime)

    const args = [
      '-y',
      '-hwaccel', 'cuda',
      '-hwaccel_output_format', 'cuda',
      '-i', inputPath,

      // NVENC H.264 encoding
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',  // Faster preset for NVENC
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      
      // Quality settings
      '-cq', cq,
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-rc', 'vbr',
      
      // GOP settings
      '-g', gopSize.toString(),
      '-keyint_min', gopSize.toString(),
      '-force_key_frames', `expr:gte(t,n_forced*${segmentTime})`,
      
      // Audio
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-ar', '48000',
      
      // HLS settings
      '-hls_time', segmentTime.toString(),
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-hls_list_size', '0',
      '-start_number', '0',
      '-hls_segment_filename', path.join(outputDir, 'ts', '%03d.ts'),
      '-f', 'hls',
      path.join(outputDir, 'index.m3u8')
    ]

    logger.info(`NVENC command: ffmpeg ${args.join(' ')}`)

    const proc = spawn('ffmpeg', args)
    let logs = ''

    proc.stderr.on('data', (data) => {
      logs += data.toString()
      // Log encoding progress
      if (data.toString().includes('time=')) {
        const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/)
        if (match) {
          logger.info(`Encoding progress: ${match[1]}`)
        }
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        const tsFiles = fs.readdirSync(path.join(outputDir, 'ts')).filter(f => f.endsWith('.ts'))
        logger.info(`NVENC encoding completed. Created ${tsFiles.length} segments`)
        resolve({ segmentCount: tsFiles.length })
      } else {
        logger.error(`NVENC encoding failed with code ${code}: ${logs}`)
        reject(new Error(`FFmpeg process exited with code ${code}`))
      }
    })

    proc.on('error', (err) => {
      logger.error(`NVENC process error: ${err}`)
      reject(err)
    })
  })
}

// Rename segments with fake extensions
const renameSegmentsWithFakeExtensions = async (tsDir) => {
  const fakeExtensions = ['.jpg', '.png', '.webp', '.css', '.js', '.ico', '.svg', '.gif', '.txt', '.html']
  const tsFiles = fs.readdirSync(tsDir).filter(file => file.endsWith('.ts'))
  
  for (const tsFile of tsFiles) {
    const randomExt = fakeExtensions[Math.floor(Math.random() * fakeExtensions.length)]
    const baseName = path.parse(tsFile).name
    const newFileName = `${baseName}${randomExt}`
    
    const oldPath = path.join(tsDir, tsFile)
    const newPath = path.join(tsDir, newFileName)
    
    fs.renameSync(oldPath, newPath)
    logger.info(`Renamed ${tsFile} -> ${newFileName}`)
  }
}

app.listen(port, '0.0.0.0', () => {
  logger.info(`RunPod Video Encoder listening on port ${port}`)
  logger.info(`GPU: ${process.env.NVIDIA_VISIBLE_DEVICES || 'Not available'}`)
})

import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import axios from 'axios'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// RunPod serverless handler
const handler = async (event) => {
    const { input } = event
    
    console.log('🚀 RunPod Handler received input:', JSON.stringify(input, null, 2))
    
    try {
        // Handle different actions
        switch (input.action) {
            case 'health':
                return await handleHealthCheck()
            case 'encode':
                return await handleVideoEncoding(input)
            default:
                return {
                    error: `Unknown action: ${input.action}. Supported actions: health, encode`
                }
        }
    } catch (error) {
        console.error('❌ Handler error:', error)
        return {
            error: error.message,
            stack: error.stack
        }
    }
}

// Health check handler
const handleHealthCheck = async () => {
    console.log('🩺 Performing health check...')
    
    const healthInfo = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        gpu: process.env.NVIDIA_VISIBLE_DEVICES || 'not_available',
        cuda_version: process.env.CUDA_VERSION || 'unknown',
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        }
    }
    
    // Check FFmpeg availability
    try {
        await new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', ['-version'])
            let output = ''
            
            proc.stdout.on('data', (data) => {
                output += data.toString()
            })
            
            proc.on('close', (code) => {
                if (code === 0) {
                    const version = output.match(/ffmpeg version ([^\s]+)/)?.[1] || 'unknown'
                    healthInfo.ffmpeg_version = version
                    healthInfo.ffmpeg_available = true
                    resolve()
                } else {
                    healthInfo.ffmpeg_available = false
                    reject(new Error('FFmpeg not available'))
                }
            })
            
            setTimeout(() => reject(new Error('FFmpeg check timeout')), 5000)
        })
    } catch (error) {
        healthInfo.ffmpeg_available = false
        healthInfo.ffmpeg_error = error.message
    }
    
    // Check NVIDIA-SMI
    try {
        await new Promise((resolve, reject) => {
            const proc = spawn('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'])
            let output = ''
            
            proc.stdout.on('data', (data) => {
                output += data.toString()
            })
            
            proc.on('close', (code) => {
                if (code === 0) {
                    healthInfo.nvidia_smi = output.trim()
                    healthInfo.gpu_available = true
                    resolve()
                } else {
                    healthInfo.gpu_available = false
                    reject(new Error('nvidia-smi failed'))
                }
            })
            
            setTimeout(() => reject(new Error('nvidia-smi timeout')), 5000)
        })
    } catch (error) {
        healthInfo.gpu_available = false
        healthInfo.gpu_error = error.message
    }
    
    console.log('✅ Health check completed:', healthInfo)
    return healthInfo
}

// Video encoding handler
const handleVideoEncoding = async (input) => {
    console.log('🎬 Starting video encoding...')
    
    const {
        videoUrl,
        outputFormat = 'hls',
        quality = 'medium',
        segments = { duration: 2, format: 'ts' }
    } = input
    
    if (!videoUrl) {
        throw new Error('videoUrl is required for encoding')
    }
    
    const startTime = Date.now()
    const workDir = '/tmp/encoding'
    const inputFile = path.join(workDir, 'input.mp4')
    const outputDir = path.join(workDir, 'output')
    const tsDir = path.join(outputDir, 'ts')
    
    // Create directories
    fs.mkdirSync(workDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })
    fs.mkdirSync(tsDir, { recursive: true })
    
    try {
        // Step 1: Download video
        console.log('📥 Downloading video from:', videoUrl)
        await downloadVideo(videoUrl, inputFile)
        
        const fileSize = fs.statSync(inputFile).size
        console.log(`✅ Downloaded ${(fileSize / 1024 / 1024).toFixed(2)}MB`)
        
        // Step 2: Get video info
        const videoInfo = await getVideoInfo(inputFile)
        console.log('📊 Video info:', videoInfo)
        
        // Step 3: Encode with NVENC
        console.log('🚀 Starting NVENC encoding...')
        const encodeResult = await encodeWithNVENC(inputFile, outputDir, quality, segments.duration)
        
        // Step 4: Read output files
        const m3u8Content = fs.readFileSync(path.join(outputDir, 'index.m3u8'), 'utf8')
        const tsFiles = fs.readdirSync(tsDir).filter(f => f.endsWith('.ts'))
        
        const processingTime = Date.now() - startTime
        
        const result = {
            status: 'completed',
            processingTime: processingTime,
            processingTimeSeconds: (processingTime / 1000).toFixed(2),
            videoInfo: videoInfo,
            output: {
                format: outputFormat,
                segmentCount: tsFiles.length,
                segmentDuration: segments.duration,
                playlist: m3u8Content,
                segments: tsFiles.map(file => ({
                    name: file,
                    size: fs.statSync(path.join(tsDir, file)).size
                }))
            },
            performance: {
                inputSizeMB: (fileSize / 1024 / 1024).toFixed(2),
                outputSizeMB: tsFiles.reduce((total, file) => {
                    return total + fs.statSync(path.join(tsDir, file)).size
                }, 0) / 1024 / 1024,
                speedup: encodeResult.speedup || 'unknown'
            }
        }
        
        console.log('🎉 Encoding completed successfully!')
        console.log(`⚡ Processing time: ${result.processingTimeSeconds}s`)
        console.log(`📊 Created ${result.output.segmentCount} segments`)
        
        return result
        
    } finally {
        // Cleanup
        try {
            if (fs.existsSync(workDir)) {
                fs.rmSync(workDir, { recursive: true, force: true })
                console.log('🗑️ Cleaned up working directory')
            }
        } catch (error) {
            console.warn('⚠️ Cleanup warning:', error.message)
        }
    }
}

// Helper functions
const downloadVideo = async (url, outputPath) => {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 300000 // 5 minutes
    })
    
    const writer = fs.createWriteStream(outputPath)
    response.data.pipe(writer)
    
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
    })
}

const getVideoInfo = async (inputFile) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputFile, (err, metadata) => {
            if (err) {
                reject(err)
            } else {
                const videoStream = metadata.streams.find(s => s.codec_type === 'video')
                resolve({
                    duration: metadata.format.duration,
                    size: metadata.format.size,
                    bitrate: metadata.format.bit_rate,
                    width: videoStream?.width,
                    height: videoStream?.height,
                    fps: eval(videoStream?.r_frame_rate) || 30
                })
            }
        })
    })
}

const encodeWithNVENC = async (inputFile, outputDir, quality, segmentTime) => {
    return new Promise((resolve, reject) => {
        const qualitySettings = {
            high: { crf: 18, preset: 'slow' },
            medium: { crf: 23, preset: 'medium' },
            low: { crf: 28, preset: 'fast' }
        }
        
        const settings = qualitySettings[quality] || qualitySettings.medium
        const gopSize = Math.round(30 * segmentTime) // GOP size based on segment duration
        
        const args = [
            '-i', inputFile,
            '-c:v', 'h264_nvenc',
            '-preset', settings.preset,
            '-cq', settings.crf.toString(),
            '-g', gopSize.toString(),
            '-keyint_min', gopSize.toString(),
            '-force_key_frames', `expr:gte(t,n_forced*${segmentTime})`,
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ac', '2',
            '-ar', '48000',
            '-hls_time', segmentTime.toString(),
            '-hls_playlist_type', 'vod',
            '-hls_flags', 'independent_segments',
            '-hls_list_size', '0',
            '-start_number', '0',
            '-hls_segment_filename', path.join(outputDir, 'ts', '%03d.ts'),
            '-f', 'hls',
            path.join(outputDir, 'index.m3u8')
        ]
        
        console.log('🔧 NVENC command: ffmpeg', args.join(' '))
        
        const startTime = Date.now()
        const proc = spawn('ffmpeg', args)
        let logs = ''
        
        proc.stderr.on('data', (data) => {
            logs += data.toString()
            // Log progress
            if (data.toString().includes('time=')) {
                const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/)
                if (match) {
                    console.log(`⏱️ Progress: ${match[1]}`)
                }
            }
        })
        
        proc.on('close', (code) => {
            const processingTime = Date.now() - startTime
            
            if (code === 0) {
                const tsFiles = fs.readdirSync(path.join(outputDir, 'ts')).filter(f => f.endsWith('.ts'))
                console.log(`✅ NVENC encoding completed in ${processingTime}ms`)
                console.log(`📊 Created ${tsFiles.length} segments`)
                
                resolve({
                    segmentCount: tsFiles.length,
                    processingTime: processingTime,
                    speedup: `${(processingTime / 1000).toFixed(1)}s`
                })
            } else {
                console.error(`❌ NVENC encoding failed with code ${code}`)
                console.error('FFmpeg logs:', logs)
                reject(new Error(`FFmpeg process exited with code ${code}`))
            }
        })
        
        proc.on('error', (err) => {
            console.error('❌ NVENC process error:', err)
            reject(err)
        })
    })
}

// Export the handler for RunPod
export default handler

// For local testing
if (process.env.NODE_ENV !== 'production') {
    // Test locally
    const testEvent = {
        input: {
            action: 'health'
        }
    }
    
    handler(testEvent).then(result => {
        console.log('Local test result:', JSON.stringify(result, null, 2))
    }).catch(console.error)
}

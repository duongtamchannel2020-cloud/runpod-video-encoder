import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import axios from 'axios'
import { google } from 'googleapis'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// RunPod serverless handler with full Google Drive support
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

// Initialize Google Drive API with proper authentication
const initGoogleDrive = async () => {
    try {
        console.log('🔐 Initializing Google Drive API...')
        
        // Read credentials and token from container
        const credentials = JSON.parse(fs.readFileSync('/app/credentials.json', 'utf8'))
        const token = JSON.parse(fs.readFileSync('/app/token.json', 'utf8'))

        const { client_secret, client_id, redirect_uris } = credentials.web || credentials.installed
        const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])

        oauth2Client.setCredentials(token)

        // Try to refresh token if needed
        try {
            await oauth2Client.getAccessToken()
        } catch (error) {
            console.log('🔄 Refreshing access token...')
            const { credentials: newCredentials } = await oauth2Client.refreshAccessToken()
            oauth2Client.setCredentials(newCredentials)
            
            // Save refreshed token (though it won't persist in serverless)
            try {
                fs.writeFileSync('/app/token.json', JSON.stringify(newCredentials, null, 2))
                console.log('✅ Token refreshed')
            } catch (writeError) {
                console.log('⚠️ Could not save refreshed token (expected in serverless)')
            }
        }

        const drive = google.drive({ version: 'v3', auth: oauth2Client })
        console.log('✅ Google Drive API initialized')
        return drive
        
    } catch (error) {
        console.error('❌ Error initializing Google Drive API:', error.message)
        throw new Error(`Google Drive API initialization failed: ${error.message}`)
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
            total: Math.round(require('os').totalmem() / 1024 / 1024 / 1024),
            used: Math.round((require('os').totalmem() - require('os').freemem()) / 1024 / 1024 / 1024)
        },
        ffmpeg_available: await checkFFmpegAvailable(),
        gpu_available: await checkGPUAvailable(),
        google_drive_available: false
    }
    
    // Test Google Drive API
    try {
        const drive = await initGoogleDrive()
        // Try to access Drive API
        await drive.about.get({ fields: 'user' })
        healthInfo.google_drive_available = true
        console.log('✅ Google Drive API is working')
    } catch (error) {
        console.log('⚠️ Google Drive API not available:', error.message)
        healthInfo.google_drive_error = error.message
    }
    
    // Check NVIDIA GPU
    try {
        const { stdout } = await execPromise('nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits')
        healthInfo.nvidia_smi = stdout.trim()
    } catch (error) {
        healthInfo.nvidia_smi = 'Not available'
    }
    
    return healthInfo
}

// Video encoding handler with Google Drive support
const handleVideoEncoding = async (input) => {
    console.log('🎬 Starting video encoding...')
    
    const startTime = Date.now()
    
    // Validate input - support both videoUrl and driveId
    if (!input.videoUrl && !input.driveId) {
        throw new Error('Either videoUrl or driveId is required for encoding')
    }
    
    const quality = input.quality || 'medium'
    const segments = input.segments || { duration: 2 }
    const outputFormat = 'hls'
    
    console.log(`📋 Encoding parameters:`)
    console.log(`   Quality: ${quality}`)
    console.log(`   Segment duration: ${segments.duration}s`)
    console.log(`   Output format: ${outputFormat}`)
    
    // Setup working directories
    const workDir = '/tmp/encoding'
    const inputFile = path.join(workDir, 'input.mp4')
    const outputDir = path.join(workDir, 'output')
    const tsDir = path.join(outputDir, 'ts')
    
    // Clean and create directories
    if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true })
    }
    fs.mkdirSync(workDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })
    fs.mkdirSync(tsDir, { recursive: true })
    
    try {
        // Step 1: Download video (support both URL and Google Drive)
        if (input.driveId) {
            console.log('📁 Downloading from Google Drive ID:', input.driveId)
            await downloadFromGoogleDrive(input.driveId, inputFile)
        } else {
            console.log('📥 Downloading video from:', input.videoUrl)
            await downloadVideo(input.videoUrl, inputFile)
        }
        
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
        return result
        
    } catch (error) {
        console.error('❌ Encoding failed:', error)
        throw error
    } finally {
        // Cleanup
        if (fs.existsSync(workDir)) {
            fs.rmSync(workDir, { recursive: true, force: true })
            console.log('🧹 Cleaned up temporary files')
        }
    }
}

// Google Drive download function with proper authentication
const downloadFromGoogleDrive = async (driveId, outputPath) => {
    console.log(`📁 Downloading from Google Drive: ${driveId}`)
    
    try {
        const drive = await initGoogleDrive()
        
        // Get file metadata
        const fileMetadata = await drive.files.get({
            fileId: driveId,
            fields: 'name,size,mimeType'
        })
        
        console.log('📋 File metadata:')
        console.log(`   Name: ${fileMetadata.data.name}`)
        console.log(`   Size: ${Math.round(fileMetadata.data.size / 1024 / 1024)}MB`)
        console.log(`   Type: ${fileMetadata.data.mimeType}`)
        
        // Download file using Google Drive API
        const response = await drive.files.get({
            fileId: driveId,
            alt: 'media'
        }, {
            responseType: 'stream'
        })
        
        // Save to file
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(outputPath)
            response.data.pipe(writer)
            
            let downloadedBytes = 0
            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length
                if (downloadedBytes % (10 * 1024 * 1024) === 0) { // Log every 10MB
                    console.log(`   Downloaded: ${Math.round(downloadedBytes / 1024 / 1024)}MB`)
                }
            })
            
            writer.on('finish', () => {
                console.log('✅ Google Drive download completed')
                resolve()
            })
            
            writer.on('error', (error) => {
                console.error('❌ Download failed:', error)
                reject(error)
            })
        })
        
    } catch (error) {
        console.error('❌ Google Drive download failed:', error.message)
        throw new Error(`Failed to download from Google Drive ${driveId}: ${error.message}`)
    }
}

// Download video from regular URL
const downloadVideo = async (url, outputPath) => {
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath)
        
        axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            timeout: 300000 // 5 minutes
        }).then(response => {
            response.data.pipe(writer)
            
            writer.on('finish', resolve)
            writer.on('error', reject)
        }).catch(reject)
    })
}

// Get video information using ffprobe
const getVideoInfo = async (inputFile) => {
    const command = `ffprobe -v quiet -print_format json -show_format -show_streams "${inputFile}"`
    const { stdout } = await execPromise(command)
    const probe = JSON.parse(stdout)
    
    const videoStream = probe.streams.find(s => s.codec_type === 'video')
    if (!videoStream) {
        throw new Error('No video stream found')
    }
    
    return {
        width: videoStream.width,
        height: videoStream.height,
        duration: parseFloat(probe.format.duration),
        bitrate: parseInt(probe.format.bit_rate),
        fps: eval(videoStream.r_frame_rate),
        size: parseInt(probe.format.size)
    }
}

// Encode video with NVENC
const encodeWithNVENC = async (inputFile, outputDir, quality, segmentDuration) => {
    const startTime = Date.now()
    
    // Quality settings
    const qualityPresets = {
        low: { crf: 28, preset: 'fast', scale: '640:360' },
        medium: { crf: 23, preset: 'medium', scale: '1280:720' },
        high: { crf: 18, preset: 'slow', scale: '1920:1080' }
    }
    
    const settings = qualityPresets[quality] || qualityPresets.medium
    
    const outputFile = path.join(outputDir, 'index.m3u8')
    const tsPattern = path.join(outputDir, 'ts', '%03d.ts')
    
    // FFmpeg command with NVENC
    const command = [
        'ffmpeg', '-y',
        '-hwaccel', 'cuda',
        '-i', inputFile,
        '-c:v', 'h264_nvenc',
        '-preset', settings.preset,
        '-crf', settings.crf.toString(),
        '-vf', `scale=${settings.scale}`,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'hls',
        '-hls_time', segmentDuration.toString(),
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', tsPattern,
        outputFile
    ].join(' ')
    
    console.log(`🔧 FFmpeg command: ${command}`)
    
    try {
        const { stdout, stderr } = await execPromise(command)
        const endTime = Date.now()
        const duration = (endTime - startTime) / 1000
        
        // Parse encoding stats from stderr
        const speedMatch = stderr.match(/speed=([0-9.]+)x/)
        const speedup = speedMatch ? speedMatch[1] + 'x' : 'unknown'
        
        console.log(`✅ NVENC encoding completed in ${duration}s (speed: ${speedup})`)
        
        return {
            duration: duration,
            speedup: speedup,
            command: command
        }
        
    } catch (error) {
        console.error('❌ FFmpeg encoding failed:', error.message)
        throw error
    }
}

// Utility functions
const execPromise = (command) => {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process')
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(error)
            } else {
                resolve({ stdout, stderr })
            }
        })
    })
}

const checkFFmpegAvailable = async () => {
    try {
        await execPromise('ffmpeg -version')
        return true
    } catch {
        return false
    }
}

const checkGPUAvailable = async () => {
    try {
        await execPromise('nvidia-smi')
        return true
    } catch {
        return false
    }
}

// Export handler for RunPod
export { handler }
export default handler
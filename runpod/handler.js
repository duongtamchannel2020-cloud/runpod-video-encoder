import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import axios from 'axios'
import OSS from 'ali-oss'
import { google } from 'googleapis'

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
        driveId,
        googleToken,
        md5DriveId,
        outputFormat = 'hls',
        quality = 'medium',
        segments = { duration: 2, format: 'ts' },
        output = {},
        ossConfig = null,
        cdnDomains = {}
    } = input
    
    // Support both videoUrl (legacy) and driveId (new method)
    if (!videoUrl && !driveId) {
        throw new Error('Either videoUrl or driveId is required for encoding')
    }
    
    if (driveId && !googleToken) {
        throw new Error('googleToken is required when using driveId')
    }
    
    if (!md5DriveId) {
        throw new Error('md5DriveId is required for output organization')
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
        let fileSize
        if (driveId) {
            console.log('📥 Downloading video from Google Drive ID:', driveId)
            await downloadVideoFromGoogleDrive(driveId, googleToken, inputFile)
        } else {
            console.log('📥 Downloading video from URL:', videoUrl)
            await downloadVideo(videoUrl, inputFile)
        }
        
        fileSize = fs.statSync(inputFile).size
        console.log(`✅ Downloaded ${(fileSize / 1024 / 1024).toFixed(2)}MB`)
        
        // Step 2: Get video info
        const videoInfo = await getVideoInfo(inputFile)
        console.log('📊 Video info:', videoInfo)
        
        // Step 3: Encode with NVENC
        console.log('🚀 Starting NVENC encoding...')
        const encodeResult = await encodeWithNVENC(inputFile, outputDir, quality, segments.duration)
        
        // Step 4: Process output files
        const m3u8Content = fs.readFileSync(path.join(outputDir, 'master.m3u8'), 'utf8')
        const tsFiles = fs.readdirSync(tsDir).filter(f => f.endsWith('.ts'))
        
        console.log(`📊 Created ${tsFiles.length} TS segments`)
        
        let segmentsData = []
        let uploadedSegments = []
        
        // Check if we should upload to OSS storage
        if (ossConfig && output.uploadToStorage) {
            console.log('☁️ Uploading segments to OSS storage...')
            uploadedSegments = await uploadSegmentsToOSS(tsDir, tsFiles, ossConfig, output.fakeExtensions, md5DriveId)
            
            // Step 5: Create and upload M3U8 playlist to OSS
            console.log('📋 Creating and uploading M3U8 playlist to OSS...')
            const m3u8Url = await createAndUploadM3U8ToOSS(
                uploadedSegments, 
                m3u8Content, 
                ossConfig, 
                md5DriveId, 
                cdnDomains,
                segments.duration
            )
            
            // Return format for server download
            segmentsData = uploadedSegments
        } else {
            // Original format (local files only) 
            segmentsData = tsFiles.map(file => ({
                name: file,
                size: fs.statSync(path.join(tsDir, file)).size
            }))
        }
        
        const processingTime = Date.now() - startTime
        
        const result = {
            success: true, // Add success flag for server validation
            status: 'completed',
            processingTime: processingTime,
            processingTimeSeconds: (processingTime / 1000).toFixed(2),
            videoInfo: videoInfo,
            output: {
                format: outputFormat,
                segmentCount: tsFiles.length,
                segmentDuration: segments.duration,
                playlist: m3u8Content,
                segments: segmentsData
            },
            performance: {
                inputSizeMB: (fileSize / 1024 / 1024).toFixed(2),
                outputSizeMB: tsFiles.reduce((total, file) => {
                    return total + fs.statSync(path.join(tsDir, file)).size
                }, 0) / 1024 / 1024,
                speedup: encodeResult.speedup || 'unknown'
            }
        }
        
        // If uploaded to storage, add the segments array at top level for server compatibility
        if (uploadedSegments.length > 0) {
            result.segments = uploadedSegments
            result.totalSegments = uploadedSegments.length
            result.m3u8Url = result.m3u8Url || `https://${cdnDomains.m3u8 || ossConfig.cdnDomain}/${md5DriveId}/master.m3u8`
            result.uploadedToStorage = true
            console.log(`✅ Uploaded ${uploadedSegments.length} segments + M3U8 to OSS`)
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

// Download video from Google Drive using OAuth token
const downloadVideoFromGoogleDrive = async (driveId, token, outputPath) => {
    console.log(`📥 Downloading from Google Drive: ${driveId}`)
    
    try {
        // Get file metadata first to check size
        const metadataResponse = await axios.get(
            `https://www.googleapis.com/drive/v3/files/${driveId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token.access_token}`
                },
                params: {
                    fields: 'size,name,mimeType'
                },
                timeout: 30000
            }
        )
        
        const { size, name, mimeType } = metadataResponse.data
        console.log(`📊 File info: ${name}, size: ${(size / 1024 / 1024).toFixed(2)}MB, type: ${mimeType}`)
        
        // Download file content
        const downloadResponse = await axios({
            method: 'GET',
            url: `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media`,
            headers: {
                'Authorization': `Bearer ${token.access_token}`
            },
            responseType: 'stream',
            timeout: 600000 // 10 minutes for large files
        })
        
        const writer = fs.createWriteStream(outputPath)
        downloadResponse.data.pipe(writer)
        
        return new Promise((resolve, reject) => {
            let downloadedBytes = 0
            
            downloadResponse.data.on('data', (chunk) => {
                downloadedBytes += chunk.length
                const percent = ((downloadedBytes / size) * 100).toFixed(1)
                if (downloadedBytes % (5 * 1024 * 1024) === 0) { // Log every 5MB
                    console.log(`📥 Downloaded: ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(1)}MB)`)
                }
            })
            
            writer.on('finish', () => {
                console.log(`✅ Google Drive download completed: ${(downloadedBytes / 1024 / 1024).toFixed(2)}MB`)
                resolve()
            })
            writer.on('error', reject)
        })
        
    } catch (error) {
        console.error('❌ Google Drive download failed:', error.message)
        if (error.response) {
            console.error('Response status:', error.response.status)
            console.error('Response data:', error.response.data)
        }
        throw new Error(`Failed to download from Google Drive: ${error.message}`)
    }
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
    // Check if NVENC is available first
    const useNVENC = await checkNVENCAvailability()
    
    return new Promise((resolve, reject) => {
        const qualitySettings = {
            high: { qp: 20, preset: 'p4' },
            medium: { qp: 25, preset: 'p4' },
            low: { qp: 30, preset: 'p6' }
        }
        
        const settings = qualitySettings[quality] || qualitySettings.medium
        const gopSize = Math.round(30 * segmentTime) // GOP size based on segment duration
        
        let args
        if (useNVENC) {
            console.log('🚀 Using NVIDIA NVENC GPU encoding')
            args = [
                '-y',
                '-hwaccel', 'cuda',
                '-hwaccel_output_format', 'cuda',
                '-i', inputFile,
                
                // NVENC Pipeline with GPU filters
                '-vf', 'scale_cuda=trunc(iw/2)*2:trunc(ih/2)*2,hwdownload,format=yuv420p,eq=contrast=1.15:saturation=1.28:brightness=0.05:gamma=0.95,unsharp=5:5:1.2:5:5:0.8',
                
                // NVENC H.264 encoding
                '-c:v', 'h264_nvenc',
                '-preset', settings.preset,
                '-rc', 'constqp',
                '-qp', settings.qp.toString(),
                '-profile:v', 'high',
                '-level', '4.1',
                '-bf', '2',
                '-spatial_aq', '1',
                '-temporal_aq', '1',
                
                // GOP settings
                '-g', gopSize.toString(),
                '-keyint_min', gopSize.toString(),
                '-force_key_frames', `expr:gte(t,n_forced*${segmentTime})`,
                
                // Audio
                '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
                
                // HLS
                '-hls_time', segmentTime.toString(),
                '-hls_playlist_type', 'vod',
                '-hls_flags', 'independent_segments',
                '-hls_list_size', '0',
                '-start_number', '0',
                '-hls_segment_filename', path.join(outputDir, 'ts', '%03d.ts'),
                '-f', 'hls',
                path.join(outputDir, 'master.m3u8')
            ]
            console.log('🎨 GPU Enhancement: CUDA + NVENC + Contrast+1.15 + Saturation+1.28')
        } else {
            console.log('⚠️ NVENC not available, using software encoding')
            args = [
                '-y',
                '-i', inputFile,
                
                // Software encoding with CPU filters
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=full:flags=lanczos,eq=contrast=1.15:saturation=1.28:brightness=0.05:gamma=0.95,unsharp=5:5:1.2:5:5:0.8',
                
                // x264 software encoding
                '-c:v', 'libx264',
                '-preset', 'fast', // Faster for CPU
                '-crf', '23',
                '-profile:v', 'high',
                '-level', '4.1',
                '-bf', '2',
                
                // GOP settings
                '-g', gopSize.toString(),
                '-keyint_min', gopSize.toString(),
                '-sc_threshold', '0',
                '-force_key_frames', `expr:gte(t,n_forced*${segmentTime})`,
                
                // Audio
                '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
                
                // HLS
                '-hls_time', segmentTime.toString(),
                '-hls_playlist_type', 'vod',
                '-hls_flags', 'independent_segments',
                '-hls_list_size', '0',
                '-start_number', '0',
                '-hls_segment_filename', path.join(outputDir, 'ts', '%03d.ts'),
                '-f', 'hls',
                path.join(outputDir, 'master.m3u8')
            ]
            console.log('🎨 CPU Enhancement: x264 + Contrast+1.15 + Saturation+1.28')
        }
        
        console.log('🔧 FFmpeg command: ffmpeg', args.join(' '))
        
        const startTime = Date.now()
        const proc = spawn('ffmpeg', args)
        let logs = ''
        let lastProgressTime = 0
        
        proc.stderr.on('data', (data) => {
            const output = data.toString()
            logs += output
            
            // Enhanced progress logging
            if (output.includes('time=')) {
                const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/)
                const speedMatch = output.match(/speed=\s*([0-9.]+)x/)
                const fpsMatch = output.match(/fps=\s*([0-9.]+)/)
                
                if (timeMatch) {
                    const currentTime = Date.now()
                    if (currentTime - lastProgressTime > 5000) { // Log every 5 seconds
                        lastProgressTime = currentTime
                        const progress = `⏱️ Progress: ${timeMatch[1]}`
                        const speed = speedMatch ? ` | Speed: ${speedMatch[1]}x` : ''
                        const fps = fpsMatch ? ` | FPS: ${fpsMatch[1]}` : ''
                        console.log(progress + speed + fps)
                    }
                }
            }
            
            // Log encoding method info
            if (output.includes('h264_nvenc') || output.includes('nvenc')) {
                console.log('🚀 NVENC GPU encoding active')
            }
            if (output.includes('libx264')) {
                console.log('💻 Software x264 encoding active')
            }
            
            // Log any warnings or errors
            if (output.includes('deprecated') || output.includes('warning')) {
                console.warn('⚠️ Warning:', output.trim())
            }
        })
        
        proc.on('close', (code) => {
            const processingTime = Date.now() - startTime
            const processingSeconds = processingTime / 1000
            
            if (code === 0) {
                const tsFiles = fs.readdirSync(path.join(outputDir, 'ts')).filter(f => f.endsWith('.ts'))
                console.log(`✅ ${useNVENC ? 'NVENC GPU' : 'Software'} encoding completed in ${processingSeconds.toFixed(2)}s`)
                console.log(`📊 Created ${tsFiles.length} segments`)
                
                // Calculate encoding speed
                let speedMultiplier = 'unknown'
                const speedMatch = logs.match(/speed=\s*([0-9.]+)x/)
                if (speedMatch) {
                    speedMultiplier = `${speedMatch[1]}x realtime`
                }
                
                resolve({
                    segmentCount: tsFiles.length,
                    processingTime: processingTime,
                    speedup: speedMultiplier,
                    encodingMethod: useNVENC ? 'NVENC GPU' : 'Software x264'
                })
            } else {
                console.error(`❌ ${useNVENC ? 'NVENC' : 'Software'} encoding failed with code ${code}`)
                console.error('FFmpeg error logs:')
                console.error(logs.slice(-1000)) // Last 1000 chars of logs
                reject(new Error(`FFmpeg process exited with code ${code}. Check logs above.`))
            }
        })
        
        proc.on('error', (err) => {
            console.error('❌ FFmpeg process error:', err)
            reject(err)
        })
    })
}

// Check NVENC availability
const checkNVENCAvailability = async () => {
    return new Promise((resolve) => {
        console.log('🔍 Checking NVENC availability...')
        
        // Check if nvidia-smi works first
        const nvidiaCheck = spawn('nvidia-smi', ['-L'])
        let hasNvidiaGPU = false
        
        nvidiaCheck.stdout.on('data', (data) => {
            const output = data.toString()
            if (output.includes('GPU') && output.includes('GeForce')) {
                hasNvidiaGPU = true
                console.log('✅ NVIDIA GPU detected:', output.trim())
            }
        })
        
        nvidiaCheck.on('close', (code) => {
            if (!hasNvidiaGPU || code !== 0) {
                console.log('❌ No NVIDIA GPU detected, using software encoding')
                resolve(false)
                return
            }
            
            // Test NVENC encoding capability
            const testArgs = [
                '-f', 'lavfi',
                '-i', 'testsrc=duration=1:size=320x240:rate=1',
                '-c:v', 'h264_nvenc',
                '-t', '1',
                '-f', 'null',
                '-'
            ]
            
            console.log('🧪 Testing NVENC: ffmpeg', testArgs.join(' '))
            const testProc = spawn('ffmpeg', testArgs)
            let testError = false
            
            testProc.stderr.on('data', (data) => {
                const output = data.toString()
                if (output.includes('nvenc') && (output.includes('error') || output.includes('failed') || output.includes('not found'))) {
                    testError = true
                    console.log('❌ NVENC test failed:', output.trim())
                }
            })
            
            testProc.on('close', (testCode) => {
                if (testCode === 0 && !testError) {
                    console.log('✅ NVENC is available and working!')
                    resolve(true)
                } else {
                    console.log('❌ NVENC test failed, using software encoding')
                    console.log('💡 This may be due to:')
                    console.log('   - FFmpeg not compiled with NVENC support')
                    console.log('   - Missing NVIDIA drivers')
                    console.log('   - GPU not supporting NVENC')
                    resolve(false)
                }
            })
            
            // Timeout test after 10 seconds
            setTimeout(() => {
                testProc.kill()
                console.log('⏰ NVENC test timeout, using software encoding')
                resolve(false)
            }, 10000)
        })
        
        // Timeout nvidia-smi check
        setTimeout(() => {
            nvidiaCheck.kill()
            console.log('⏰ NVIDIA check timeout, using software encoding')
            resolve(false)
        }, 5000)
    })
}

// Upload segments to OSS storage and return download URLs
const uploadSegmentsToOSS = async (tsDir, tsFiles, ossConfig, useFakeExtensions = true, md5DriveId) => {
    console.log('🔧 Initializing OSS client...')
    
    try {
        const client = new OSS({
            region: ossConfig.region,
            accessKeyId: ossConfig.accessKeyId,
            accessKeySecret: ossConfig.accessKeySecret,
            bucket: ossConfig.bucket
        })
        
        console.log(`✅ OSS client initialized for bucket: ${ossConfig.bucket}`)
        
        // Define fake extensions for CDN bypass
        const fakeExtensions = ['.png', '.jpg', '.webp', '.css', '.js', '.ico', '.svg', '.gif', '.txt', '.html']
        const uploadedSegments = []
        
        for (let i = 0; i < tsFiles.length; i++) {
            const tsFile = tsFiles[i]
            const localPath = path.join(tsDir, tsFile)
            
            // Create filename with fake extension if requested
            let remoteFileName
            if (useFakeExtensions) {
                const randomExt = fakeExtensions[Math.floor(Math.random() * fakeExtensions.length)]
                const baseName = path.parse(tsFile).name // Remove .ts extension
                remoteFileName = `${baseName}${randomExt}`
            } else {
                remoteFileName = tsFile
            }
            
            // Create remote path in md5DriveId folder
            const remotePath = `${md5DriveId}/${remoteFileName}`
            
            console.log(`📤 Uploading ${i + 1}/${tsFiles.length}: ${tsFile} -> ${remotePath}`)
            
            // Upload file to OSS
            const uploadResult = await client.put(remotePath, localPath, {
                headers: {
                    'Content-Type': useFakeExtensions ? getContentTypeForFakeExtension(remoteFileName) : 'video/mp2t',
                    'Cache-Control': 'public, max-age=31536000' // 1 year cache
                }
            })
            
            // Create download URL using segments CDN domain
            const downloadUrl = `https://${ossConfig.cdnDomainSegments || ossConfig.cdnDomain}/${remotePath}`
            
            uploadedSegments.push({
                fileName: remoteFileName,
                url: downloadUrl,
                size: fs.statSync(localPath).size,
                uploadTime: new Date().toISOString()
            })
            
            console.log(`✅ Uploaded: ${downloadUrl}`)
        }
        
        console.log(`🎉 Successfully uploaded ${uploadedSegments.length} segments to OSS`)
        return uploadedSegments
        
    } catch (error) {
        console.error('❌ OSS upload failed:', error)
        throw new Error(`Failed to upload segments to OSS: ${error.message}`)
    }
}

// Create and upload M3U8 playlist to OSS
const createAndUploadM3U8ToOSS = async (segments, originalM3u8Content, ossConfig, md5DriveId, cdnDomains, segmentDuration) => {
    console.log('📋 Creating M3U8 playlist for OSS upload...')
    
    try {
        const client = new OSS({
            region: ossConfig.region,
            accessKeyId: ossConfig.accessKeyId,
            accessKeySecret: ossConfig.accessKeySecret,
            bucket: ossConfig.bucket
        })
        
        // Extract target duration from original M3U8 or use default
        let targetDuration = segmentDuration || 2
        const targetDurationMatch = originalM3u8Content.match(/#EXT-X-TARGETDURATION:(\d+)/)
        if (targetDurationMatch) {
            targetDuration = parseInt(targetDurationMatch[1])
        }
        
        // Extract segment durations from original M3U8
        const originalDurations = []
        const lines = originalM3u8Content.split('\n')
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXTINF:')) {
                const durationMatch = lines[i].match(/#EXTINF:([0-9.]+),/)
                if (durationMatch) {
                    originalDurations.push(durationMatch[1])
                }
            }
        }
        
        console.log(`📊 Found ${originalDurations.length} segment durations, target duration: ${targetDuration}`)
        
        // Sort segments by filename to ensure correct order
        segments.sort((a, b) => {
            const numA = parseInt(a.fileName.split('.')[0], 10)
            const numB = parseInt(b.fileName.split('.')[0], 10)
            return numA - numB
        })
        
        // Create M3U8 content
        let playlistContent = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:0\n`
        
        // Add segments with correct durations
        segments.forEach((segment, index) => {
            const duration = index < originalDurations.length 
                ? originalDurations[index] 
                : `${segmentDuration}.000000`
            
            playlistContent += `#EXTINF:${duration},\n${segment.url}\n`
        })
        
        playlistContent += '#EXT-X-ENDLIST'
        
        console.log(`📝 Created M3U8 with ${segments.length} segments`)
        
        // Upload M3U8 to OSS - INSIDE the same folder as segments for easier deletion
        const m3u8Path = `${md5DriveId}/master.m3u8`  // Put M3U8 inside folder, not outside
        const uploadResult = await client.put(m3u8Path, Buffer.from(playlistContent), {
            headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'public, max-age=3600' // 1 hour cache for playlist
            }
        })
        
        const m3u8Url = `https://${cdnDomains.m3u8 || ossConfig.cdnDomain}/${m3u8Path}`
        
        console.log(`✅ M3U8 uploaded to: ${m3u8Url}`)
        return m3u8Url
        
    } catch (error) {
        console.error('❌ M3U8 upload failed:', error)
        throw new Error(`Failed to upload M3U8 to OSS: ${error.message}`)
    }
}

// Get appropriate content type for fake extensions
const getContentTypeForFakeExtension = (fileName) => {
    const ext = path.extname(fileName).toLowerCase()
    const contentTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.html': 'text/html',
        '.txt': 'text/plain',
        '.ico': 'image/x-icon'
    }
    return contentTypes[ext] || 'application/octet-stream'
}

// Export the handler for RunPod
export default handler

// For local testing
if (process.env.NODE_ENV !== 'production') {
    // Test locally
    const testEvent = {
        input: {
            action: 'health'
            // For NEW Google Drive encoding test:
            // action: 'encode',
            // driveId: '1BxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxC',
            // md5DriveId: 'abc123def456', 
            // googleToken: {
            //     access_token: 'ya29.xxxxxxxxx',
            //     refresh_token: 'xxxxxxxxx',
            //     scope: 'https://www.googleapis.com/auth/drive.readonly',
            //     token_type: 'Bearer',
            //     expiry_date: 1234567890123
            // },
            // quality: 'medium',
            // segments: { duration: 2 },
            // output: {
            //     uploadToStorage: true,
            //     fakeExtensions: true
            // },
            // ossConfig: {
            //     region: 'oss-ap-southeast-1',
            //     accessKeyId: 'your-access-key',
            //     accessKeySecret: 'your-secret',
            //     bucket: 'hh3d',
            //     cdnDomain: 's3.googleapicdn.com',        // For M3U8
            //     cdnDomainSegments: 'cdn.googleapicdn.com' // For TS segments
            // },
            // cdnDomains: {
            //     m3u8: 's3.googleapicdn.com',
            //     segments: 'cdn.googleapicdn.com'
            // }
            
            // For legacy videoUrl encoding test:
            // action: 'encode',
            // videoUrl: 'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4',
            // md5DriveId: 'test123',
            // quality: 'medium',
            // segments: { duration: 2 },
            // output: {
            //     uploadToStorage: true,
            //     fakeExtensions: true
            // },
            // ossConfig: { ... }
        }
    }
    
    handler(testEvent).then(result => {
        console.log('Local test result:', JSON.stringify(result, null, 2))
    }).catch(console.error)
}

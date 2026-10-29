import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { ensureMinioBucket } from '@/lib/storage/bootstrap'

/**
 * The system video test stubs the upload and returns this key, then
 * inspectGeneratedVideo reads the object back from storage.
 */
const SYSTEM_VIDEO_KEY = 'video/system-video.mp4'
const RETRY_ATTEMPTS = 15
const RETRY_DELAY_MS = 2_000

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

async function withRetry<T>(label: string, action: () => Promise<T>): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await action()
    } catch (error: unknown) {
      lastError = error
      console.error(`[ci:minio] ${label} attempt ${attempt}/${RETRY_ATTEMPTS} failed`)
      console.error(error)
      if (attempt < RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }
  }
  throw lastError ?? new Error(`[ci:minio] ${label} failed`)
}

function renderSystemVideo(filePath: string) {
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=64x64:d=1',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    filePath,
  ], { stdio: 'inherit' })
}

async function main() {
  const endpoint = requireEnv('MINIO_ENDPOINT')
  const bucket = requireEnv('MINIO_BUCKET')
  const accessKeyId = requireEnv('MINIO_ACCESS_KEY')
  const secretAccessKey = requireEnv('MINIO_SECRET_KEY')
  const region = process.env.MINIO_REGION?.trim() || 'us-east-1'
  const forcePathStyle = process.env.MINIO_FORCE_PATH_STYLE !== 'false'

  const bucketResult = await withRetry('ensure bucket', () => ensureMinioBucket())
  console.log(`[ci:minio] bucket "${bucket}" ${bucketResult}`)

  const directory = await mkdtemp(path.join(tmpdir(), 'ci-minio-'))
  try {
    const filePath = path.join(directory, 'system-video.mp4')
    renderSystemVideo(filePath)
    const body = await readFile(filePath)
    const client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    })
    await withRetry('upload system video', async () => {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: SYSTEM_VIDEO_KEY,
        Body: body,
        ContentType: 'video/mp4',
      }))
    })
    console.log(`[ci:minio] uploaded ${SYSTEM_VIDEO_KEY} (${body.length} bytes)`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error('[ci:minio] failed to prepare storage')
  console.error(error)
  process.exit(1)
})

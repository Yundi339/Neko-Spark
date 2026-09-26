import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import sharp from 'sharp'
import type { MediaKind } from '@shared/types'

const IMAGE_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.avif',
  '.jfif'
])

const VIDEO_EXT = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.avi',
  '.webm',
  '.3gp',
  '.3gpp',
  '.m4v',
  '.ts',
  '.flv',
  '.wmv',
  '.mpeg',
  '.mpg'
])

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.3gp': 'video/3gpp',
  '.3gpp': 'video/3gpp',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg'
}

export function detectKind(filePath: string): MediaKind | undefined {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return undefined
}

export function guessMime(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export interface ImageMetadata {
  width?: number
  height?: number
  orientation?: number
  dateTaken?: number
}

/** 读取图片尺寸 / 方向 / 拍摄时间（EXIF 优先，失败则留空由调用方回退到文件时间） */
export async function readImageMetadata(filePath: string): Promise<ImageMetadata> {
  const result: ImageMetadata = {}

  try {
    const meta = await sharp(filePath, { failOn: 'none' }).metadata()
    if (meta.width) result.width = meta.width
    if (meta.height) result.height = meta.height
    if (meta.orientation) result.orientation = meta.orientation
  } catch {
    // 无法读取尺寸时忽略
  }

  // BMP：sharp 预编译的 libvips 没有 BMP 加载器，metadata() 必定失败，
  // 尺寸直接从文件头读（缩略图那边由子进程的兜底解码器负责，这里只补尺寸/比例）
  if (!result.width && extname(filePath).toLowerCase() === '.bmp') {
    const size = await readBmpSize(filePath)
    if (size) {
      result.width = size.width
      result.height = size.height
    }
  }

  try {
    const exifr = await import('exifr')
    const exif = (await exifr.default.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate']
    })) as { DateTimeOriginal?: Date; CreateDate?: Date; ModifyDate?: Date } | undefined
    const date = exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.ModifyDate
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      result.dateTaken = date.getTime()
    }
  } catch {
    // 无 EXIF 或解析失败时忽略
  }

  return result
}

/**
 * 从 BMP 文件头读尺寸（BITMAPINFOHEADER：宽 18、高 22，高为负表示自上而下存）。
 * 非 BMP / 文件太小 / 数值不合理都返回 null —— 宁可没有尺寸，也不能瞎写。
 */
async function readBmpSize(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const fd = await open(filePath, 'r')
    try {
      const head = Buffer.alloc(26)
      const { bytesRead } = await fd.read(head, 0, head.length, 0)
      if (bytesRead < 26 || head[0] !== 0x42 || head[1] !== 0x4d) return null // 'BM'
      const width = head.readInt32LE(18)
      const height = Math.abs(head.readInt32LE(22))
      if (width <= 0 || height <= 0) return null
      return { width, height }
    } finally {
      await fd.close()
    }
  } catch {
    return null
  }
}

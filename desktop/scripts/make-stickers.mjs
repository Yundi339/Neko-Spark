#!/usr/bin/env node
/**
 * 生成吉祥物贴图（原创蓝白猫娘风格，与"猫羽雫"原作无关）。
 * 用法：node scripts/make-stickers.mjs
 * 输出：src/renderer/src/assets/stickers/*.svg
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const outDir = resolve(import.meta.dirname, '..', 'src', 'renderer', 'src', 'assets', 'stickers')
mkdirSync(outDir, { recursive: true })

const DEFS = `
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="70%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#e6f3ff"/>
      <stop offset="100%" stop-color="#cfe8ff"/>
    </radialGradient>
    <linearGradient id="hair" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="#eaf7ff"/>
      <stop offset="45%" stop-color="#c2e5ff"/>
      <stop offset="100%" stop-color="#8fc7f5"/>
    </linearGradient>
    <linearGradient id="hairBack" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0%" stop-color="#a9d8ff"/>
      <stop offset="100%" stop-color="#7ab8ee"/>
    </linearGradient>
    <linearGradient id="skin" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="#fff3ec"/>
      <stop offset="100%" stop-color="#ffe3d6"/>
    </linearGradient>
    <linearGradient id="eye" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2f6ea8"/>
      <stop offset="55%" stop-color="#5fa8e0"/>
      <stop offset="100%" stop-color="#a8dcff"/>
    </linearGradient>
    <linearGradient id="cloth" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e8f4ff"/>
    </linearGradient>
    <linearGradient id="ribbon" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8fd3ff"/>
      <stop offset="100%" stop-color="#5aaeff"/>
    </linearGradient>
    <linearGradient id="star" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#fff3b0"/>
      <stop offset="60%" stop-color="#ffd166"/>
      <stop offset="100%" stop-color="#f7a83e"/>
    </linearGradient>
  </defs>`

const SPARKLES = `
  <g fill="#bfe0ff" opacity="0.85">
    <path d="M92 120 l7 16 16 7 -16 7 -7 16 -7 -16 -16 -7 16 -7z"/>
    <path d="M420 168 l5 12 12 5 -12 5 -5 12 -5 -12 -12 -5 12 -5z"/>
    <path d="M96 372 l5 11 11 5 -11 5 -5 11 -5 -11 -11 -5 11 -5z"/>
    <path d="M424 358 l6 13 13 6 -13 6 -6 13 -6 -13 -13 -6 13 -6z"/>
  </g>`

const TAIL = `
  <path d="M340 430 C 424 442 462 372 428 330 C 404 300 366 314 366 344 C 366 366 386 372 400 362 C 386 386 360 392 336 386 Z" fill="#ffffff" stroke="#bfe0ff" stroke-width="7" stroke-linejoin="round"/>`

const BODY = `
  <path d="M186 330 q70 -22 140 0 q26 10 26 46 l0 46 q-96 26 -192 0 l0 -46 q0 -36 26 -46z" fill="url(#cloth)" stroke="#a9d4f7" stroke-width="6"/>
  <path d="M256 330 l0 92" stroke="#cfe6fb" stroke-width="5"/>
  <path d="M214 352 l-30 46" stroke="#cfe6fb" stroke-width="5" stroke-linecap="round"/>
  <path d="M298 352 l30 46" stroke="#cfe6fb" stroke-width="5" stroke-linecap="round"/>
  <path d="M228 320 l28 26 28 -26 l-10 34 -18 16 -18 -16z" fill="url(#ribbon)" stroke="#4f9ce6" stroke-width="4" stroke-linejoin="round"/>`

const ARMS = `
  <circle cx="168" cy="386" r="26" fill="url(#skin)" stroke="#f0c9b6" stroke-width="5"/>
  <circle cx="344" cy="386" r="26" fill="url(#skin)" stroke="#f0c9b6" stroke-width="5"/>`

const HAIR = `
  <path d="M256 120 q-124 2 -134 116 q-4 34 10 62 q6 -66 26 -92 q30 22 98 22 q68 0 98 -22 q20 26 26 92 q14 -28 10 -62 q-10 -114 -134 -116z" fill="url(#hair)"/>
  <path d="M170 168 q28 -34 68 -40" stroke="#ffffff" stroke-width="11" fill="none" opacity="0.5" stroke-linecap="round"/>
  <path d="M336 150 q-16 -20 -38 -26" stroke="#ffffff" stroke-width="8" fill="none" opacity="0.4" stroke-linecap="round"/>`

const EARS = `
  <path d="M148 150 q-14 -84 26 -108 q22 34 30 62 q-40 12 -56 46z" fill="#ffffff" stroke="#bfe0ff" stroke-width="6" stroke-linejoin="round"/>
  <path d="M168 140 q-6 -50 18 -66 q12 22 16 42 q-24 8 -34 24z" fill="#ffc9de"/>
  <path d="M364 150 q14 -84 -26 -108 q-22 34 -30 62 q40 12 56 46z" fill="#ffffff" stroke="#bfe0ff" stroke-width="6" stroke-linejoin="round"/>
  <path d="M344 140 q6 -50 -18 -66 q-12 22 -16 42 q24 8 34 24z" fill="#ffc9de"/>`

const HEAD = `
  <path d="M162 214 q-10 -92 34 -150 q34 34 52 62 q-44 18 -50 92z" fill="url(#hairBack)"/>
  <path d="M350 214 q10 -92 -34 -150 q-34 34 -52 62 q44 18 50 92z" fill="url(#hairBack)"/>
  <ellipse cx="256" cy="252" rx="136" ry="130" fill="url(#skin)" stroke="#f2cdbb" stroke-width="5"/>`

const EYES_OPEN = `
  <ellipse cx="198" cy="266" rx="30" ry="38" fill="url(#eye)"/>
  <ellipse cx="314" cy="266" rx="30" ry="38" fill="url(#eye)"/>
  <ellipse cx="198" cy="258" rx="17" ry="22" fill="#0f2f52"/>
  <ellipse cx="314" cy="258" rx="17" ry="22" fill="#0f2f52"/>
  <ellipse cx="198" cy="270" rx="11" ry="14" fill="#48a0e0" opacity="0.7"/>
  <ellipse cx="314" cy="270" rx="11" ry="14" fill="#48a0e0" opacity="0.7"/>
  <circle cx="208" cy="244" r="11" fill="#ffffff"/>
  <circle cx="324" cy="244" r="11" fill="#ffffff"/>
  <circle cx="190" cy="276" r="5" fill="#ffffff" opacity="0.9"/>
  <circle cx="306" cy="276" r="5" fill="#ffffff" opacity="0.9"/>`

const EYES_HAPPY = `
  <path d="M172 270 q26 -34 52 0" fill="none" stroke="#2f6ea8" stroke-width="9" stroke-linecap="round"/>
  <path d="M288 270 q26 -34 52 0" fill="none" stroke="#2f6ea8" stroke-width="9" stroke-linecap="round"/>`

const EYES_SLEEP = `
  <path d="M170 268 q28 22 56 0" fill="none" stroke="#3f7ab0" stroke-width="8" stroke-linecap="round"/>
  <path d="M286 268 q28 22 56 0" fill="none" stroke="#3f7ab0" stroke-width="8" stroke-linecap="round"/>
  <g fill="#9fd0f5" font-family="Segoe UI, sans-serif" font-weight="700">
    <text x="368" y="176" font-size="46">z</text>
    <text x="404" y="134" font-size="60">Z</text>
  </g>`

const EYES_STAR = `
  <path d="M198 232 l10 22 24 4 -17 17 4 24 -21 -11 -21 11 4 -24 -17 -17 24 -4z" fill="url(#star)" stroke="#e9a63a" stroke-width="4" stroke-linejoin="round" transform="translate(-12,6) scale(0.92)"/>
  <path d="M198 232 l10 22 24 4 -17 17 4 24 -21 -11 -21 11 4 -24 -17 -17 24 -4z" fill="url(#star)" stroke="#e9a63a" stroke-width="4" stroke-linejoin="round" transform="translate(104,6) scale(0.92)"/>`

const BLUSH = `
  <ellipse cx="164" cy="308" rx="22" ry="12" fill="#ffc9d8" opacity="0.85"/>
  <ellipse cx="348" cy="308" rx="22" ry="12" fill="#ffc9d8" opacity="0.85"/>`

const MOUTH_SMILE = `<path d="M244 306 q6 8 12 0 q6 8 12 0" fill="none" stroke="#e0819f" stroke-width="5" stroke-linecap="round"/>`
const MOUTH_SLEEP = `<ellipse cx="256" cy="310" rx="9" ry="12" fill="#e0819f" opacity="0.85"/>`
const MOUTH_OPEN = `
  <path d="M238 302 q18 30 36 0 q-18 10 -36 0z" fill="#e0819f" opacity="0.9"/>
  <path d="M248 312 q8 10 16 0" fill="#ff9fb6"/>`

const STAR_PROP = `
  <g transform="translate(150,318) rotate(-12)">
    <path d="M0 -34 l11 24 26 4 -19 19 5 26 -23 -13 -23 13 5 -26 -19 -19 26 -4z" fill="url(#star)" stroke="#e9a63a" stroke-width="4" stroke-linejoin="round"/>
  </g>`

const QUESTION_PROP = `
  <g transform="translate(372,268)">
    <circle r="34" fill="#ffffff" stroke="#a9d4f7" stroke-width="5"/>
    <text x="0" y="14" font-family="Segoe UI, sans-serif" font-size="46" font-weight="700" fill="#5aaeff" text-anchor="middle">?</text>
  </g>`

const HEART_PROP = `
  <g transform="translate(376,300) rotate(10)">
    <path d="M0 26 C -30 4 -30 -22 -12 -22 C -3 -22 0 -14 0 -10 C 0 -14 3 -22 12 -22 C 30 -22 30 4 0 26 Z" fill="#ffb3cd" stroke="#f58fb2" stroke-width="5" stroke-linejoin="round"/>
  </g>`

function mascot(parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
${DEFS}
  <circle cx="256" cy="256" r="238" fill="url(#bg)"/>
${SPARKLES}
${parts.tail ? TAIL : ''}
${BODY}
${ARMS}
${HEAD}
${EARS}
${HAIR}
${parts.eyes}
${BLUSH}
${parts.mouth}
${parts.props ?? ''}
</svg>
`
}

const files = {
  'mascot-hi.svg': mascot({ tail: true, eyes: EYES_OPEN, mouth: MOUTH_SMILE }),
  'mascot-happy.svg': mascot({ tail: true, eyes: EYES_HAPPY, mouth: MOUTH_OPEN }),
  'mascot-sleep.svg': mascot({ tail: true, eyes: EYES_SLEEP, mouth: MOUTH_SLEEP }),
  'mascot-love.svg': mascot({ tail: true, eyes: EYES_STAR, mouth: MOUTH_SMILE, props: HEART_PROP }),
  'mascot-star.svg': mascot({ tail: false, eyes: EYES_HAPPY, mouth: MOUTH_SMILE, props: STAR_PROP }),
  'mascot-think.svg': mascot({ tail: false, eyes: EYES_OPEN, mouth: MOUTH_SMILE, props: QUESTION_PROP })
}

for (const [name, svg] of Object.entries(files)) {
  writeFileSync(join(outDir, name), svg, 'utf-8')
}

// 侧栏小图标：简化的猫头
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#9bd7ff"/>
      <stop offset="100%" stop-color="#5aaeff"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="34" fill="url(#lg)"/>
  <path d="M30 46 q-6 -24 6 -30 q10 8 14 18 q-14 4 -20 12z" fill="#ffffff"/>
  <path d="M98 46 q6 -24 -6 -30 q-10 8 -14 18 q14 4 20 12z" fill="#ffffff"/>
  <circle cx="64" cy="72" r="34" fill="#ffffff"/>
  <ellipse cx="52" cy="72" rx="6" ry="8" fill="#2f6ea8"/>
  <ellipse cx="76" cy="72" rx="6" ry="8" fill="#2f6ea8"/>
  <circle cx="54" cy="69" r="2.4" fill="#ffffff"/>
  <circle cx="78" cy="69" r="2.4" fill="#ffffff"/>
  <path d="M60 84 q4 5 8 0" fill="none" stroke="#e0819f" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="42" cy="82" rx="7" ry="4" fill="#ffc9d8" opacity="0.9"/>
  <ellipse cx="86" cy="82" rx="7" ry="4" fill="#ffc9d8" opacity="0.9"/>
</svg>
`
writeFileSync(join(outDir, 'logo.svg'), logo, 'utf-8')

console.log(`已生成 ${Object.keys(files).length + 1} 个贴图到 ${outDir}`)

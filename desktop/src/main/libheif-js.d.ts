/**
 * libheif-js 的包里只给了 `libheif/libheif.d.ts`，没有给 `wasm-bundle` 这个子路径配类型，
 * 所以这里手写一份**我们真正用到的最小接口**（不想为了类型再引一个 @types 包）。
 *
 * 用的是 `wasm-bundle` 而不是 `libheif-js`：前者把 WASM 内联进 JS（2MB 单文件），
 * 打包/asar 里不用额外带 .wasm 文件，最省事。
 *
 * ⚠️ 模块名带 `.js`：产物是 ESM，而 libheif-js 没有 "exports" 字段，
 *    Node 的 ESM 子路径解析不接受省略扩展名（CJS 才允许省略）。
 */
declare module 'libheif-js/wasm-bundle.js' {
  export interface HeifDisplayTarget {
    data: Uint8ClampedArray
    width: number
    height: number
  }

  export interface HeifImage {
    /** ⚠️ 返回的是**应用过 irot/imir 变换之后**的显示尺寸（和 Chromium 报的一致） */
    get_width(): number
    get_height(): number
    /** 把像素写进 target.data（RGBA）；失败时回调收到 null */
    display(target: HeifDisplayTarget, callback: (result: HeifDisplayTarget | null) => void): void
  }

  export class HeifDecoder {
    decode(data: Uint8Array): HeifImage[]
  }

  const libheif: { HeifDecoder: typeof HeifDecoder }
  export default libheif
}

# 素材与第三方内容声明

本仓库中的**代码**适用根目录 [`LICENSE`](LICENSE) 里的
**PolyForm Noncommercial License 1.0.0**（禁止商业用途，允许任意修改与再分发）。

但下面这些**图片素材不适用**上述代码许可证，特此单独声明。

---

## 1. 角色贴图与背景图

以下目录/文件是对第三方角色的**二次创作（同人）素材**，其原始角色与美术的著作权
归原作者及相应权利人所有，本项目作者不主张任何权利：

| 路径 | 内容 |
|---|---|
| `GalleryMirrorData/nekoha-originals/` | 原始立绘（4 张 PNG），是 `desktop/scripts/prepare-stickers.mjs` 的输入源 |
| `GalleryMirrorData/stickers/` | 由上述源图处理而来的贴图（11 个 WebP），界面侧栏与空状态页使用 |
| `GalleryMirrorData/background-*.webp` | 由上述源图处理而来的空状态背景图（4 张） |
| `android/app/src/main/res/drawable-nodpi/mascot_*.png` | 安卓端内置吉祥物 |

这些素材**随源码一起分发，仅供个人学习、研究与交流使用，不得用于任何商业用途**。

若你是上述素材的权利人，认为本仓库的分发侵犯了你的权益，请通过 Issue 联系，
**我们会立即移除相关文件**。

## 2. 应用图标

`desktop/build/icon.ico`、`desktop/build/icon.png` 以及 `android/app/src/main/res/mipmap-*/` 下的
启动图标，均由 `desktop/src/renderer/src/assets/stickers/logo.png` 通过
`desktop/scripts/make-icon.mjs` 生成，属于第 1 条所述素材的派生物，适用同样的限制。

## 3. 测试样本

`desktop/scripts/fixtures/example.heic` 取自 **libheif 官方仓库的公开示例文件**
（<https://github.com/strukturag/libheif>），用于 HEIC 兜底解码的回归测试，
**不是任何人的私人照片**。其许可随 libheif 项目（LGPL-3.0）。

## 4. 依赖

`package.json` 中声明的第三方依赖（Electron、React、sharp、libheif-js 等）
各自适用其自身许可证，与本仓库许可证无关。详见 `node_modules/<包名>/LICENSE`。

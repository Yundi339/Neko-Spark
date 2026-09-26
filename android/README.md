# Neko_Spark · 安卓端（android）

把手机相册（图片 / 视频）备份到电脑，也能把电脑上的备份恢复回手机相册。

本目录是**安卓端**：一个 Kotlin App，扫描系统相册、算指纹、分块上传、后台传输；
它**不自己存储任何东西**，所有照片都交给电脑端保管。

---

# 📍 另一半在这里：[`../desktop/`](../desktop/)

> ## ⚠️ 这是**必要的一部分**，不是可选项
>
> Neko_Spark 由**两个必须配合使用的程序**组成，**本目录只是其中一半**。
> 另一半（电脑上的程序）在 **[`../desktop/`](../desktop/)**。

| | 位置 | 作用 |
|---|---|---|
| **安卓端** ← 你在这里 | [`android/`](.) | 手机上的 App：扫描相册、备份上传、从电脑恢复回相册 |
| **电脑端** | [**`../desktop/`**](../desktop/) | 电脑上的程序：仓库、浏览界面、导出、**本地服务 Hub** |

**为什么两边都必要：**

- **只有安卓端** → 这个 App 连不上任何电脑，扫描出来也传不出去，**什么都做不了**
- **只有电脑端** → 手机相册没法自动传进来（只能用「设备 → 导入文件夹」手动导入）

> 🔑 **电脑端是 Hub**：手机要连的是电脑端起的本地服务（HTTP `8787`），
> 所以**必须先把电脑端跑起来**，再在手机 App 里填电脑的局域网地址。

两端的接口契约（改协议时两边都要动）：[`../docs/protocol-v1.md`](../docs/protocol-v1.md)
两边共用的角色素材：[`../GalleryMirrorData/`](../GalleryMirrorData/)

---

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Android | `Neko_Spark-x.y.z.apk` | **手机版** ← 本目录对应的程序 |
| Windows | `Neko_Spark-x.y.z-win-setup-x64.exe` | **电脑版** —— 另一半，必须先装它手机才有东西可连 |
| Windows | `Neko_Spark-x.y.z-win-portable-x64.exe` | **电脑便携版** —— 免安装单文件 |

全部在 **[Releases](https://github.com/jiuerya/Neko-Spark/releases)** 页。

> 📄 **电脑软件不在这里** —— 它来自另一个目录 `desktop/`，
> 详见 [`电脑软件来自另一个仓库.md`](电脑软件来自另一个仓库.md)。

---

## 快速开始

**环境**：JDK 17 + Gradle 8.9 + Android SDK（`platforms;android-34` / `build-tools;34.0.0`）。
不需要 Node.js。

先在 `local.properties` 里写好 SDK 路径（该文件不进版本库）：

```properties
sdk.dir=D\:\\Android\\Sdk
```

```bash
cd android
gradle assembleDebug --offline --console=plain --no-daemon
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

仓库里的辅助脚本：

```powershell
powershell -ExecutionPolicy Bypass -File android\scripts\android-test.ps1          # 构建 + 安装 + 自动备份一次
powershell -ExecutionPolicy Bypass -File android\scripts\android-test.ps1 -NoRun   # 只构建安装
powershell -ExecutionPolicy Bypass -File android\scripts\android-emulator.ps1      # 起模拟器
```

> ⚠️ 外网受限的环境必须加 `--offline`，否则 Gradle 会卡死在配置阶段（详见 `ARCHITECTURE.md` §8）。

## 架构

备份 / 恢复流程、协议 v1 客户端、后台传输（前台服务 + 静默通知）、
权限清单、以及**贴图是怎么打进 APK 的**，都在 **[`ARCHITECTURE.md`](ARCHITECTURE.md)**。

## 目录

```
android/
├─ ARCHITECTURE.md     架构说明
├─ README.md           本文件
├─ app/
│  ├─ build.gradle.kts 构建配置（含把贴图同步进 APK 的 Sync 任务）
│  └─ src/main/
│     ├─ AndroidManifest.xml
│     ├─ java/com/gallerymirror/app/   全部 Kotlin 源码
│     └─ res/                          图标、吉祥物、颜色、主题
└─ scripts/            构建 / 安装 / 模拟器 / SDK 下载
```

参与开发请看根目录的 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。

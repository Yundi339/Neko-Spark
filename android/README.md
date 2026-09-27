# Neko_Spark · 安卓端（android）

把手机相册（图片 / 视频）备份到电脑，也能把电脑上的备份恢复回手机相册。

本目录是**安卓端**：一个 Kotlin App，扫描系统相册、算指纹、分块上传、后台传输；
它**不自己存储任何东西**，所有照片都交给电脑端保管。

> 💻 **电脑端不在这个目录** —— Windows 程序在 [`../desktop/`](../desktop/)，
> 它同时是本地服务 Hub（HTTPS `8787`），手机连的就是它，所以**得先把它跑起来**。
> 两端接口契约：[`../docs/protocol-v1.md`](../docs/protocol-v1.md)　共用素材：[`../GalleryMirrorData/`](../GalleryMirrorData/)

---

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Android | `Neko_Spark-x.y.z.apk` | **手机版** ← 本目录对应的程序 |
| Windows | `Neko_Spark-x.y.z-win-setup-x64.exe` | **电脑版** —— 另一半，必须先装它手机才有东西可连 |
| Windows | `Neko_Spark-x.y.z-win-portable-x64.exe` | **电脑便携版** —— 免安装单文件 |

全部在 **[Releases](https://github.com/Yundi339/Neko-Spark/releases)** 页（源码也分两份放在那里）。

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

首次连接时，把电脑端设置页的 HTTPS 证书 SHA-256 指纹填入手机输入框；WiFi/模拟器还要填写「局域网访问密钥」，USB 回环转发可留空密钥。

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

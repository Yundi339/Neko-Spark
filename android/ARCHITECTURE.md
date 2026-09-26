# 安卓端架构说明

安卓端是一个 Kotlin 应用，负责把手机相册**备份到电脑**，以及把电脑上的备份**恢复回手机**。
它与电脑端之间只通过 **HTTP 协议 v1** 通信（不共享代码、不共享构建系统）。

> ⚠️ **这是两个必须配合使用的程序中的一个，另一半在 [`../desktop/`](../desktop/)。**
> 只有安卓端，App 连不上任何电脑、什么都做不了；只有电脑端，手机照片无法自动传进来。
> **电脑端才是 Hub**，手机要连的是它起的本地服务，所以必须先跑起电脑端。
>
> 协议定义见 [`../docs/protocol-v1.md`](../docs/protocol-v1.md)；
> 电脑端的架构说明见 [`../desktop/ARCHITECTURE.md`](../desktop/ARCHITECTURE.md)；
> 安卓端的构建与运行见 [`README.md`](README.md)。

---

## 1. 目录结构

```
android/
├─ app/
│  ├─ build.gradle.kts          构建配置（含贴图同步任务，见 §7）
│  └─ src/main/
│     ├─ AndroidManifest.xml
│     ├─ java/com/gallerymirror/app/
│     │  ├─ MainActivity.kt     界面（程序化构建，蓝白风格）+ 全部交互/弹窗/权限
│     │  ├─ MediaScanner.kt     MediaStore 扫描（图片 + 视频）
│     │  ├─ HubClient.kt        协议 v1 客户端（health/manifest/upload/commit/devices/media/download）
│     │  ├─ BackupRunner.kt     备份流程编排（SHA-256 本地缓存）
│     │  ├─ RestoreRunner.kt    恢复流程（合并 / 新建文件夹两种模式）
│     │  ├─ SyncService.kt      前台服务：后台传输 + 静默进度通知
│     │  ├─ Retry.kt            断线自动重连（指数退避）
│     │  ├─ HubDiscovery.kt     UDP 局域网搜索电脑
│     │  └─ Stickers.kt         读取打包进 APK 的贴图
│     └─ res/                   图标、吉祥物、颜色、主题
├─ scripts/                     构建 / 安装 / 模拟器辅助脚本
├─ build.gradle.kts             插件版本
├─ settings.gradle.kts
└─ gradle.properties
```

## 2. 备份流程（手机 → 电脑）

```
MediaStore 扫描
  → SHA-256 指纹（带本地缓存，重复备份不重算）
  → POST /manifest 提交清单
  → 服务端比对后回「需要哪些」
  → 逐个文件 POST /blob（8MB 分块，Content-Range，支持断点续传）
  → POST /commit 收尾
```

服务端在 `PUT /blob` 落盘的那一刻就建记录并推送变更，所以**照片是边传边出现在电脑界面上的**，
中途断开也不会白传。已传完的靠清单比对跳过，传一半的靠服务端 `.part` + `Content-Range` 续传。

**断线自动重连**：`Retry.kt` 的 `withRetry`（2→4→8→16→30 秒退避，最多 60 次）包住了健康检查 /
清单 / 上传 / 入库，**一断就整轮作废**改成"等它接回来继续传"。4xx 是数据问题，不重试。

## 3. 恢复流程（电脑 → 手机）

两种模式：

- **合并同名文件夹** —— 按原 `relativePath` 写回
- **新建文件夹** —— 可自定义名字，默认 = 选中设备名，落在 `DCIM/<名字>/`

去重规则：同名同大小自动跳过；同名不同大小加 ` (1)` 序号，**不覆盖**；字节级一致（SHA-256 相同）。

写回相册的 API 分界：

| Android 版本 | 做法 |
|---|---|
| 10+（API 29+） | 走 `MediaStore` + `IS_PENDING` |
| 9 及以下 | 直接写文件 + `MediaScannerConnection.scanFile` |

非标准顶层目录会自动放进 `Pictures/`（视频放 `Movies/`），避免 `MediaStore` 拒绝。

## 4. 后台传输（SyncService）

传输任务由**前台服务**执行，Activity 只负责显示：

- **保后台**：前台服务 + `PARTIAL_WAKE_LOCK`（**缺一不可** —— 只有前台服务的话，
  息屏后 CPU 仍会被挂起，传输卡在半路）
- **进度通知**：全程静默 —— 渠道 `gm_sync` 为 `IMPORTANCE_LOW` 且
  `setSound(null)` / `enableVibration(false)` / `enableLights(false)`，通知再叠
  `setSilent(true)` + `setOnlyAlertOnce(true)`。刷新按「百分比变化立即刷，否则最多 1.2 秒一次」节流。
- **界面只订阅状态**：`SyncService.state`（`StateFlow`），Activity 重建后仍能接着显示进度。
  `BackupRunner` / `RestoreRunner` 逻辑与执行者解耦。
- **崩溃安全**：通知权限被拒绝**不影响传输**（只影响能不能看见通知）；前台服务用
  `START_NOT_STICKY`，被杀后不会静默重跑。

## 5. 局域网发现

`HubDiscovery.kt` 用 UDP 广播（端口 8788）搜索局域网内所有 Hub，弹窗选择。
模拟器会自动补 `10.0.2.2`（宿主机的别名）。

## 6. 权限

```
READ_MEDIA_IMAGES / READ_MEDIA_VIDEO      （Android 13+）
READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE  （旧版）
FOREGROUND_SERVICE
FOREGROUND_SERVICE_DATA_SYNC
POST_NOTIFICATIONS                         （运行时；拒绝了也能传，只是看不见通知）
WAKE_LOCK
```

## 7. 贴图是怎么进 APK 的

`app/build.gradle.kts` 里有一个 `Sync` 任务（挂在 `preBuild` 上），构建时把
`<仓库根>/GalleryMirrorData/stickers/` 里的图片拷进 `assets/stickers/`，随 APK 一起安装。
可用环境变量 `GM_STICKERS_DIR` 覆盖源目录。

> ⚠️ 该任务有 `if (source.exists())` 守卫 —— **源目录不存在时不会报错，只是贴图静默为空**，
> APK 里就没有 `assets/stickers/`，界面回退到内置吉祥物。
> 所以「贴图没打进 APK」这类问题的第一嫌疑就是源目录路径。

运行时读取顺序：`assets/stickers/` 里字典序第一张 → 内置 `R.drawable.mascot_hi` →
联网时也可从 Hub 拉取（`MainActivity.loadMascotFromHub`）。

## 8. 构建与运行

```powershell
# 启动模拟器（需先配好 AVD）
powershell -ExecutionPolicy Bypass -File scripts\android-emulator.ps1

# 构建 + 安装 + 自动跑一次备份
powershell -ExecutionPolicy Bypass -File scripts\android-test.ps1

# 只构建安装
powershell -ExecutionPolicy Bypass -File scripts\android-test.ps1 -NoRun

# 指定电脑端地址（模拟器用 10.0.2.2；真机用局域网 IP；USB 用 127.0.0.1 + adb reverse）
powershell -ExecutionPolicy Bypass -File scripts\android-test.ps1 -Hub http://192.168.1.5:8787
```

直接调 Gradle：

```bash
gradle -p android assembleDebug --offline --console=plain --no-daemon
```

> ⚠️ **外网受限的环境必须加 `--offline`**：Gradle/JVM 不走系统代理，不加会卡死在配置阶段
> （守护进程日志停在 "The daemon has started executing the build"，CPU 完全不动）。
> 依赖都在本地缓存里，加了很快就能编完。
>
> ⚠️ 构建被中断会留下 "busy Daemon" 占锁，之后每次启动都卡在
> `Starting a Gradle Daemon, 1 busy Daemon could not be reused` —— 清掉即可（结束 java 进程）。
>
> ⚠️ 别用管道接 Gradle 输出（会缓冲，构建中什么都看不到），重定向到文件再读。

**依赖最小化**：只用 OkHttp + 协程，其余走 Android 平台自带能力。

## 9. 环境要求

| 组件 | 说明 |
|---|---|
| JDK | 17 |
| Gradle | 8.9 |
| Android SDK | `platform-tools` / `platforms;android-34` / `build-tools;34.0.0` |
| 编译 SDK | 34 |

SDK 路径写在 `local.properties`（`sdk.dir=...`），该文件**不进版本库**，需要各自本地生成。

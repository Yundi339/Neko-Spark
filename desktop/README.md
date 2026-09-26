# Neko_Spark · 电脑端（desktop）

把安卓手机相册备份到电脑，并以"手机相册一样的方式"浏览；之后可原样导出 / 迁移回手机。

本目录是**电脑端**：Electron 应用，同时充当整个系统的**本地服务 Hub**
（HTTP `8787` + UDP 发现 `8788`）——手机端要连的就是它。

---

# 📍 另一半在这里：[`../android/`](../android/)

> ## ⚠️ 这是**必要的一部分**，不是可选项
>
> Neko_Spark 由**两个必须配合使用的程序**组成，**本目录只是其中一半**。
> 另一半（手机上的 App）在 **[`../android/`](../android/)**。

| | 位置 | 作用 |
|---|---|---|
| **电脑端** ← 你在这里 | [`desktop/`](.) | 仓库、浏览界面、导出、本地 Hub |
| **安卓端** | [**`../android/`**](../android/) | 手机上的 App：扫描相册、备份上传、从电脑恢复回相册 |

**为什么两边都必要：**

- **只有电脑端** → 手机相册没法自动传进来（只能用「设备 → 导入文件夹」手动导入）
- **只有安卓端** → App 连不上任何电脑，扫描出来也传不出去，什么都做不了

两端的接口契约（改协议时两边都要动）：[`../docs/protocol-v1.md`](../docs/protocol-v1.md)
两边共用的角色素材：[`../GalleryMirrorData/`](../GalleryMirrorData/)

---

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `Neko_Spark-x.y.z-win-setup-x64.exe` | **电脑版** ← 本目录对应的程序 |
| Windows | `Neko_Spark-x.y.z-win-portable-x64.exe` | **电脑便携版** —— 免安装单文件 |
| **Android** | `Neko_Spark-x.y.z.apk` | **手机版** —— 另一半，见下方提示 |

全部在 **[Releases](https://github.com/jiuerya/Neko-Spark/releases)** 页。

> 📄 **手机软件不在这里** —— 它来自另一个目录 `android/`，
> 详见 [`手机软件来自另一个仓库.md`](手机软件来自另一个仓库.md)。

---

## 快速开始

**环境**：Node.js >= 22。不需要 Android SDK。

```bash
cd desktop
npm install            # 首次
npm run dev            # 开发模式（热更新）
npm test               # 类型检查 + 构建 + 167 项端到端测试（会短暂弹出应用窗口）
npm run dist:nsis      # 打包 Windows 安装版到 desktop/release/
```

Windows PowerShell 默认禁止运行 `npm.ps1`，请统一使用 `npm.cmd`。

**接手机备份**：启动后，同一 WiFi 下手机访问界面显示的局域网地址；
USB 用 `adb forward tcp:8787 tcp:8787`。

## 架构

进程结构、关键设计（内容寻址、可逆设备合并、两种"已删除"语义、缩略图与性能）
与数据库表都在 **[`ARCHITECTURE.md`](ARCHITECTURE.md)**。

## 目录

```
desktop/
├─ ARCHITECTURE.md     架构说明
├─ README.md           本文件
├─ src/
│  ├─ main/            主进程（窗口、IPC、Hub）
│  ├─ preload/         安全桥
│  ├─ renderer/        React 界面
│  └─ shared/          前后端共享类型
├─ build/              安装器脚本 + 图标
├─ tools/mock-phone/   模拟安卓端（测试协议用）
├─ scripts/            测试 / 探针 / 素材工具
└─ package.json  electron-builder.yml  tsconfig*.json
```

参与开发请看根目录的 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。

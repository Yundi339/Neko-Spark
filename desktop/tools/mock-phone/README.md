# mock-phone（模拟手机客户端）

M2 阶段实现：用 Node.js 模拟安卓端行为，把本地一个文件夹当成"手机相册"，按 `docs/protocol-v1.md` 的协议上传到电脑端 Hub。

用途：在安卓 App 还没开发完成前，先把 PC 端的完整管线跑通、压测、回归。

计划能力：

1. 扫描指定文件夹（含子目录），生成与 MediaStore 对齐的清单。
2. 计算 SHA-256，调用 `POST /api/v1/manifest` 获取需要上传的列表。
3. 分块上传（`PUT /api/v1/blob/{sha256}`），支持中断重试。
4. 调用 `POST /api/v1/commit` 完成入库。
5. 输出校验报告：数量、总大小、失败项。

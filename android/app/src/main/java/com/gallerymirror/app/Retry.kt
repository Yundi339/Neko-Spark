package com.gallerymirror.app

import kotlinx.coroutines.delay

/**
 * 断线自动重连：网络抖动、电脑端重启、App 被系统掐一下，都不该让整轮传输作废。
 *
 * 之所以叫"接上去继续传"而不是"重来一遍"：
 *  - **备份方向**：已传完的文件在下一轮清单比对时会被跳过（服务端已有该 blob）；
 *    传了一半的文件，服务端存着 `tmp/uploads/<sha>.part`，续传接口会告诉我们
 *    已收到多少，`HubClient.upload` 从最后一个完整分块接着传。
 *  - **恢复方向**：已写回手机的文件在重跑时会被"同名同大小自动跳过"。
 *
 * 重试节奏 2→4→8→16→30 秒封顶，最多 60 次（约 25 分钟）。这段时间足够
 * 把 WiFi 切回来、或者把电脑端重新打开，期间界面和通知栏会显示"X 秒后重连"。
 */
suspend fun <T> withRetry(
    onLog: (String) -> Unit,
    what: String,
    block: suspend () -> T
): T {
    var attempt = 0
    while (true) {
        try {
            return block()
        } catch (e: Exception) {
            // 4xx 是数据问题（比如哈希对不上），重试多少次结果都一样，别白等
            if (e.message?.contains("HTTP 4") == true) {
                onLog("$what 失败（非网络问题，不重试）：${e.message}")
                throw e
            }
            attempt += 1
            if (attempt > 60) {
                onLog("$what 连续失败 $attempt 次，放弃")
                throw e
            }
            val waitSec = minOf(30L, 2L shl minOf(attempt - 1, 4))
            onLog("$what 断开，${waitSec} 秒后重连（第 $attempt 次）")
            delay(waitSec * 1000L)
        }
    }
}

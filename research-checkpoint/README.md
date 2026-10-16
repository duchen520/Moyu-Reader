# 接续研究检查点

继承原有研究，不是重建项目。保留了源码、此前 v0.2 / v0.3 压缩包、接口研究项目、探测脚本和官方公共页面下载。

本包保存脱敏的请求摘要、待完成接口的 Rust 探测程序、官方公共文件校验清单及 INTEGRATION-NOTES.md 接入记录。原始评论正文、用户头像、公开 JS 全量文件、研究仓库和依赖目录未纳入源码包。

## 已确认，继续复用

- 官方搜索：H5 search/v1，分页 offset / has_more。
- 作品 / 有声目录：官网 reader/directory/detail，原小说样例 351 章，关联有声版样例 896 集。
- 书评列表：H5 comments/all/info/v1，分页 page_number / page_count。
- 官网公开详情：get_book_comment；父评论 64 位 ID 有数值舍入现象，限定在单个精确请求内兼容。
- 官方 audio/toneinfo：分别识别电脑朗读之外的官方 TTS 音色和 recorded 有声版；实际录音只有取得正常音频并播放后才可验收。

## 本轮仍未接通

- reader/audio/playinfo：HTTP 200 空响应；不重复试不同未确认参数，不推断一定是账号问题。
- 高级评论：此前匿名 POST 返回 110001 未知异常；尚缺独立验证的客户端协议，章评 / 段评分组和段落映射未确认。
- 官方 H5 audio_play：播放页调用手机原生 switchAudio，未找到直接媒体流。

继续验证只需运行 src-tauri/examples/probe_pending.rs。它复用既有样例 ID，只发两项读取各一次；HTTP 429 / 503 会触发统一冷却，第二次同主机调用将被拦截。不要循环运行探测脚本。

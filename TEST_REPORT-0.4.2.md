# Tomato Reader 0.4.2 验证记录

日期：2026-10-15。基于用户提供的 0.4.1 源码包修复，应用标识继续使用 dev.tomatoreader.desktop。

## 修复范围

1. 正文未加载或加载失败时不再保存占位页面位置，避免覆盖之前的阅读记录。
2. 滚动事件立即捕获带有书籍/章节归属的位置，退出或切章时提交尚未保存的快照。
3. 串行同步保留等待处理的当前章节，慢请求完成后重新读取最新状态；换书、导航或账号状态变化后忽略旧响应。
4. 作品目录和账号请求返回时核验打开批次，避免旧请求覆盖当前页面。
5. 重新播放同一集时恢复最新听书位置，而非初次加载时的旧快照。
6. 听书保存绑定实际正在播放的书籍、版本和集数，加载元数据前不保存零秒占位进度；切换版本不再写错版本/集数组合。

语音单元测试改为使用项目直接声明的 TypeScript 转译，消除对间接依赖 esbuild 的隐式引用。

收尾检查还发现开发服务器会监听 Rust 编译产物，在 Windows 下遇到已锁定的 exe 时触发 EBUSY 并退出。vite.config.ts 已排除 src-tauri 目录的监听；实际启动开发服务器后确认监听列表中没有该目录。此项只影响开发模式，不改变已安装程序的生产资源。

## 已通过

- TypeScript 检查与 Vite 生产构建。
- 5 项电脑朗读逻辑检查：scripts/test-unit.mjs。
- 2 项听书进度隔离检查：scripts/test-audio-progress.cjs。
- 20 项既有阅读/账号界面检查：scripts/test-ui.mjs。
- 11 项既有搜索、评论、音频界面检查：scripts/test-extras.mjs。
- 7 项新增故障回归检查：scripts/test-regressions.mjs，包括加载中退出、立即侧栏导航、目录/账号迟到响应、慢同步后续章排队，以及旧同步不能开启新书自动上传。
- 18 项 Rust 后端检查：cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib --locked。
- 3 项真实桌面检查：scripts/test-native.mjs，验证 0.4.2 通过真实 WebView2/Tauri 运行、TXT 导入和阅读位置恢复、无未处理页面异常。

合计 66 项脚本检查通过。界面检查中的官方服务及测试音频为模拟数据；真实桌面检查只覆盖本地阅读。桌面测试使用独立 WebView2 数据目录，没有将测试小说写入用户正常书架。

## 构建与安装

前端生产依赖版本与原 package-lock.json 中的直接依赖版本核对一致；额外保留 pnpm-lock.yaml 记录本次安装解析。后端按 Cargo.lock 使用 --locked 构建。

本机安装 Rust MSVC 编译器及微软 C++ Build Tools，后者位于 D:\TomatoReaderBuildTools。build-local.json 用于已完成前端构建的本机打包，关闭重复的 npm 构建步骤，并将工具缓存放到 target 目录以避免跨盘移动。标准开发与 CI 仍可使用原有 npm 构建入口。

安装前已将旧的 D:\Tomato Reader 程序目录备份为 Tomato-Reader-0.4.1-installed-backup.zip。升级保留应用标识和现有数据目录，不执行清空数据或退出账号。

0.4.2 安装器退出码为 0，D:\Tomato Reader\tomato-reader.exe 产品版本及文件版本均为 0.4.2。对安装后的程序再次运行 3 项真实桌面检查，全部通过。

安装文件与 release 原始可执行文件仅有 3 字节差异，对应 Tauri 安装包类型标记 __TAURI_BUNDLE_TYPE_VAR_NSS 与 __TAURI_BUNDLE_TYPE_VAR_UNK。将此预期标记统一后，完整文件逐字节相同。

## 验证边界

未用用户真实账号验证手机/电脑双向同步，未验证真实官方有声的解码和系统出声。不把模拟界面通过等同于这些功能已验收。

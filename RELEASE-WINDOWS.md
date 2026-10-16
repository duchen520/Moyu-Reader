# Windows v0.4.1 打包记录

目标Windows 10/11 x64，当前用户安装，简体中文。保留应用标识，支持覆盖已有版本；缺少WebView2时由安装器从Microsoft下载补齐，用户无需Python、Node、Rust或FFmpeg。

## 当前结果

- Windows MSVC生产主程序编译通过；启用tauri/custom-protocol，构建输出cargo:dev=false，界面内置。
- NSIS安装包3523178字节，约3.36 MiB，归档完整性检查通过。
- 解包主程序与编译程序比较，仅存在Tauri正常写入的UNK→NSS安装类型标记差异，没有其他字节差异。
- PE为x64 Windows GUI，导入库不需要额外VCRuntime、MSVCP或WebView2Loader DLL。
- 完整GPL许可、第三方署名及对应源码一同提供。当前包没有发布者代码签名。
- 18项Rust、5项朗读、20项界面和11项界面扩展检查通过；界面中的原生命令和媒体地址使用模拟数据。
- 一张匿名官方公开封面通过真实下载和JPEG解码。用户个人账号没有在开发环境使用。

## 变更与验收边界

v0.4.0用户已确认Windows能启动、登录且手动刷新能读取个人书架；本版补自动加载、官方封面、云端章节摘要和明确错误。真实手机/电脑双向进度、新包Windows安装与声音播放仍待用户验收。听书位置仍只保存在本机。

构建工具缓存被环境清理后重新准备；源码保留完整。SDK准备13分38秒，后续release编译2分04秒。Rust1.99.0、cargo-xwin0.23.1、LLVM/LLD18.1.3、NSIS3.09、Windows SDK10.0.26100、MSVC CRT14.44。

正常Windows源码构建运行BUILD-WINDOWS.ps1。本轮Linux交叉构建先运行npm run build，再运行：

```sh
cargo-xwin build --manifest-path src-tauri/Cargo.toml --release --target x86_64-pc-windows-msvc --features tauri/custom-protocol
npm run tauri bundle -- --target x86_64-pc-windows-msvc --ci
```

本地NSIS包装器仅设置工具资源目录，未修改项目安装器模板。精确哈希和检查摘要见release-checks/windows-0.4.1.json；用户反馈及封面检查见release-checks/shelf-0.4.1.json。

# 伴奏歌词 Banzou

macOS 桌面应用，给自己练歌、录歌、直播用：放伴奏、歌词跟着滚、录唱、修音、每天练声、一键开播。

> **English**: Banzou is a macOS desktop app for singers: play backing tracks with synced lyrics, record takes aligned to the original vocal, auto/manual pitch correction, daily vocal exercises, and one-click live streaming through OBS with real-time pitch correction. UI is in Chinese. Bring your own backing tracks and lyrics; none are included. Build steps are below.

## 功能

- **曲库**：选一个素材文件夹，按文件名自动配成歌（伴奏 / 引导人声 / 歌词 / 原曲视频 / 外部录音），搜索（⌘F）
- **演唱**：歌词滚动、翻看、点句跳转；引导人声；歌词偏移；A-B 循环；升降调；变速不变调；全屏大字（F）
- **歌词**：打轴编辑器、导入 LRC（自动识别 GBK / UTF-16）、智能对齐 / 自动打轴（macOS 本机语音识别，不联网）
- **录唱**：麦克风选择（不让用蓝牙麦克风）、耳机检测、延迟校准、按原唱自动对齐、补录、多遍拼接
- **修音**：音高曲线对比原唱、自动修音（跟原唱 / 跟音阶）、手动修音（拖音符块）、降噪、效果、导出 wav / m4a
- **练声**：音域测试、哼鸣、气息、长音、五度音阶、琶音、八度跳、听音模唱；今日练习一键走完，记录每天的进步
- **直播**：一键开播（自动配置 OBS，推流到 TikTok 等 RTMP 平台），观众听到的是修过音的声音，自己耳机里听原声；歌词叠加层

## 系统要求

- macOS 26 或更新版本（Apple 芯片）。智能对齐用到 macOS 26 的语音识别
- 直播需要另外装 [OBS Studio](https://obsproject.com/)（30 以上）

## 素材文件夹

第一次打开会让你选一个文件夹，应用只读它第一层的文件：

| 文件名 | 识别为 |
|---|---|
| `歌名 - 伴奏.wav`（或 mp3 / m4a / flac） | 伴奏，同一首歌有多种格式时优先 wav |
| `歌名 - 人声.wav` | 引导人声，也是修音和自动对齐的参考 |
| `歌名.lrc` | 歌词（没有的话可以在应用里打轴或导入） |
| 视频文件 | 按歌名模糊匹配为原曲参考，从「（原唱：xx）」提取原唱 |
| 其他音频 | 按歌名匹配为外部录音 |

录音、修音、导出都存在这个文件夹下的「录音/歌名/」里。设置、练声记录存在 `~/Library/Application Support/io.github.dylantlwu.banzou/`。直播推流码只存在本机设置里。

本仓库不含任何伴奏、歌词或录音。请只使用你有权使用的素材；直播平台可能会静音商业歌曲。

## 构建

需要 Xcode（含命令行工具）、[Rust](https://rustup.rs/)、Node.js 20+。

```bash
git clone https://github.com/dylantlwu/banzou.git
cd banzou
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 打包成 src-tauri/target/release/bundle/macos/伴奏歌词.app
```

`src-tauri/build.rs` 会用 `swiftc` 编译辅助程序 `banzou-helper`（语音识别、读取音频设备类型）。

## 测试

```bash
npm test               # 前端单元测试（Vitest）
npm run test:rust      # 后端测试（cargo test）
```

**浏览器测试模式**：在浏览器里跑界面，命令交给真实的 Rust 后端逻辑执行，保存只写到 `.testlib`。

```bash
npm run test:ui:setup  # 编译测试桥，生成一首示例歌曲（合成的伴奏和人声，原创歌词）
npm run test:ui        # 打开 http://localhost:1420/?test
```

- `/?test&fakemic`：假麦克风，跟着原唱人声唱（测录音、对齐、练声）
- `/?test&nolib`：模拟第一次打开
- 用自己的歌测：`node scripts/make-testlib.mjs --from ~/我的歌`
- 测直播叠加层要另外运行 `src-tauri/target/release/examples/devlive`

改完东西、打包前按 [docs/测试清单.md](docs/测试清单.md) 把应用上手用一遍。需求和设计见 [docs/PRD.md](docs/PRD.md)。

## 目录

- `src/`：React 界面。`audio/` 播放引擎，`lyrics/` 歌词与对齐，`takes/` 录音，`tune/` 修音，`practice/` 练声，`live/` 直播
- `src-tauri/src/`：Rust 后端。`library.rs` 曲库配对，`dsp/` 音高检测 / PSOLA / 降噪 / 变调，`live.rs` 叠加层服务，`obs.rs` 控制 OBS
- `src-tauri/helpers/helper.swift`：语音识别、音频设备检测
- `src-tauri/overlay/`：直播叠加层页面

## 许可证

[MIT](LICENSE)

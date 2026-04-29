# SillyTavern Preset Auto Save

> 解放双手 · 永不丢失 · 极致兼容

为 SillyTavern 添加**预设自动保存**与**历史版本管理**能力的扩展插件。

## ✨ 功能特性

- 🔄 **自动保存** - 修改预设后自动保存，无需手动点击
- 📜 **历史记录** - 每次保存都创建快照，可随时回档
- 🛡️ **切换保护** - 切换预设前自动备份当前修改
- 💪 **极致兼容** - 多层降级方案，支持各种 SillyTavern 版本
- 🎨 **现代界面** - 完美融入 SillyTavern 主题
- 📱 **移动端友好** - 手机使用同样流畅

## 📦 安装

### 通过扩展管理器安装（推荐）

1. 打开 SillyTavern
2. 进入「扩展」→「管理扩展」
3. 输入仓库地址：
   ```
   https://github.com/yourname/SillyTavern-PresetAutoSave
   ```
4. 点击安装，刷新页面即可

### 手动安装

将整个项目克隆到 `data/<your-username>/extensions/` 目录下：

```bash
cd data/default-user/extensions
git clone https://github.com/yourname/SillyTavern-PresetAutoSave
```

## 🚀 使用方法

安装后，在**预设栏最右边**会出现一个时钟图标 🕐，点击即可打开历史记录面板。

### 主要操作

- **自动保存**：修改预设的任何参数后会自动保存
- **查看历史**：点击 🕐 按钮查看所有历史记录
- **恢复版本**：在历史面板中点击 ↩ 按钮恢复
- **个性化设置**：在历史面板的「设置」标签中配置

## ⚙️ 可配置项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| 启用自动保存 | ✅ | 总开关 |
| 防抖延迟 | 800ms | 修改后多久触发保存 |
| 每预设保留条数 | 50 | 超出自动删除最旧 |
| 切换保护 | ✅ | 切换前自动备份 |
| 状态指示器 | ✅ | 显示保存状态小圆点 |
| 保存时提示 | ❌ | 每次保存显示Toast |

## 🔧 兼容性

- ✅ SillyTavern 1.10.x +
- ✅ Chat Completion (OpenAI 兼容API)
- ✅ Text Completion
- ✅ NovelAI
- ✅ KoboldAI

## 📝 开发

```bash
git clone https://github.com/yourname/SillyTavern-PresetAutoSave
cd SillyTavern-PresetAutoSave
# 直接放到 extensions/third-party/ 目录即可调试
```

## 📜 许可证

[AGPL-3.0](LICENSE)

## 🙏 鸣谢

- SillyTavern 团队提供的开放扩展API

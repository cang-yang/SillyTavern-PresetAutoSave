# 安装指南

## 方式一：通过 SillyTavern 扩展管理器（推荐）

1. 启动 SillyTavern
2. 点击右上角扩展图标（拼图）
3. 选择「管理扩展」
4. 在 "Install Extension" 输入仓库地址：
   ```
   https://github.com/SillyTavern-Extras/SillyTavern-PresetAutoSave
   ```
5. 选择「为所有用户安装」或「仅为当前用户安装」
6. 点击安装，等待完成
7. 刷新页面 ✓

## 方式二：Git 克隆

```bash
# 进入用户的扩展目录（替换 default-user 为你的用户名）
cd data/default-user/extensions/third-party

# 克隆项目
git clone https://github.com/SillyTavern-Extras/SillyTavern-PresetAutoSave

# 刷新 SillyTavern 页面
```

## 方式三：手动下载 ZIP

1. 在 GitHub 仓库点击 `Code` → `Download ZIP`
2. 解压到 `data/<your-username>/extensions/third-party/SillyTavern-PresetAutoSave/`
3. 刷新 SillyTavern 页面

---

## 验证安装

### 1. 控制台日志

打开浏览器开发者工具（F12）→ Console，应该看到：

```
[PAS] SillyTavern-PresetAutoSave v1.0.0 loading...
[PAS] Settings loaded
[PAS] UI injector ready
[PAS] Preset takeover ready
[PAS] All systems operational ✓
```

### 2. 视觉特征

加载成功后你会看到：

- **预设栏右侧** 多了一个 🕐 时钟图标（点击打开历史面板）
- **预设栏左侧** 预设名旁有一个小圆点（保存状态指示器）
- **原生预设下拉** 内容变少了 —— 同系列的多个版本被合并成一个系列名

### 3. 调试接口

控制台输入：

```js
window.__pas
```

应该看到：

```
{
  version: '1.0.0',
  ENV: { stVersion: '...', hasGetPresetManager: true, hasPopupAPI: true, ... },
  showHistoryPanel: ƒ,
  refreshTakeover: ƒ,
  logger: { ... }
}
```

---

## 故障排查

### Q1: 看不到历史按钮 🕐？

**A:** 按以下顺序排查：
1. 进入「管理扩展」确认插件已**启用**
2. 打开浏览器控制台（F12）查看是否有报错（特别是红色 `[PAS]` 开头的）
3. 尝试切换 API Type 后再切回（触发重注入）
4. 在控制台输入 `window.__pas.showHistoryPanel()` 直接打开

### Q2: 保存失败？

**A:** 控制台 `setLevel('error')` 或勾选设置→"调试日志"，看具体错误：
- `quota exceeded` → 浏览器存储空间满了，进入「设置」→ 清空所有历史
- `presetManager unavailable` → SillyTavern 版本过旧，请升级
- `permission denied` → 浏览器禁用了 IndexedDB，请检查隐私设置

### Q3: 接管后预设下拉变奇怪了？

**A:** 历史面板 → 设置 → 预设接管 → **关闭"接管原生预设下拉"**。
下拉立即恢复原状。如果想保留接管但调整某个系列的归属，使用「管理分组」功能。

### Q4: 历史面板打不开 / 显示空白？

**A:**
1. 控制台执行：
   ```js
   window.__pas.logger.exportText()
   ```
   会下载日志文件，请把它发到 Issue
2. 临时关闭其它扩展排除冲突
3. 删除浏览器对该域名的全部存储（IndexedDB / localStorage），重新加载

### Q5: 升级到新版本后丢失数据？

**A:** 升级前请先**导出全部**：
- 打开历史面板 → 设置 Tab → 点击「导出全部」
- 升级完成后 → 设置 → 「导入」（合并模式）

---

## 卸载

### 临时禁用
在「管理扩展」中找到本插件 → 取消勾选「启用」。
此时所有 DOM 改动立即还原（包括接管的下拉），但你的历史快照会保留。

### 完全卸载
1. 先在历史面板「设置」→ 点「清空所有历史」（如果想清理数据）
2. 在「管理扩展」中点删除
3. 删除目录：`data/<username>/extensions/third-party/SillyTavern-PresetAutoSave/`

---

## 兼容性矩阵

| SillyTavern | Chrome / Edge | Firefox | Safari | 移动端 |
|-------------|---------------|---------|--------|--------|
| 1.10.x      | ✅            | ✅      | ✅     | ✅     |
| 1.11.x      | ✅            | ✅      | ✅     | ✅     |
| 1.12.x      | ✅            | ✅      | ✅     | ✅     |
| 1.13.x（实验） | ✅          | ✅      | ✅     | ✅     |

**最低浏览器版本：**
- Chrome / Edge ≥ 90
- Firefox ≥ 88
- Safari ≥ 14
- 移动端 iOS Safari ≥ 14、Android Chrome ≥ 90

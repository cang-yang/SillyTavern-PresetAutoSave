# 安装说明

## 要求

- SillyTavern 1.10 或更高版本
- 现代浏览器（Chrome/Edge ≥90、Firefox ≥88、Safari ≥14），移动端也行

## 怎么装

### 方法一：扩展管理器（最简单）

1. 打开 SillyTavern
2. 右上角拼图图标 🧩 →「管理扩展」
3. 填入地址：
   ```
   https://github.com/SillyTavern-Extras/SillyTavern-PresetAutoSave
   ```
4. 点安装 → 刷新页面 → 完事

### 方法二：Git 克隆

```bash
cd data/<你的用户名>/extensions/third-party
git clone https://github.com/SillyTavern-Extras/SillyTavern-PresetAutoSave
```

刷新页面就好。

### 方法三：手动下载

1. GitHub 仓库 → `Code` → `Download ZIP`
2. 解压到 `data/<你的用户名>/extensions/third-party/SillyTavern-PresetAutoSave/`
3. 刷新页面

> 手动下载的话后续不会自动更新，得自己重新下。

---

## 装好了吗？看这几个地方

装好之后刷新页面，你应该能看到：

- 预设栏右边多了个 🕐 图标
- 预设名旁边多了个小圆点
- 预设下拉列表里同系列的版本合并了

如果不确定，按 F12 打开控制台，应该能看到 `[PAS]` 开头的日志，说明插件在正常运行。

---

## 更新

**扩展管理器装的：** 默认会自动更新。也可以手动去「管理扩展」→「检查更新」。

**Git 装的：**

```bash
cd data/<你的用户名>/extensions/third-party/SillyTavern-PresetAutoSave
git pull
```

> 更新前建议先在历史面板 → 设置 →「导出全部」备份一下快照数据，以防万一。

---

## 卸载

**想暂时关掉：**「管理扩展」里取消勾选就行，数据不会丢。

**想彻底删掉：**

1. （建议）先到历史面板 → 设置 →「导出全部」备份数据
2. 在「管理扩展」里删除，或者直接删掉插件文件夹

放心，卸载不会影响你的原始预设文件，插件从来没碰过它们。

---

## 遇到问题？

**看不到 🕐 按钮：**
- 确认插件已启用
- F12 控制台看有没有 `[PAS]` 开头的报错
- 试试控制台输入 `window.__pas.showHistoryPanel()`

**保存失败：**
- 控制台看报错信息
- `quota exceeded` → 存储满了，去设置里清理一下历史
- `presetManager unavailable` → SillyTavern 版本太旧，升级到 1.10+

**预设下拉显示不对：**
- 历史面板 → 设置 → 预设接管 → 关掉开关就恢复了

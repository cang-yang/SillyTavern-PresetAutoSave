# 安装指南

## 方式一：通过 SillyTavern 扩展管理器（推荐）

1. 启动 SillyTavern
2. 点击右上角扩展图标
3. 选择「管理扩展」
4. 在 "Install Extension" 中粘贴：
   ```
   https://github.com/yourname/SillyTavern-PresetAutoSave
   ```
5. 选择「为所有用户安装」或「仅为当前用户安装」
6. 等待安装完成
7. 刷新页面

## 方式二：Git 克隆

```bash
# 进入用户的扩展目录
cd data/<your-username>/extensions

# 克隆项目
git clone https://github.com/yourname/SillyTavern-PresetAutoSave third-party/SillyTavern-PresetAutoSave

# 重启 SillyTavern
```

## 验证安装

打开开发者控制台（F12），看到以下日志即代表加载成功：

```
[PAS] SillyTavern-PresetAutoSave v1.0.0 loading...
[PAS] All systems ready ✓
```

## 故障排查

### 看不到历史按钮？
- 确认扩展已启用（在「管理扩展」中查看）
- 检查浏览器控制台是否有报错
- 尝试切换 API Type 后再切回

### 保存失败？
- 查看控制台错误信息
- 检查 SillyTavern 服务端是否正常
- 临时关闭其他扩展排除冲突

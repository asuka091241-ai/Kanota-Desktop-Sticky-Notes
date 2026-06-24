# Kanota

跨平台桌面看板便签应用，基于 Electron 构建。

一边管理看板任务，一边把任意卡片拖到桌面变成浮动便签。

## 功能

- **看板管理**：待办 / 进行中 / 已完成三列看板，右键快速更换颜色、删除
- **桌面便签**：拖动卡片到看板外自动创建便签，支持折叠、展开、固定、拖拽移动
- **颜色主题**：8 种便签底色，看板卡片和桌面便签颜色实时同步
- **右键菜单**：原生菜单，支持更换颜色、状态流转、桌面移除
- **回收站**：删除的便签进入回收站，支持恢复
- **系统托盘**：关闭窗口时选择最小化到托盘或退出
- **深色模式**：自动适配系统主题

## 快速开始（推荐）

### 方式一：直接下载运行

1. 打开 [Releases](https://github.com/asuka091241-ai/-/releases) 页面
2. 下载最新的 `Kanota.exe`（便携版，无需安装）
3. 双击运行即可

### 方式二：从源码运行

> 需要电脑已安装 [Node.js](https://nodejs.org)（18+）

```bash
# 1. 克隆仓库
git clone https://github.com/asuka091241-ai/-.git
cd -

# 2. 安装依赖
npm install

# 3. 运行
npm start
```

### 方式三：自己打包

```bash
npm install
npm run build
# 输出在 release/win-unpacked/Kanota.exe
```

## 使用说明

| 操作 | 方式 |
|------|------|
| 新建任务 | 看板页面顶部输入框 |
| 拖出便签 | 在看板卡片上按住鼠标拖出窗口 |
| 便签右键 | 右键便签 → 更换颜色 / 从桌面移除 |
| 卡片右键 | 右键看板卡片 → 打开详情 / 更换颜色 / 删除 |
| 便签折叠 | 点击便签顶部 ▼ / ▲ |
| 便签固定 | 点击 📌 按钮固定位置 |
| 关闭窗口 | 点击 × → 选择最小化到托盘或退出 |

## 技术栈

- Electron
- 原生 HTML / CSS / JS（无框架）
- IPC 通信
- JSON 本地持久化

## 项目结构

```
├── main.js           # Electron 主进程
├── preload.js        # 看板窗口 preload
├── preload-sticky.js # 便签窗口 preload
├── index.html        # 看板主界面
├── sticky.html       # 桌面便签界面
├── icon.svg          # 图标源文件
├── build-icon.js     # 图标生成脚本
└── package.json
```

## License

MIT

# 鲸群 App 图标

用户确认稿：深蓝鲸群、分层蓝色海面、金黄色通知点、白底圆角。

- `AppIcon.png`：1024×1024 透明 PNG 主图。
- `AppIcon.icns`：macOS 多尺寸图标。
- `AppIcon.iconset/`：16–1024 像素、1x/2x 导出。
- `source.png`：生成工具清理后的原图；导出时用精确圆角蒙版剔除外围残留像素。

重新导出（项目根目录）：

```sh
swift scripts/export-app-icon.swift "$PWD"
iconutil -c icns assets/app-icon/AppIcon.iconset -o assets/app-icon/AppIcon.icns
```

DSH 0.1.5 本地 App 打包配置位于 `deepseek-harness/.worktrees/dsh-015/apps/desktop/electron-builder.config.mjs`，仅 `DSH_DESKTOP_LOCAL_ADHOC=1` 使用 `assets/matou/AppIcon.icns`。更新设计后需同步该资源，官方打包路径保持原样。

已安装 App 使用 `Contents/Resources/MatouWhales.icns` 和 `CFBundleIconFile`。替换后须重新签名，正常重开；备份位于本项目 `.artifacts/app-icon/`。仅改变 App 身份图标，不改变侧栏品牌 Logo 和用户数据。

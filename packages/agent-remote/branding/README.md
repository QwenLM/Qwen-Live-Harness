# Agent Remote artwork

The approved identity is the phone + laptop design (v2). The transparent symbol is `agent-remote-symbol-v2.png`; the full-bleed icon artwork is `agent-remote-app-icon-v2.png`. The iOS asset catalog contains its opaque 1024 × 1024 export. Application names, bundle identifiers and pairing credentials are independent of these assets.

`swift scripts/prepare-brand-assets.swift` exports a tightly fitted template mark for both apps and applies the macOS rounded-square mask to the iOS icon. The macOS build runs this exporter automatically. The menu bar uses the template mark so macOS supplies the appropriate light/dark color. The standalone source export includes this directory.

当前采用第二版“手机＋电脑”标志。`agent-remote-symbol-v2.png` 是透明底标志，`agent-remote-app-icon-v2.png` 是满版图标原图；iOS 资源目录中保存其无透明通道的 1024 × 1024 导出。图标资源不影响应用名称、Bundle ID 或配对凭据。

`swift scripts/prepare-brand-assets.swift` 为两个应用导出紧凑的单色模板标志，并为 macOS 图标添加圆角与透明边距。macOS 构建时会自动执行。菜单栏由系统为模板标志设置浅色／深色模式颜色；独立源码导出包含本目录。

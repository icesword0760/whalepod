# README 动效演示

三段 GIF 均由 `demo.html` 中的独立模拟界面生成，用于说明操作流程，不是真实 App 录屏或功能验收凭据。

- `cards.gif`：调整宽度、双击恢复、长按拖动排序。
- `dag.gif`：查看父子分支，定位到对应会话。
- `import.gif`：空白会话入口、搜索、预览、导入。

项目“海岛日历”、事项、对话、检查结果、时间与 `/demo/island-calendar` 路径均为虚构。页面不访问 DSH、Claude Code 或 Codex 数据，无接口请求、凭据或远程字体。

## 重新生成

需要 Playwright CLI、浏览器和 FFmpeg。从仓库根目录执行：

```bash
python3 -m http.server 8786 --bind 127.0.0.1 --directory assets/demos
```

另开终端：

```bash
mkdir -p assets/demos/frames/{cards,dag,import}
playwright-cli -s=whalepod-demo open http://127.0.0.1:8786/demo.html
playwright-cli -s=whalepod-demo run-code --filename assets/demos/capture.cjs
bash assets/demos/encode.sh
playwright-cli -s=whalepod-demo close
```

每段 9 秒、10 帧/秒，使用调色板优化。PNG 中间帧不提交。

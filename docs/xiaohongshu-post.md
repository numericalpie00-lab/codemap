# 小红书帖子草稿 — CodeMap

> 用途：小红书图文帖文案，正文 858 字（小红书上限 1000）。
> 配图建议：首图用 `docs/codemap.png`（地图全景 + 高亮节点），
> 第二张截 timeline 面板，第三张截中文语义分组的图例。

---

## 标题（二选一）

- vibe coding 三天，我已经不认识我自己的项目了😅
- 给 AI 写的代码画了张"活地图"，再也不怕迷路了🗺️

## 正文

家人们有没有同款：用 Claude Code / Cursor 疯狂 vibe coding，三天撸出一个项目，爽是真爽——过几天想改个小功能，打开仓库：？？？这文件谁写的？哦，是"我"写的🙃

vibe coding 最大的痛不是写不出来，是写完就失忆：上下文全埋在长长的 chat log 里，AI 唰唰改了 5 个文件，你只看到 diff，脑子里那张架构图早就过期了。

于是我索性 vibe 出了个小工具：CodeMap 🗺️
一句话：给你的代码库画一张实时地图，挂在副屏上。

✨ 用起来长这样：
- 一行命令启动，浏览器里就是一张力导向图：文件是节点，import 是连线
- AI 一改文件，节点当场亮起，还有个 "you are here"📍——你永远知道 AI 的手摸在系统哪个角落
- 右侧时间线记下这一局改过的文件，把线性聊天记录变成空间"足迹"
- 最戳我的：接上 LLM 后，文件按"它是干嘛的"分组——"用户认证""数据持久化"，直接是中文业务域气泡🤝

它还特别轻：零依赖，Node 20+ 就能跑，全项目才 950 行。不配 API key 也能用（退化成按文件夹分组），配个便宜模型就解锁语义分组，结果有缓存，重启秒开。

用了几天最大的感受：终于有了上帝视角——AI 在下面搬砖，我在地图上看它搅动了哪个域，心里有底多了。

🚧 坦白局，它还是很早期的 v0：
1. import 分析只对 JS/TS 调教过，其他语言连线很稀疏
2. 前端 1 秒轮询，大仓库性能还没优化
3. 还不懂 git，点节点看不了 diff
4. 还有个没实现的大饼 Conductor：反过来驱动 coding agent 分阶段干活、每阶段强制验收

所以！MIT 开源，特别欢迎来提 issue / PR：加一门语言的解析、换 WebSocket、接 git diff、实现 Conductor，都是好上手的切入点👏

GitHub：numericalpie00-lab/codemap
评论区聊聊：你 vibe coding 时怎么防止迷路？🧭

## 标签

#vibecoding #开源项目 #ClaudeCode #Cursor #程序员日常 #独立开发 #AI编程 #可视化 #开源社区

---

## X posts（build in public，每条 ≤140 字符）

1. Vibe coding confession: I shipped a whole project in 3 days, then opened the repo and didn't recognize my own code. So I built a fix 🗺️
2. Meet CodeMap: a live spatial map of your codebase. Your AI edits a file → its node lights up on the map. You always know where you are 📍
3. The chat log is linear. Your codebase isn't. CodeMap turns every AI edit into a glowing dot on a map + a session timeline. Second-screen it
4. Fun part: an LLM groups files by what they DO, not what folder they're in. "auth", "canvas", "persistence" — a real system map, not a tree
5. Stats so far: 0 dependencies, ~950 lines, one command to run (node server.mjs). No API key? Still works, just folder-based grouping
6. Being honest: it's a rough v0. JS/TS only imports, 1s polling, no git awareness yet. MIT licensed — issues & PRs very welcome 🙏
7. Next up: Conductor — the map drives the agent, not just watches it. Phased prompts, a verify gate after each phase. Spec done, code next

# mooc-auto 使用教程（从零到交卷）

> 这份教程按"我要把某份作业做完"的顺序写，命令可以直接复制。
> 功能清单和原理在 [README.md](./README.md)；这里只讲**怎么用**。

---

## 0. 先选路径

| 你要做的事 | 走哪条 | 自动化程度 |
|---|---|---|
| 中国大学MOOC（icourse163）单元测验 | **路径 A** | 全自动：抓题→模型答→填→交 |
| 学习通（超星/泛雅）作业、章节测验 | **路径 B** | 半自动：抓题后由模型或人给答案，再一键填+交 |

两条路径都依赖同一个前提：**一个开启调试端口、已登录的浏览器**（第 1 步）。

---

## 1. 一次性准备（只做一次）

```powershell
cd C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\mooc-auto

# 1) 装依赖（只有 playwright-core，不下载浏览器）
npm install

# 2) 拉起专用浏览器窗口（独立配置目录，不碰你日常浏览器）
node mooc.mjs launch

# 3) 在弹出的窗口里登录：爱课程 和 学习通 各扫一次码（登录态会记住）
#    爱课程: https://www.icourse163.org/
#    学习通: https://i.chaoxing.com/

# 4) 体检：四个 true 就齐了
node mooc.mjs doctor --api-key-file key.txt
```

`doctor` 正常输出关键字段：

```json
{
  "cdpOk": true,
  "session": { "hasIcourse163": true, "hasChaoxing": true },
  "keyDb": { "entries": 557 },
  "apiKey": { "present": true, "masked": "sk-2…3552" },
  "paceDefault": "auto"
}
```

> 浏览器关掉后下次再用：`node mooc.mjs launch` 重新拉起即可，登录态还在。
> 想彻底关掉：`node mooc.mjs close`。

### 1.1 写入 API Key（一次）

```powershell
cd C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\mooc-auto
$k = Read-Host "粘贴 API Key 后回车"
[IO.File]::WriteAllText("$PWD\key.txt", $k.Trim(), (New-Object Text.UTF8Encoding($false)))
```

验证（只显示首尾）：`(Get-Content .\key.txt -Raw).Trim().Substring(0,4)`

之后所有命令带 `--api-key-file key.txt` 即可。`key.txt` 已在 `.gitignore` 里，不会被提交。

---

## 2. 路径 A：中国大学MOOC 单元测验（全自动）

```powershell
# ① 看课程下有哪些测验、各得了多少分
node mooc.mjs list

# ② 预演：只抓题 + 让模型作答，不点页面（最安全）
node mooc.mjs run --quiz "创业风险单元检测" --dry-run --api-key-file key.txt

# ③ 真跑：抓题→答题→填写，不交卷
node mooc.mjs run --quiz "创业风险单元检测" --yes --api-key-file key.txt

# ④ 确认无误后交卷
node mooc.mjs run --quiz "创业风险单元检测" --yes --submit --api-key-file key.txt
```

**节奏说明**：慕课默认 `--pace auto` —— 先用 3 次快速点击探测有没有"并发限制"，
没触发就快填（120ms/题），触发了自动降到 1800ms/题并保持。不用手动选。

**注意**：慕课"再做一次"每次抽到的题目不同，不能靠背答案；脚本会重新抓题重新答。

---

## 3. 路径 B：学习通作业（半自动，关键是复制 URL）

### 3.1 为什么必须先复制 URL

学习通的作业答案**存在页面前端状态里**（点选项才写进隐藏域），
一旦把那个标签页导航走，答案就没了；而且作业页带了 `workId/enc` 这类签名参数，
不是固定网址，**只能从浏览器地址栏拿**。

### 3.2 完整操作（4 步）

**第 1 步：打开作业页，复制地址**

在浏览器里进课程 → 作业 → 点开那份作业（会新开标签页），
地址栏形如：

```
https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=...&classId=...&workId=58671736&answerId=...&standardEnc=...&enc=...
```

`workId=` 那串数字就是这份作业的 id。

**第 2 步：抓题**

```powershell
node mooc.mjs extract --platform chaoxing --quiz "<粘贴完整URL>" --yes
```

产出 `out/questions-<workId>.json`，里面每题有 `i`(题号)、`type`、`stem`、`opts`。

**第 3 步：生成答案（两种方式，二选一）**

- **让模型答**（纯文字题适用）：

```powershell
node mooc.mjs answer --platform chaoxing --in out/questions-58671736.json --api-key-file key.txt
```

- **人工/让 AI 看图作答**（**图片题必须走这条**：公式、图表题的选项是图片，模型只看到空文本）：
  把题目发给我（或自己看），我给出每题字母；存成 `out/answers-58671736.json`。

**第 4 步：填写并交卷（一条命令，务必带 `--submit`）**

```powershell
node mooc.mjs fill --platform chaoxing --quiz "<同一URL>" `
  --answers out/answers-58671736.json --pace fast --submit
```

为什么必须"填+交"一条命令：`fill` 会新开标签页并导航到作业页，
如果你分两次跑（先填、再单独交），第二次会重新加载页面 → 之前点的答案全丢。
工具已改为**每份作业独立标签页**，但仍建议一条命令跑完。

输出里看 `"ok": 45` 和 `submit.score`（如 `作业 100分`）即成功。

### 3.3 看分数与重做

- 提交后在作业列表点"作答记录"看每次得分，**取最高/最终**字样那行
- 允许重做时页面会给"重做"按钮；重做后题目不变（选项顺序也不变，工具会先校验再填）

---

## 4. 答案文件的格式

```json
{
  "quizId": "58671736",
  "platform": "chaoxing",
  "answers": [
    { "i": 1,  "answer": "A" },
    { "i": 28, "answer": "BCD" },
    { "i": 35, "answer": "T" }
  ]
}
```

- 单选：`"A"`
- 多选：`"BCD"`（按字母序写，别加逗号）
- 判断：`"T"` = 对，`"F"` = 错（**不用管页面上显示成 A/B 还是 true/false**，工具按"对/错"文字映射）

---

## 5. 常用参数速查

| 参数 | 作用 | 常用值 |
|---|---|---|
| `--quiz` | 目标：慕课传 id 或名称片段；学习通传**作业页完整 URL** | `"创业风险"` / `https://mooc1...dowork?...` |
| `--platform` | 平台 | `icourse163` / `chaoxing` |
| `--pace` | 节奏 | `auto`(慕课默认) / `fast`(学习通默认) / `slow` |
| `--submit` | **真正交卷**（不加就只填不交） | |
| `--yes` | 允许"开始测验"（慕课会启动 60 分钟计时） | |
| `--dry-run` | 只抓题+答题，不点击 | |
| `--api-key-file` | 读 key 文件 | `key.txt` |
| `--provider` | 模型服务商 | `deepseek`(默认) / `openai` |
| `--base-url` | 自建/中转网关 | `https://xxx/v1` |
| `--model` | 模型名 | `deepseek-chat` |
| `--no-probe` | 跳过频控探测，直接按 pace 填 | |
| `--key-db` | 用自己的答案库 | `./my-keydb.json` |
| `--cdp-url` | 调试端口 | `http://127.0.0.1:9222` |
| `--out-dir` | 产物目录 | `./out` |

---

## 6. 报错对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `连不上调试端点` | 浏览器没开/已关 | `node mooc.mjs launch` |
| 开了 `--remote-debugging-port` 仍连不上 | Chrome/Edge 136+ 在**默认用户目录**忽略该参数 | 必须 `--user-data-dir` 指向独立目录（`launch` 已处理） |
| `hasChaoxing: false` | 那个窗口没登录学习通 | 在窗口里扫码登录一次 |
| 抓题成功但 `fill` 回读全 0 | 页面被导航走，前端答案丢失 | 用**一条命令** `fill --submit` 重跑 |
| `找不到测验「xxx」` | 名称没匹配上 | 用 id，或换更独特的名字片段 |
| `HTTP 401` | key 无效 / base-url 不对 | 检查 `key.txt` 与 `--provider` |
| `HTTP 400 response_format` | 网关不支持 JSON 模式 | 工具会自动降级重试，无需处理 |
| 提交后没看到分数 | 页面在"作业"列表 | 点该作业的「作答记录」查看 |
| 图片题答案空白 | 选项是图片，模型看不到 | 人工看图后把字母写进答案文件 |

---

## 7. 停止与清理

| 想停的东西 | 做法 |
|---|---|
| 正在跑的脚本 | 终端 `Ctrl+C`（页面已点的答案保留，不会自动交） |
| 它拉起的浏览器 | `node mooc.mjs close`，或直接关窗口 |
| 关不掉 | `launch` 输出里的 `pid` → `taskkill /PID <pid> /F` |
| 清本地残留 | `Remove-Item -Recurse -Force browser-profile, out` |

> 注意：慕课一旦点了"开始测验"，60 分钟计时就在走（脚本停止不会暂停）。

---

## 8. 实测基线（可作为对照）

| 课程 | 作业 | 题量 | 得分 | 说明 |
|---|---|---|---|---|
| 统计学（学习通） | 第十一章测验 | 45（单选27/多选7/判断11） | 96.7 | 不允许重做；3.3 分丢在多选部分得分规则 |
| 算法与数据结构（学习通） | 树与二叉树 | 8 | 100 | 重做一次修正 1 题 |
| 算法与数据结构（学习通） | 栈与队列 | 10 | 100 | 一次通过 |
| 算法与数据结构（学习通） | 第6讲 字符串 | 9 | 100 | 重做一次修正 1 题 |
| 中国大学MOOC | 创新方法等 9 个单元检测 | 45/卷 | 50/50 共 4 卷、其余 39–49.5 | 答案库 + 模型混合 |

---

## 9. 最短记忆版

```powershell
# 开环境
node mooc.mjs launch                      # 首次要在窗口里扫码登录
node mooc.mjs doctor --api-key-file key.txt

# 慕课：一条龙
node mooc.mjs run --quiz "单元测验名" --yes --submit --api-key-file key.txt

# 学习通：抓 → 答 → 填+交（URL 从地址栏复制）
node mooc.mjs extract --platform chaoxing --quiz "<URL>" --yes
node mooc.mjs answer  --platform chaoxing --in out/questions-<id>.json --api-key-file key.txt
node mooc.mjs fill    --platform chaoxing --quiz "<URL>" --answers out/answers-<id>.json --pace fast --submit
```

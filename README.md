# mooc-auto

中国大学MOOC（icourse163）与学习通（超星/泛雅）单元测验的**半自动答题工具**：

> **接管你已登录的浏览器 → 抓题 → 用大模型（或内置答案库）作答 → 按平台节奏填写 → 回读校验 → 可选交卷**

核心特性：

- **不用重新登录**：通过 CDP 接管你已登录的浏览器标签页，登录态、课程权限都保留
- **模型答题**：支持任意 OpenAI 兼容接口（DeepSeek / OpenAI / 自建网关），API Key 有 4 种入口
- **分平台节奏**（重点）：
  - 学习通：默认**快速填写**（约 120ms/题）
  - 慕课：默认 **auto——先探测**是否触发"并发限制"，没触发就快速填，触发了自动降速到 1800ms/题并保持
- **风控自适应**：填写过程中一旦弹"并发限制"，自动关弹窗、等待、重试当前选项并永久降速
- **可回读校验**：每题填完回读勾选状态，报告未填/填错项
- **默认不交卷**：必须显式加 `--submit` 才会点"提交答案"

> **第一次用？** 先看 **[TUTORIAL.md](./TUTORIAL.md)** —— 按"我要交作业"的顺序写的教程（选路径、一次性准备、两条操作路径、报错对照、停止清理）。
> 功能全集见文末 [§11](#11-给其他人使用上手--接模型--停止)。

---

## 1. 环境准备

需要 Node.js ≥ 18。

```bash
cd mooc-auto
npm install
```

### 让浏览器开启调试端口

Chrome/Edge 136+ 起，**默认用户数据目录下 `--remote-debugging-port` 会被忽略**，必须用独立目录：

```bash
# 方式一：用工具自带的 launch 命令（推荐）
node mooc.mjs launch

# 方式二：手动
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\mooc-auto-profile"
```

新窗口里打开 <https://www.icourse163.org/> 或学习通，**扫码登录一次**（之后这个独立配置目录会记住登录态）。
日常用的浏览器不会被影响，也不会被关闭。

体检：

```bash
node mooc.mjs doctor
```

---

## 2. 快速开始

```bash
# 看课程下所有测验及得分/剩余次数
node mooc.mjs list

# 一条龙：抓题 → 答题 → 探测 → 填写（不交卷）
node mooc.mjs run --quiz "创业团队单元检测" --yes

# 确认答案无误后再交卷
node mooc.mjs run --quiz "创业团队单元检测" --yes --submit

# 只抓题 + 生成答案，先人工过目（最安全）
node mooc.mjs extract --quiz "创业风险单元检测" --yes
node mooc.mjs answer  --in out/questions-<quizId>.json
# 看一眼 out/answers-<quizId>.json
node mooc.mjs fill    --quiz "创业风险单元检测" --answers out/answers-<quizId>.json
```

`--quiz` 可以传测验 id（`1258532135`）或名称片段（`"创业风险"`）。

---

## 3. API Key 的 4 种入口

| 方式 | 示例 |
|---|---|
| 命令行参数 | `--api-key sk-xxxx` |
| 从文件读 | `--api-key-file ./key.txt` |
| 从标准输入 | `--api-key -`（执行后粘贴，避免留在 shell 历史） |
| 环境变量 | `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `MOOC_API_KEY` / `OPENROUTER_API_KEY` |
| 配置文件 | `config.json` 里的 `"apiKey"` |

优先级：`--api-key` > `--api-key-file` > 环境变量 > 配置文件的 `apiKey`。

```bash
# DeepSeek（默认）
node mooc.mjs run --quiz "创业资源" --yes --api-key sk-xxx

# OpenAI
node mooc.mjs run --quiz "创业资源" --yes --provider openai --model gpt-4o-mini

# 任意 OpenAI 兼容网关
node mooc.mjs run --quiz "创业资源" --yes \
  --base-url https://your-gateway/v1 --model your-model --api-key sk-xxx

# 只用内置答案库，完全离线（不调模型）
node mooc.mjs run --quiz "创新方法" --yes --source key
```

> Key 只会以打码形式出现在日志里（如 `sk-a…z9k2`），不会被写进任何产物文件。

答题策略 `--source`：

- `auto`（默认）：先用内置答案库（`data/keydb.json`，557 题，来自公开答案整理稿），未命中的再交给模型
- `key`：只用答案库，不调模型
- `model`：全部交给模型

> **内置答案库是按这门课整理的**（南京信息工程大学《敢创会创-大学生创新创业实务》，`courseId=NUIST-1206810807`）。
> 别人的课程题目不同，命中率会很低甚至为 0，这属正常：`auto` 模式会自动把未命中的题交给模型作答，也可以用 `--source model` 完全跳过它。
> 想用自己课程的答案库，用 `--key-db <路径>` 指向同格式 JSON（字段见 `src/keydb.mjs`：`q`/`answer`/`options`/`letters`），例如：
>
> ```bash
> node mooc.mjs run --quiz "创业风险" --yes --key-db ./my-course-keydb.json
> ```

---

## 4. 节奏控制（这是关键设计）

```bash
--pace auto    # 慕课默认：先快速探测 → 触发限制才降速
--pace fast    # 学习通默认：120ms/题
--pace slow    # 强制 1800ms/题
--fast-ms 150 --slow-ms 2200   # 自定义
--no-probe     # 跳过探测
```

慕课的探测（`probe`）做法：在**单选题**上以 150ms 间隔快速点 3 次，然后检查是否出现"并发限制，请稍后再试"。

- 没出现 → 全程快速填写
- 出现了 → 关掉弹窗、自动切 `slow`（1800ms±400ms 抖动）后继续

填写过程中每次点击后都会再检查一次弹窗，出现就：关窗 → 等 6 秒 → 重试该选项 → 保持慢速。

也可以单独探测：

```bash
node mooc.mjs probe --quiz "创业团队单元检测"
```

---

## 5. 命令一览

| 命令 | 作用 | 会消耗尝试次数吗 |
|---|---|---|
| `doctor` | 体检调试端口/登录态/答案库/Key | 否 |
| `launch` | 拉起带调试端口的独立浏览器 | 否 |
| `close` | 关闭 `launch` 拉起的浏览器 | 否 |
| `list` | 列出测验列表与得分 | 否 |
| `extract` | 打开测验并抓题（加 `--yes` 才点"开始测验"） | 点"开始测验"会启动 60 分钟计时 |
| `answer` | 对题目文件生成答案 | 否 |
| `probe` | 只探测并发限制 | 会点 3 个选项 |
| `fill` | 按答案填写（`--submit` 才交卷） | 交卷才计分 |
| `run` | 一条龙 | 交卷才计分 |

产物默认写到 `./out/`：`questions-<id>.json`、`answers-<id>.json`。

---

## 6. 平台支持

### 中国大学MOOC（icourse163）

已完整适配并实测：题目容器 `.u-questionItem`、选项 `.optionPos/.optionCnt`、判断题 ✓/✗ 图标（**逐题随机左右**，工具按图标识别，不会错位）、`开始测验` 承诺勾选、`提交答案` 确认弹窗、得分页。

课程信息默认：

```json
{ "courseId": "NUIST-1206810807", "tid": "1487847445" }
```

换课程用 `--course-id` / `--tid` 覆盖，或写进 `config.json`。

### 学习通（超星/泛雅）

用启发式结构识别（多套页面皮肤），默认 `fast` 节奏、不做频控探测。
不同学校皮肤差异较大，若抓不到题，用 `config.json` 的 `selectors` 覆盖：

```json
{
  "selectors": {
    "question": "div.questionLi",
    "stem": ".Zy_TItle",
    "option": ".answerList li"
  }
}
```

学习通建议直接用 URL：

```bash
node mooc.mjs run --quiz "https://mooc1.chaoxing.com/..." --yes
```

---

## 7. 配置文件

复制 `config.example.json` 为 `config.json` 后按需修改；命令行参数优先级更高。

```json
{
  "cdpUrl": "http://127.0.0.1:9222",
  "platform": "icourse163",
  "course": { "courseId": "NUIST-1206810807", "tid": "1487847445" },
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiKey": "",
  "pace": "auto",
  "fastMs": 120,
  "slowMs": 1800,
  "probe": { "clicks": 3, "intervalMs": 150 },
  "outDir": "./out"
}
```

---

## 8. 排错

| 现象 | 原因与处理 |
|---|---|
| `连不上调试端点` | 浏览器没开调试端口 / 端口不对。用 `node mooc.mjs launch`，或检查 `--cdp-url` |
| 开了 `--remote-debugging-port` 但仍连不上 | Chrome/Edge 136+ 在**默认用户目录**下会忽略该参数，必须 `--user-data-dir` 指向独立目录 |
| `还没有登录` / 抓不到题 | 在调试窗口里扫码登录一次；`doctor` 里 `session.hasIcourse163` 应为 `true` |
| 反复弹"并发限制" | 用默认 `--pace auto`；或直接 `--pace slow`。不要手动狂点 |
| 答案有 `??` | 该题答案库和模型都没给出合法答案，`answers-*.json` 里会留空，填写时跳过 |
| 判断题全错 | 说明平台把 ✓/✗ 换了位置——本工具按图标识别，若仍出问题请反馈页面结构 |

---

## 9. 自测

```bash
npm test          # = test:unit + test:fill
npm run test:unit # 19 项：归一化/答案解析/判断题图标映射/答案库定位/参数解析
npm run test:fill # 9 项：用本地夹具页面真实跑 extract + fill + 回读校验（需已开调试端口）
```

`test:fill` 不联网、不碰线上测验，用 `tests/fixture-quiz.html` 模拟：单选、多选（含"脏选项"纠错）、判断题（✓ 在第二项）。

模型链路自测（本地假模型，不花钱）：

```bash
node tests/mock-llm.mjs 8788          # 另开一个终端
node mooc.mjs answer --in tests/fixtures/questions-team.json --source model \
  --base-url http://127.0.0.1:8788/v1 --api-key sk-test --model mock
```

---

## 10. 使用边界

- 工具默认**不交卷**，交卷必须显式 `--submit`，方便你先人工核对
- 慕课每次"再做一次"**抽到的题目是随机的**，因此不同次尝试的题目不同，不能靠背答案，需重新答题
- 请自行遵守所在课程/学校的学术规范；成绩、风险由使用者自负

---

## 11. 给其他人使用：上手、接模型、停止

### 11.1 五分钟跑通

前置：**Node.js ≥ 18**，以及任意 Chrome / Edge（不用预装 git）。

```bash
git clone https://github.com/Issac0797/mooc-auto.git
cd mooc-auto
npm install                  # 只装 playwright-core，无浏览器下载
node mooc.mjs launch         # 拉起一个"独立配置"的浏览器窗口
```

在**新弹出的窗口**里打开课程页并扫码登录一次（登录态存进 `./browser-profile/`，以后不用再登）。
这个窗口和你日常浏览器互不影响，也不会被脚本关掉你别的标签页。

然后自检两条：

```bash
node mooc.mjs doctor         # 应看到 cdpOk=true、session.hasIcourse163=true
node mooc.mjs list           # 列出课程下所有测验 + 当前得分
```

### 11.2 怎么接模型

只要**OpenAI 兼容**的 `/chat/completions` 都能用（DeepSeek、OpenAI、自建/中转网关）。

```bash
# A. DeepSeek（默认 provider）
#    PowerShell: $env:DEEPSEEK_API_KEY="sk-xxx"    bash: export DEEPSEEK_API_KEY=sk-xxx
node mooc.mjs run --quiz "创业团队单元检测" --dry-run

# B. OpenAI
node mooc.mjs run --quiz "创业团队单元检测" --yes --provider openai --model gpt-4o-mini --api-key sk-xxx

# C. 自建 / 中转网关
node mooc.mjs run --quiz "创业团队单元检测" --yes \
  --base-url https://your-gateway/v1 --model your-model --api-key sk-xxx
```

Key 的四种传法（优先级从高到低）：

| 方式 | 写法 |
|---|---|
| 命令行 | `--api-key sk-xxx` |
| 文件 | `--api-key-file ./key.txt` |
| 标准输入（不进 shell 历史） | `--api-key -`，回车后粘贴 |
| 环境变量 / 配置文件 | `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `MOOC_API_KEY`，或 `config.json` 的 `apiKey` |

只想验证模型是否通、完全不碰浏览器：

```bash
node mooc.mjs extract --quiz "创业团队单元检测" --yes   # 生成 out/questions-<id>.json
node mooc.mjs answer  --in out/questions-<id>.json      # 只调模型，产出 out/answers-<id>.json
```

**费用参考**：一次 45 题的测验约 3 次请求、几千 token，DeepSeek 上通常几分钱级别。
不想用模型就 `--source key`（仅用内置答案库；**别人的课程题目不同，会大量未命中**）。
日志里 Key 只显示打码形式（如 `sk-a…z9k2`），不会写进任何产物文件。

### 11.3 推荐的稳妥顺序

```bash
node mooc.mjs list                                        # 1. 看剩余尝试次数
node mooc.mjs run --quiz "创业风险单元检测" --dry-run      # 2. 只抓题+生成答案，不点击
#    人工看一眼 out/questions-*.json 与 out/answers-*.json
node mooc.mjs fill --quiz "创业风险单元检测" --answers out/answers-<id>.json   # 3. 只填不交
node mooc.mjs run  --quiz "创业风险单元检测" --yes --submit                    # 4. 或直接一条龙+交卷
```

### 11.4 怎么停止

| 想停的东西 | 做法 | 后果 |
|---|---|---|
| 正在跑的脚本 | 在终端按 **`Ctrl+C`** | 脚本退出；浏览器和页面上**已勾选的答案保持不动**，不会自动交卷 |
| 脚本拉起的浏览器 | `node mooc.mjs close` | 通过 CDP 让浏览器自行退出（也可直接关窗口） |
| 浏览器关不掉 | `launch` 输出里的 `pid` 就是主进程：`taskkill /PID <pid> /F` | 强制结束，登录态仍留在 `browser-profile/` |
| 卡住不响应 | 关掉该终端窗口即可 | 脚本没有常驻后台服务，不占端口（除调试端口 9222 由浏览器持有） |
| **已经开始的测验** | 停止脚本 ≠ 交卷；但**60 分钟计时仍在走**，到点平台可能自动交卷 | 不想交就尽早决定；已交卷的取多次中的最高分 |

清理本地残留（可选）：

```powershell
Remove-Item -Recurse -Force browser-profile, out   # Windows
rm -rf browser-profile out                         # bash
```

`browser-profile/` 装的是**你自己的登录 cookie**，已被 `.gitignore` 排除，不要外传。

### 11.5 换一门课 / 换一个平台

```bash
# 换课程（慕课）
node mooc.mjs list --course-id "NUIST-1206810807" --tid "1487847445"
# 或写进 config.json: { "course": { "courseId": "...", "tid": "..." } }

# 学习通：直接用作业页 URL
node mooc.mjs run --quiz "https://mooc1.chaoxing.com/..." --yes
```

学习通是启发式结构识别，各校皮肤不同；抓不到题时按 §6 用 `config.selectors` 覆盖选择器。

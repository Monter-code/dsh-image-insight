# dsh-image-insight · 图像洞察

DSH 插件：**更准、更快**地识别图片。

一句话：本地用 `sharp` 先把图片"量"一遍（尺寸、清晰度、曝光、主色、边缘密度、候选区域、感知哈希），
再把这份客观测量连同缩放后的图一起交给云端视觉模型，要求它只输出结构化 JSON；
结果按图片指纹缓存，同一张图第二次识别**毫秒返回且不再消耗模型额度**。

- 注册 3 个工具：`image_insight`（主识别）、`image_similarity`（相似图检索）、`image_insight_cache`（缓存维护）
- 一次调用覆盖 5 项能力：内容描述、OCR（带坐标与置信度）、目标定位（相对百分比坐标）、细粒度属性、相似图判定
- 没有视觉模型时不失败：自动降级为完整本地感知结果，并说明原因

---

## 为什么"更准"

1. **客观量交叉印证。** 模型拿到的提示词里附带了本地测得的真实数据：像素尺寸与宽高比、方向是否被纠正、
   拉普拉斯方差对应的清晰度等级、过曝/欠曝裁剪比例、主色列表与彩色占比、边缘密度、UI/文档/照片的类型预判、
   候选区域数量。模型不需要靠"猜"图片是否模糊或偏暗，这些已经有了确定答案。
2. **强制结构化输出。** 系统提示词要求只输出 JSON、不编造看不见的内容、坐标统一为相对整图的 0–100 百分比、
   置信度低于 0.4 的目标不列、看不清的写进 `uncertainty` 字段。插件侧再做一次归一化：
   补全缺失字段、把越界坐标夹回 0–100、按置信度排序、目标上限 40 个、文本块上限 200 个。
3. **视觉模态预检。** 调用前先用 `llm.prepareCall()` 读 `inputModalities`，确认该模型真的声明了 `image` 输入；
   绝不把图片发给纯文本模型（否则会得到一段"我看不到图"的幻觉式回答）。
4. **优先用本机可认证的路由。** 选模型顺序是：显式 `provider`/`model` 参数 → 插件配置 → **宿主默认模型
   （`ctx.agentDefaultModel.currentSelection()`，也就是本机已配置凭据的那条路由）** → 模型目录里第一个声明
   `image` 输入的模型。第四种（`source: "auto-vision-catalog"`）在没登录对应 provider 时会报
   `no API key`，此时插件会在错误里补一句可执行的指引（点名当前会话模型作为候选）。
5. **路由失败可诊断。** 自动选模型时逐个候选尝试，失败时返回**每个候选被拒的原因 + 当前 provider 的模型目录
   （标注哪些支持图片、哪些是纯文本）+ 操作指引**，而不是一句"没有可用模型"。

## 为什么"更快"

1. **`mode: "local"` 完全不出网**——只做本地感知，微秒到毫秒级返回，零模型额度消耗。
2. **指纹缓存。** 缓存键 = `sha256(图片字节) + 请求指纹`。命中则直接返回历史结论，`cloudMs = 0`。
   键里包含"这次要问什么"，所以换 mode / 换提问不会错误复用旧答案。
3. **近似命中。** 每张图入库时记录 dHash/aHash 感知哈希，同图不同尺寸（例如用户截图又重新保存）
   会走近似命中，并**如实标注距离**（`cache.distance`），不会被伪装成精确命中。
4. **本地预缩放再出网。** 出网前按长边 `maxImageEdge`（默认 1536）等比缩放，
   落在官方视觉 token 网格内，避免适配器二次重编码与无谓的上传体积；
   带透明通道的图统一铺白底，避免 alpha 在 JPEG 路径上变成黑块导致识别错误。
5. **批量并行且保序。** 多图按 `maxConcurrency` 限并发处理，结果顺序与输入一致；
   字节完全相同的重复输入会被标记 `duplicateOf` 并跳过重复计算。
6. **相似图检索不读磁盘。** 指纹与摘要直接写进索引条目，检索只比对内存索引，
   不做 O(n) 次文件打开。
7. **按宿主的派发契约构造请求。** 宿主的 `prepareCall()` 会在未显式给档位时把适配器默认思考档
   （`deepseek-flash` 实测为 `high`）写进 resolved config，并在 `prepared.stream()` 派发前用
   `callConfigEquals` 逐字段比对；一旦 options 与 resolved config 不一致就抛
   `prepared LLM call config changed before adapter dispatch`。本插件把比对的字段
   （provider/model/temperature/maxTokens/stop/reasoningEffort）原样从 `prepared.config` 复制进 stream options，
   并默认把档位降到模型声明的**最低档**（`reasoningEffort: "auto"`）——识别属感知任务，不需要长思考链，
   低档位实测显著更快，且这条优化不会破坏上面的派发校验。

---

## 工具

### `image_insight` — 主识别

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 单个本地图片路径（推荐绝对路径）。与 `paths`/`attachmentId` 三选一 |
| `paths` | string[] | 多图批量识别，结果顺序与输入一致 |
| `attachmentId` | string | 会话内已存在的图片附件 ID（例如用户刚上传的图） |
| `mode` | enum | `full`（默认，全部能力）/ `describe` / `ocr` / `objects` / `attributes` / `local`（零出网） |
| `extraInstruction` | string | 额外要求，例如"重点读出水印文字" |
| `question` | string | 针对该图的自由提问，会在结构化识别之外补充回答 |
| `refresh` | boolean | `true` 忽略缓存强制重算 |
| `provider` / `model` | string | 显式指定视觉模型；省略则自动选择 |
| `showImage` | boolean | 结果卡片中附带原图引用块 |
| `cacheTtlDays` | number | 本次结果的缓存有效期（天） |
| `saveIndexLabel` | string | 给这条结果打标签，便于之后按标签辨认 |

`mode` 支持别名：`all`/`auto`→`full`、`detect`/`object`→`objects`、`attr`→`attributes`、`text`→`ocr`、`cache`/`fast`/`off`→`local`。

返回：`{ ok, mode, model:{provider,model,reasoningEffort?,source}, timing:{totalMs,localMs,cloudMs}, cache:{…}, results:[…], similar, stats, notice }`。
`model.source` 取值 `explicit` / `config` / `current-session` / `agent-default` / `auto-vision-catalog` / `none` / `unavailable`，
可直接看出这次用的是"你指定的模型"、"当前会话的模型"、"宿主默认模型（本机可认证）"还是"目录里第一个支持图片的模型"。
`model.reasoningEffort` 是这次实际生效的思考档位（配置为 `auto` 时取模型声明里最低的档，以求快）。

### `image_similarity` — 相似图检索（纯本地）

参数：`path` 或 `attachmentId`、`maxDistance`（0–64，默认 6）、`limit`（默认 5）。
用 dHash 汉明距离在已索引图片中检索，返回 `distance`、`aHashDistance`、`sameFile`、标签与摘要。全程不出网。

### `image_insight_cache` — 缓存维护

参数：`action`（`stats` / `gc` / `clear`）、`ttlDays`（仅 `gc` 使用）。
返回缓存目录、条目数、指纹数、命中统计（精确/近似/未命中）、占用体积、清理结果与调用统计。

---

## 配置

在 `cordis.patch.yml` 的 `config` 里覆盖（`apply(ctx, config)` 会做范围检查与补默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `cacheDir` | `$DSH_HOME/image-insight-cache` | 缓存目录 |
| `cacheTtlDays` | 30 | 条目有效期（天） |
| `cacheMaxEntries` | 2000 | 条目上限，超出按 LRU 淘汰 |
| `maxImageEdge` | 1536 | 出网前长边上限（像素） |
| `maxConcurrency` | 3 | 批量并发上限 |
| `timeoutMs` | 60000 | 单次云端识别超时 |
| `temperature` | 0 | 识别任务默认确定性输出 |
| `maxTokens` | 3000 | 单次云端输出上限 |
| `nearDuplicateDistance` | 6 | 近似命中/相似检索的 dHash 汉明距离阈值 |
| `reasoningEffort` | `auto` | 云端思考档位：`auto` 挑模型声明的最低档（更快）/ `default` 不指定 / 显式档位名如 `low` |
| `provider` / `model` | 空 | 固定视觉模型；留空则自动选择 |

```yaml
- insert:
    - id: dsh-image-insight
      name: dsh-image-insight
      config:
        maxImageEdge: 1536
        cacheTtlDays: 30
```

---

## 依赖与降级

- **`sharp` 是可选依赖。** 解析顺序：常规 `require.resolve` → 插件自己目录下的 `node_modules` →
  `$DSH_HOME/profiles/<name>/node_modules` → profiles 通配 → 当前工作目录向上 6 层。找不到时会抛带可执行指引的
  `IMAGE_INSIGHT_DEPENDENCY_MISSING`，但**插件本身仍能加载**，只是本地感知能力不可用。
  Windows 上 `sharp` 的 win32 平台包必须**同时带 `libvips-42.dll` / `libvips-cpp-*.dll`**，缺 DLL 时
  `require('sharp')` 会报 `Could not load the "sharp" module using the win32-x64 runtime`（宿主里连 `@img` 目录都
  可能只被栽了一半）。本仓库的 `node_modules/` 里放了一份自洽的 `sharp@0.35.4 + @img/sharp-win32-x64（含 DLL）`
  作为**本地兜底**（`.gitignore` 已忽略，不随包发布）；发布到市场后由 npm `optionalDependencies` 正常安装。
- **`llm` / `attachments` 缺失时不报错。** 工具会返回完整的本地结果，`model.source = "unavailable"`，
  `notice` 说明"已降级为本地感知"及具体原因，而不是让整次调用失败。
- 需要云端能力但确实没有可用视觉模型时，抛 `IMAGE_INSIGHT_NO_VISION_MODEL`，错误文本包含候选拒绝原因与模型目录。

## DSH 版本适配

| DSH | 状态 |
| --- | --- |
| **0.2.1**（当前） | 正常。工具注册、`llm.prepareCall()` 派发校验、`sharp` 本地感知、缓存、相似图检索都在 0.2.1 真宿主上跑过 |
| 0.1.x | 正常（0.1.0 插件版本即针对该宿主） |

0.2.1 上没有引入破坏性宿主改动，适配工作是「把清单与验证补齐」：

- `package.json` 增加 `engines.dsh: ">=0.2.1-rc.1"`、`repository` / `homepage` / `author`，版本升到 `0.2.0`；
- 三个工具的输出 schema 在 0.2.1 的严格校验下重新跑通（`tests/schema-contract.mjs`）；
- 本地感知依赖 `sharp` 的 Windows 二进制完整性重新核对（见上一条）。


## 安装

```powershell
# 在 DSH 会话中：
# plugin_manager action=install_bundle target=D:\test-dsh\dsh-image-insight
```

安装后以返回的 `application` 与 `warnings` 为准：`applied` 才算生效，`restart-required` 表示尚未生效，
替换已安装的同名包必须重启才能加载新的 JS 代。

## 测试

```powershell
$node = 'C:\Users\xuan\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node tests\selftest.mjs        # 纯函数 / 本地感知 / 缓存层
& $node tests\integration.mjs     # 走宿主流水线的端到端行为（假宿主）
& $node tests\smoke-load.mjs      # 以宿主方式 import，最小上下文下 apply 不崩
& $node tests\schema-contract.mjs # 三个工具的输出必须过真实宿主那套 schema 校验
```

`tests/host-sim.mjs` 复刻了宿主 `ToolRuntime` 的成功路径：
`execute → 无损 JSON 快照 → schema 严格校验 → deepFreeze → output.render（必须是 ContentBlock[]）→ presentResult`。
契约写错会在测试里直接炸，而不是在界面上静默变成空白卡片。

### 不重启桌面 App 也要验证真实宿主

改完 JS 后桌面 App 里的插件仍是旧模块（宿主不重载），可以用 headless CLI 起一个全新进程验证：

```powershell
$env:DSH_HOME = 'D:\test-dsh\.dsh-headless'          # 隔离 home，避免动到真实配置
& 'C:\Users\xuan\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  --profile headless `
  --patch D:\test-dsh\fixtures\headless-overlay.yml ` # 把 agent-default-model 指到本机可认证的 deepseek-account
  "调用 image_insight 识别 D:\test-dsh\fixtures\vision-test.png，mode=full，把卡片原样贴出来"
```

隔离 home 的 `image-insight-cache` 与真实 home 相互独立；验证完把 `.dsh-headless` 整个删掉即可
（它包含一份 `.credentials.yaml` 副本，不要长期留在工作区）。

## 已知限制

- 相似图检索只覆盖**本插件索引过的图片**，不是全盘搜索。
- 候选区域数是本地估算的**视觉关注区域数量，不是物体数量**，结果里已明确标注这一点。
- 云端识别质量最终取决于所用视觉模型的能力；插件负责的是减少模型犯错的空间（客观测量 + 结构化约束 + 归一化）。
- 小程序式的自定义卡片（`tool.call.toolview` 客户端渲染）尚未实现：当前使用宿主通用的 generic 卡片，
  并由 `presentationMeta` 提供结构化元数据。

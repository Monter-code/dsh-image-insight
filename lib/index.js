/**
 * dsh-image-insight —— DSH 图像洞察插件（Host 半）
 *
 * 设计目标（对应用户要求：更精准、反应迅速、识别准确）：
 *
 *  精准：本地感知层先用 sharp 把图摆正、限边、解码校验，并算出清晰度/曝光/主色/指纹等
 *        客观量作为交叉印证；云端再用严格 JSON schema 收敛模型输出，JSON 解析失败也不丢原文。
 *  迅速：两级本地缓存（精确 sha256 指纹 → dHash 感知哈希）让重复图片完全不出网（毫秒级）；
 *        批量走有限并发；本地模式零网络；单次调用一次拿到五项能力，避免多轮往返。
 *  准确：调用前用 prepareCall() 校验模型确实声明了 image 输入模态，绝不把图发给纯文本模型；
 *        temperature 默认 0；坐标统一为相对百分比，输出前做边界夹取与置信度过滤。
 *
 * 对外提供三个工具：
 *   image_insight        主工具：识别（本地 + 云端，五种识别目标一次覆盖）
 *   image_similarity     以图搜图：在本地指纹索引里检索相似图（纯本地，微秒级）
 *   image_insight_cache  缓存维护与统计
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { ImageInsightCache, cacheSize, exactKey, garbageCollect, hammingDistance64 } from './cache.mjs';
import { analyzeLocal, prepareForVision, readImageFile } from './local.mjs';
import { OUTPUT_SCHEMA, presentationMeta, renderCall, renderResult, resultContent } from './present.mjs';
import { clampInt, formatMs, oneLine, stopwatch, stableStringify, toJsonValue, withTimeout } from './util.mjs';
import { recognizeVision, resolveVisionRoute } from './vision.mjs';

export const name = 'dsh-image-insight';

export const inject = ['tools', 'attachments', 'llm'];

const DEFAULTS = {
  cacheDir: undefined,
  cacheTtlDays: 30,
  cacheMaxEntries: 2000,
  maxImageEdge: 1536,
  maxConcurrency: 3,
  timeoutMs: 60000,
  temperature: 0,
  maxTokens: 3000,
  reasoningEffort: 'auto',
  nearDuplicateDistance: 6,
  provider: undefined,
  model: undefined,
};

/** 五项识别目标 → 提示词重点与是否必须出网。 */
const TASK_PRESETS = {
  full: {
    label: '全量识别',
    cloud: true,
    tasks: ['通用内容理解与描述', '文字识别（OCR）', '目标检测与定位（含坐标）', '细粒度属性（颜色/数量/款式/品牌/型号）'],
  },
  describe: { label: '内容描述', cloud: true, tasks: ['通用内容理解与描述'] },
  ocr: { label: '文字识别', cloud: true, tasks: ['文字识别（OCR），逐块给出坐标与置信度'] },
  objects: { label: '目标检测与定位', cloud: true, tasks: ['目标检测与定位，尽量给出每个物体的相对坐标'] },
  attributes: { label: '细粒度属性', cloud: true, tasks: ['细粒度属性：颜色、数量、款式、品牌、型号、材质、状态'] },
  local: { label: '仅本地感知（零出网）', cloud: false, tasks: [] },
};
const MODE_ALIASES = {
  all: 'full',
  auto: 'full',
  detect: 'objects',
  object: 'objects',
  attr: 'attributes',
  text: 'ocr',
  cache: 'local',
  fast: 'local',
  off: 'local',
};

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig, ctx);
  const state = {
    cache: undefined,
    sharpFailed: undefined,
    stats: { calls: 0, cloudCalls: 0, cacheHits: 0, failures: 0 },
  };

  const cache = () => {
    if (!state.cache) state.cache = new ImageInsightCache({
      dir: config.cacheDir,
      ttlDays: config.cacheTtlDays,
      maxEntries: config.cacheMaxEntries,
    });
    return state.cache;
  };

  const llm = () => ctx.get('llm');
  const attachments = () => ctx.get('attachments');
  // 宿主的 agentDefaultModel 服务：新建 agent 实际会用的模型选择 {provider, model, reasoningEffort?}。
  // 它是「本机真的能认证成功的那条路由」（例如 OAuth 的 deepseek-account），
  // 而模型目录里的 provider id（例如 deepseek-official）可能要求 API key。
  const defaultModel = () => {
    try {
      return ctx.get('agentDefaultModel');
    } catch {
      return undefined;
    }
  };

  // ---------------------------------------------------------------- 工具 1：主识别
  ctx.tools.register({
    name: 'image_insight',
    description:
      '精准识别图片并一次返回五项能力：通用内容理解与描述、文字识别（OCR，带坐标与置信度）、目标检测与定位（相对百分比坐标）、细粒度属性（颜色/数量/款式/品牌/型号）、以及基于本地感知哈希的相似图判定。' +
      '速度：同一张图重复分析走本地指纹缓存，毫秒级返回且不再消耗模型额度；mode="local" 完全不出网（微秒级到毫秒级）。' +
      '用法：给 path 一个或多个本地图片路径（也支持会话内 attachmentId）；返回结构化 JSON 与可读摘要，坐标统一为相对整图的百分比。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '单个本地图片文件路径（推荐绝对路径）。与 paths/attachmentId 三选一。',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '多个本地图片路径，批量识别；结果顺序与输入一致。',
        },
        attachmentId: {
          type: 'string',
          description: '会话内已存在的图片附件 ID（如用户刚上传的图）。',
        },
        mode: {
          type: 'string',
          enum: ['full', 'describe', 'ocr', 'objects', 'attributes', 'local'],
          description: '识别重点。默认 full（一次拿到全部能力）；local 只做本地感知、完全不出网。',
        },
        extraInstruction: {
          type: 'string',
          description: '额外的识别要求，例如「重点读出水印文字」「判断是否为同一件商品」。',
        },
        question: {
          type: 'string',
          description: '针对该图的自由提问；给出后会在结构化识别之外补充回答该问题。',
        },
        refresh: {
          type: 'boolean',
          description: 'true 时忽略缓存强制重新识别（默认 false，命中缓存即毫秒返回）。',
        },
        provider: { type: 'string', description: '指定视觉模型 provider；省略则自动选择可用的视觉模型。' },
        model: { type: 'string', description: '指定视觉模型 id；省略则自动选择。' },
        showImage: {
          type: 'boolean',
          description: '是否在结果卡片中附带原图缩略（默认 false）。',
        },
        cacheTtlDays: { type: 'number', description: '本次结果的缓存有效期（天），覆盖插件默认值。' },
        saveIndexLabel: {
          type: 'string',
          description: '给这条结果打一个标签，便于以后用 image_similarity 按标签辨认。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      // 契约（app.asar: ToolOutputDefinition）：output.render(args, value) 必须返回 ContentBlock[]。
      // 宿主拿到数组后自己包成卡片；presentResult 才是返回 ToolResultView 的那个钩子。
      // 早期版本在这里返回了 {card,content}，宿主投影时校验失败/渲染空白，属于必须避免的静默失效。
      render: (args, value) => {
        const failed = value && typeof value === 'object' && value.isError === true;
        const blocks = failed
          ? resultContent(args, { isError: true, value, meta: value.meta })
          : resultContent(args, { value, isError: false });
        if (args?.showImage) {
          const ref = value?.results?.[0]?.imageRef;
          if (ref && typeof ref === 'object' && ref.attachmentId) blocks.push({ type: 'image', attachment: ref });
        }
        return blocks;
      },
      presentationMeta: (args, value) => presentationMeta(args, value),
    },
    presentCall: (args) => renderCall(args),
    presentResult: (args, result) => renderResult(args, result),
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      state.stats.calls += 1;
      const overall = stopwatch();
      try {
        // toJsonValue：宿主会对 value 做无损 JSON 快照 + schema 严格校验，undefined 字段必须消失。
        return toJsonValue(await runInsight({ args, exec, config, cache, llm, attachments, defaultModel, state }));
      } catch (error) {
        state.stats.failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const wrapped = new Error(message);
        wrapped.code = error?.code;
        wrapped.meta = { error: message, code: error?.code };
        throw wrapped;
      }
    },
  });

  // ------------------------------------------------------- 工具 2：以图搜图（纯本地）
  ctx.tools.register({
    name: 'image_similarity',
    description:
      '以图搜图：在本地指纹索引（image_insight 历史结果）中检索最相似的图片，基于 dHash/aHash 感知哈希的汉明距离。' +
      '纯本地计算、不出网、微秒级返回，因此可以放心在循环里调用。' +
      '用途：判断两张图是否同一张（不同压缩/尺寸）、找出历史里同一商品的图片、排除重复素材。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '查询图片的本地路径。' },
        attachmentId: { type: 'string', description: '查询图片的会话附件 ID。' },
        maxDistance: {
          type: 'number',
          description: 'dHash 汉明距离上限（0-64），越小越严格。默认 6；完全相同的图距离为 0。',
        },
        limit: { type: 'number', description: '返回条数上限，默认 5，最大 20。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: {
            type: 'object',
            properties: {
              dhash: { type: 'string' },
              ahash: { type: 'string' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          maxDistance: { type: 'number' },
          indexed: { type: 'number', description: '参与比对的索引条目数' },
          elapsedMs: { type: 'number' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                distance: { type: 'number' },
                aHashDistance: { type: 'number' },
                sameFile: { type: 'boolean', description: 'sha256 完全一致（同一份字节）' },
                label: { type: 'string' },
                path: { type: 'string' },
                summary: { type: 'string' },
                at: { type: 'number' },
              },
            },
          },
        },
        required: ['query', 'matches'],
      },
      render: (args, value) => {
        const lines = [`🧭 相似图检索（本地哈希，${value?.elapsedMs ?? 0}ms，索引 ${value?.indexed ?? 0} 条）`];
        if (!value?.matches?.length) lines.push('未找到相似图（阈值内无命中）。');
        for (const match of value?.matches ?? []) {
          lines.push(
            `  - d=${match.distance}${match.aHashDistance !== undefined ? ` a=${match.aHashDistance}` : ''}${match.sameFile ? ' 同源文件' : ''}｜${oneLine(match.label ?? match.path ?? match.key, 120)}`,
          );
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
      // presentationMeta 属于 ToolOutputDefinition（不是 ToolDefinition 顶层）。
      // 它是宿主唯一会持久化、并在重放时喂回 presentResult 的结构化字段；
      // 注意 presentResult 收到的是 ToolResult（{content,isError,meta}），没有 value 字段，
      // 所以命中数只能从这里读，不能读 result.value（那样会永远显示“未命中”）。
      presentationMeta: (args, value) =>
        toJsonValue({
          matchCount: value?.matches?.length ?? 0,
          indexed: value?.indexed,
          elapsedMs: value?.elapsedMs,
        }),
    },
    presentCall: (args) => ({ card: 'generic', title: '相似图检索', kind: 'search', rawInput: args }),
    presentResult: (args, result) => {
      if (result?.isError) return { card: 'generic', title: '相似图检索（失败）', content: resultContent(args, result) };
      const count = typeof result?.meta?.matchCount === 'number' ? result.meta.matchCount : 0;
      return { card: 'generic', title: '相似图检索', content: [{ type: 'text', text: count > 0 ? `命中 ${count} 张相似图` : '未命中相似图' }] };
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const watch = stopwatch();
      const image = await loadImageInput(args, attachments);
      const local = await analyzeLocal(image.data, image.data);
      const store = cache();
      await store.init();
      const target = BigInt(`0x${local.fingerprints.dhash}`);
      const targetA = BigInt(`0x${local.fingerprints.ahash}`);
      const limit = clampInt(args.limit, 1, 20, 5);
      const maxDistance = clampInt(args.maxDistance, 0, 64, config.nearDuplicateDistance);
      const matches = [];
      // 只用内存索引比对：索引条目里已带 dhash/ahash/sha256，无需为每条打开一次文件。
      for (const [key, entry] of store.entries()) {
        if (!entry.dhash) continue;
        const distance = hammingDistance64(target, BigInt(`0x${entry.dhash}`));
        if (distance > maxDistance) continue;
        const aHashDistance = entry.ahash ? hammingDistance64(targetA, BigInt(`0x${entry.ahash}`)) : undefined;
        matches.push({
          key,
          distance,
          aHashDistance,
          sameFile: Boolean(entry.sha256 && local.sha256 && entry.sha256 === local.sha256),
          label: entry.label,
          summary: entry.summary,
          at: entry.at,
        });
      }
      matches.sort((a, b) => a.distance - b.distance || (a.aHashDistance ?? 0) - (b.aHashDistance ?? 0));
      return toJsonValue({
        query: {
          dhash: local.fingerprints.dhash,
          ahash: local.fingerprints.ahash,
          width: local.width,
          height: local.height,
        },
        maxDistance,
        indexed: store.index.size,
        elapsedMs: watch.elapsed(),
        matches: matches.slice(0, limit),
      });
    },
  });

  // ------------------------------------------------------------ 工具 3：缓存维护
  ctx.tools.register({
    name: 'image_insight_cache',
    description:
      '图像洞察插件的本地缓存维护：stats 查看条目数/命中率/占用体积，gc 清理过期与孤立条目，clear 清空全部缓存。' +
      '缓存是「重复图片毫秒返回」的来源，体积异常变大或怀疑结果陈旧时用它处理。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stats', 'gc', 'clear'],
          description: '维护动作，默认 stats。',
        },
        ttlDays: { type: 'number', description: 'gc 时使用的有效期天数，覆盖插件默认值。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          dir: { type: 'string' },
          entries: { type: 'number' },
          hashes: { type: 'number' },
          hits: {
            type: 'object',
            properties: {
              exact: { type: 'number' },
              near: { type: 'number' },
              miss: { type: 'number' },
            },
          },
          sizeBytes: { type: 'number' },
          removedEntries: { type: 'number' },
          removedFiles: { type: 'number' },
          callStats: {
            type: 'object',
            properties: {
              calls: { type: 'number' },
              cloudCalls: { type: 'number' },
              cacheHits: { type: 'number' },
              failures: { type: 'number' },
            },
          },
        },
        required: ['action', 'dir'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text: [
            `目录 ${value?.dir}`,
            `条目 ${value?.entries ?? 0} · 指纹 ${value?.hashes ?? 0} · 占用 ${formatBytes(value?.sizeBytes ?? 0)}`,
            `命中 精确 ${value?.hits?.exact ?? 0} / 近似 ${value?.hits?.near ?? 0} / 未命中 ${value?.hits?.miss ?? 0}`,
            `调用 ${value?.callStats?.calls ?? 0}（云端 ${value?.callStats?.cloudCalls ?? 0}，失败 ${value?.callStats?.failures ?? 0}）`,
            value?.removedEntries !== undefined ? `本次清理：条目 ${value.removedEntries}，孤立文件 ${value.removedFiles ?? 0}` : undefined,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    },
    timeoutMs: 120000,
    presentResult: (args, result) => renderResult(args, result),
    async execute(args) {
      const store = cache();
      await store.init();
      const action = typeof args?.action === 'string' ? args.action : 'stats';
      const report = { action, dir: config.cacheDir, callStats: { ...state.stats } };
      if (action === 'gc' || action === 'clear') {
        const ttlDays = action === 'clear' ? 0 : args?.ttlDays;
        const result = await garbageCollect(store, ttlDays === undefined ? {} : { ttlDays });
        report.removedEntries = result.removedEntries;
        report.removedFiles = result.removedFiles;
      }
      const store2 = cache();
      report.entries = store2.index.size;
      report.hashes = store2.hashIndex.size;
      report.hits = { ...store2.hits };
      report.sizeBytes = await cacheSize(store2);
      return toJsonValue(report);
    },
  });
}

// ------------------------------------------------------------------ 主流程实现

async function runInsight({ args, exec, config, cache, llm, attachments, defaultModel, state }) {
  const watch = stopwatch();
  const mode = resolveMode(args?.mode);
  const preset = TASK_PRESETS[mode];

  // 1) 收集并加载输入图片（本地路径或会话附件），顺带做内容去重。
  const inputs = collectInputs(args);
  if (inputs.length === 0) {
    const error = new Error('必须提供 path、paths 或 attachmentId 之一');
    error.code = 'IMAGE_INSIGHT_NO_INPUT';
    throw error;
  }

  const localWatch = stopwatch();
  const loaded = [];
  for (const input of inputs) {
    try {
      const image = await loadImageInput(input, attachments);
      loaded.push({ input, ...image, error: undefined });
    } catch (error) {
      loaded.push({
        input,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2) 本地感知（并行）。这是速度与准确度的共同基座：先得到客观量与指纹。
  const analyses = await mapWithLimit(loaded, config.maxConcurrency, async (item) => {
    if (item.error) return { ...item, local: undefined };
    const local = await analyzeLocal(item.data, item.data);
    return { ...item, local };
  });

  // 3) 内容去重：字节完全相同的图片只算一次（批量里很常见）。
  const seen = new Map();
  for (const [index, item] of analyses.entries()) {
    if (!item.local?.sha256) continue;
    const previous = seen.get(item.local.sha256);
    if (previous !== undefined) {
      item.duplicateOfIndex = previous;
      analyses[previous].alsoAt = [...(analyses[previous].alsoAt ?? []), index];
    } else {
      seen.set(item.local.sha256, index);
    }
  }

  const localMs = localWatch.elapsed();
  const cloudWatch = { started: Date.now(), total: 0 };
  const store = cache();
  await store.init();

  // 4) 决定视觉模型路由（只在需要出网时才解析，local 模式零解析开销）。
  //    取不到视觉模型时**不直接失败**：降级为本地感知 + 明确告知，让插件在任何部署下都有用。
  let route;
  let routeError;
  let visionEnabled = preset.cloud;
  const sessionModel = currentModelOf(exec, defaultModel);
  if (preset.cloud) {
    const llmService = llm();
    if (!llmService) {
      routeError = new Error(
        '本部署没有可用的 llm 服务，无法进行云端语义识别；已降级为本地感知。请确认 llm 相关插件已启用。',
      );
    } else {
      try {
        route = await resolveVisionRoute(llmService, {
          provider: args?.provider,
          model: args?.model,
          configProvider: config.provider,
          configModel: config.model,
          current: sessionModel,
        });
      } catch (error) {
        routeError = error;
      }
    }
    if (routeError) {
      visionEnabled = false;
      route = undefined;
    }
  }
  const cloudRequired = (item) =>
    visionEnabled && !(item?.local?.quality?.verdict === 'unusable' && !args?.question && !args?.extraInstruction);

  // 5) 逐图：缓存 → 云端。命中缓存绝不出网，这是“迅速”的主来源。
  const requestFingerprint = stableStringify({
    mode,
    instruction: args?.extraInstruction ?? null,
    question: args?.question ?? null,
    route: route ? `${route.provider}/${route.model}` : 'local',
    schemaVersion: 1,
  });

  const results = await mapWithLimit(analyses, config.maxConcurrency, async (item, index) => {
    const base = {
      source: item.input.path ?? item.input.label ?? item.input.attachmentId ?? `image-${index + 1}`,
      local: item.local,
    };
    if (item.error) return { ...base, error: item.error };
    if (item.duplicateOfIndex !== undefined) {
      return { ...base, skipped: `与该批次第 ${item.duplicateOfIndex + 1} 张图片字节完全相同` };
    }
    if (!preset.cloud) return { ...base, insight: undefined };

    // 质量太差的图直接给出本地结论，不浪费一次云端调用（也是“准确”的一部分）。
    if (item.local.quality.verdict === 'unusable' && !args?.question && !args?.extraInstruction) {
      return {
        ...base,
        notice: `图片质量评分 ${item.local.quality.score}（${item.local.quality.verdict}）：${item.local.quality.notes.join('；')}。已跳过云端识别以避免臆造内容。`,
      };
    }

    // 没有可用视觉模型：保留全部本地结论并说明原因，而不是让整个工具调用失败。
    if (!cloudRequired(item)) {
      return { ...base, notice: routeError?.message ?? '未启用云端识别' };
    }

    const key = exactKey(item.data, requestFingerprint);
    const ttlOverride = typeof args?.cacheTtlDays === 'number' ? args.cacheTtlDays : undefined;
    if (!args?.refresh) {
      const exact = await store.getExact(key);
      if (exact && !isStale(exact, ttlOverride ?? config.cacheTtlDays)) {
        state.stats.cacheHits += 1;
        return { ...exact.results?.[0], source: base.source, cache: { hit: true, kind: 'exact', key } };
      }
      const near = await store.getNear(item.local.fingerprints.dhash, config.nearDuplicateDistance);
      if (near && !isStale(near.payload, ttlOverride ?? config.cacheTtlDays)) {
        state.stats.cacheHits += 1;
        const cached = near.payload.results?.[0];
        if (cached && cached.insight) {
          return {
            ...cached,
            source: base.source,
            local: base.local,
            cache: { hit: true, kind: 'near', key: near.key, distance: near.distance },
            notice: `感知哈希近似命中（dHash 距离 ${near.distance}）：复用历史结论，图片并非字节相同，请结合本地质量数据判断。`,
          };
        }
      }
    }

    // 6) 送图 + 视觉识别。
    const visionWatch = stopwatch();
    const prepared = await prepareForVision(item.data, { maxEdge: config.maxImageEdge });
    const attachmentRef = await saveImageToHost(attachments, prepared, item.input);
    const instruction = composeInstruction(args, preset, item.local);
    const recognized = await recognizeSafely({
      llm: llm(),
      provider: route.provider,
      model: route.model,
      imageRef: attachmentRef,
      analysis: item.local,
      tasks: preset.tasks,
      extraInstruction: instruction,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      timeoutMs: config.timeoutMs,
      signal: exec?.signal,
    }, route, sessionModel);
    state.stats.cloudCalls += 1;
    cloudWatch.total += visionWatch.elapsed();

    const result = {
      ...base,
      attachmentId: attachmentRef.attachmentId,
      imageRef: attachmentRef,
      prepared: {
        width: prepared.width,
        height: prepared.height,
        mediaType: prepared.mediaType,
        bytes: prepared.data.length,
        scaled: prepared.scaled,
        sourceWidth: prepared.sourceWidth,
        sourceHeight: prepared.sourceHeight,
        firstFrameOnly: prepared.firstFrameOnly,
      },
      insight: {
        jsonParsed: recognized.jsonParsed,
        parsed: recognized.parsed,
        raw: recognized.jsonParsed ? undefined : truncateRaw(recognized.raw),
        usage: recognized.usage,
        model: recognized.model,
        latencyMs: recognized.latencyMs,
      },
      cache: { hit: false, checked: true, key },
    };

    // 7) 写缓存（含供相似图检索使用的指纹）。
    try {
      const savedAt = Date.now();
      await store.put(
        key,
        {
          savedAt,
          ttlDays: ttlOverride ?? config.cacheTtlDays,
          model: recognized.model,
          results: [result],
        },
        {
          dhash: item.local.fingerprints.dhash,
          ahash: item.local.fingerprints.ahash,
          sha256: item.local.sha256,
          summary: recognized.parsed?.summary,
          bytes: item.local.bytes,
          costMs: recognized.latencyMs,
          label: args?.saveIndexLabel ?? base.source,
          savedAt,
        },
      );
    } catch {
      // 缓存写失败不影响本次结果。
    }
    return result;
  });

  // 8) 相似图判定：把本次第一张图放到索引里比一比（纯本地、纯内存，几乎不耗时）。
  let similar;
  const localItems = analyses.filter((item) => item.local);
  if (localItems.length === 1) {
    const firstLocal = localItems[0].local;
    const target = BigInt(`0x${firstLocal.fingerprints.dhash}`);
    const targetA = BigInt(`0x${firstLocal.fingerprints.ahash}`);
    const matches = [];
    for (const [key, entry] of store.entries()) {
      if (!entry.dhash) continue;
      const distance = hammingDistance64(target, BigInt(`0x${entry.dhash}`));
      if (distance > config.nearDuplicateDistance) continue;
      matches.push({
        key,
        distance,
        aHashDistance: entry.ahash ? hammingDistance64(targetA, BigInt(`0x${entry.ahash}`)) : undefined,
        label: entry.label,
        summary: entry.summary,
      });
    }
    matches.sort((a, b) => a.distance - b.distance);
    if (matches.length > 0) {
      similar = {
        query: { dhash: firstLocal.fingerprints.dhash, ahash: firstLocal.fingerprints.ahash },
        maxDistance: config.nearDuplicateDistance,
        matches: matches.slice(0, 10),
      };
    }
  }

  // 顶层 cache 是给卡片标题用的，必须把“哪一条结果、以哪种方式命中”带上来，
  // 否则标题只能显示 “缓存命中（undefined）”（真实踩到过的缺陷）。
  const cacheHit = results.find((item) => item.cache?.hit);
  // 顶层 model 也带上实际生效的思考档位：缓存命中的那次调用没有 insight.model，
  // 于是从缓存条目里取，保证“这次到底用了哪个档位”在卡片标题里始终可见（便于审计快慢）。
  const usedEffort = results.find((item) => item.insight?.model?.reasoningEffort !== undefined)?.insight?.model?.reasoningEffort;

  const value = {
    ok: results.every((item) => !item.error),
    mode,
    model: route
      ? {
          provider: route.provider,
          model: route.model,
          source: route.source,
          ...(usedEffort === undefined ? {} : { reasoningEffort: usedEffort }),
        }
      : visionEnabled
        ? { provider: 'local-only', model: 'local-only', source: 'none' }
        : { provider: 'none', model: 'none', source: 'unavailable' },
    timing: {
      totalMs: watch.elapsed(),
      localMs,
      cloudMs: cloudWatch.total,
    },
    cache: {
      checked: visionEnabled,
      hit: cacheHit !== undefined,
      ...(cacheHit?.cache?.kind === undefined ? {} : { kind: cacheHit.cache.kind }),
      ...(typeof cacheHit?.cache?.distance === 'number' ? { distance: cacheHit.cache.distance } : {}),
      ...(typeof cacheHit?.cache?.key === 'string' ? { key: cacheHit.cache.key } : {}),
      dir: config.cacheDir,
      entries: store.index.size,
    },
    results,
    similar,
    stats: { ...state.stats },
  };

  const notices = [...new Set(results.map((item) => item.notice).filter(Boolean))];
  if (!preset.cloud) {
    value.notice =
      'mode=local：仅做本地感知与指纹计算，未调用任何模型，因此没有语义描述/OCR/坐标/属性字段。需要这些字段请改用 mode="full"。';
  } else if (!visionEnabled) {
    value.notice = `已降级为本地感知（图片的尺寸/指纹/曝光/清晰度/主色/布局仍然有效，语义描述与 OCR 不可用）。原因：${routeError?.message ?? '未找到可用视觉模型'}`;
  } else if (notices.length > 0) {
    value.notice = notices.join(' | ');
  }
  return value;
}

// ------------------------------------------------------------------ 输入与辅助

function normalizeConfig(raw, ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const cacheDir = typeof raw.cacheDir === 'string' && raw.cacheDir.trim() !== ''
    ? (isAbsolute(raw.cacheDir) ? raw.cacheDir : resolve(raw.cacheDir))
    : join(home, 'image-insight-cache');
  return {
    ...DEFAULTS,
    ...(raw && typeof raw === 'object' ? raw : {}),
    cacheDir,
    cacheTtlDays: clampInt(raw?.cacheTtlDays, 0, 3650, DEFAULTS.cacheTtlDays),
    cacheMaxEntries: clampInt(raw?.cacheMaxEntries, 16, 100000, DEFAULTS.cacheMaxEntries),
    maxImageEdge: clampInt(raw?.maxImageEdge, 256, 8192, DEFAULTS.maxImageEdge),
    maxConcurrency: clampInt(raw?.maxConcurrency, 1, 16, DEFAULTS.maxConcurrency),
    timeoutMs: clampInt(raw?.timeoutMs, 1000, 600000, DEFAULTS.timeoutMs),
    temperature: typeof raw?.temperature === 'number' ? Math.max(0, Math.min(2, raw.temperature)) : DEFAULTS.temperature,
    maxTokens: clampInt(raw?.maxTokens, 256, 32000, DEFAULTS.maxTokens),
    reasoningEffort:
      typeof raw?.reasoningEffort === 'string' && raw.reasoningEffort.trim() !== ''
        ? raw.reasoningEffort.trim()
        : DEFAULTS.reasoningEffort,
    nearDuplicateDistance: clampInt(raw?.nearDuplicateDistance, 0, 20, DEFAULTS.nearDuplicateDistance),
    provider: typeof raw?.provider === 'string' && raw.provider.trim() !== '' ? raw.provider.trim() : undefined,
    model: typeof raw?.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : undefined,
  };
}

function resolveMode(mode) {
  if (typeof mode !== 'string' || mode.trim() === '') return 'full';
  const key = mode.trim().toLowerCase();
  if (TASK_PRESETS[key]) return key;
  const alias = MODE_ALIASES[key];
  if (alias) return alias;
  return 'full';
}

/** 收集输入：path / paths / attachmentId，去重且保序。 */
function collectInputs(args) {
  const inputs = [];
  if (typeof args?.path === 'string' && args.path.trim() !== '') inputs.push({ path: args.path.trim() });
  if (Array.isArray(args?.paths)) {
    for (const item of args.paths) {
      if (typeof item === 'string' && item.trim() !== '') inputs.push({ path: item.trim() });
    }
  }
  if (typeof args?.attachmentId === 'string' && args.attachmentId.trim() !== '') {
    inputs.push({ attachmentId: args.attachmentId.trim() });
  }
  const unique = [];
  const seen = new Set();
  for (const input of inputs) {
    const key = input.path ?? input.attachmentId;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(input);
  }
  return unique;
}

/**
 * 载入一张图的字节。
 * 路径走宿主文件系统；attachmentId 走 attachments 服务并在必要时回落到 host 文件路径。
 */
async function loadImageInput(input, attachmentsRef) {
  if (input.attachmentId) {
    const service = attachmentsRef();
    if (!service) {
      throw new Error('本部署没有可用的 attachments 服务，无法读取会话图片；请改用 path 传入本地文件路径。');
    }
    const ref = { attachmentId: input.attachmentId };
    const stored = await service.readImage(ref);
    return {
      data: Buffer.from(stored.data),
      label: stored.ref?.name ?? input.attachmentId,
      attachmentId: input.attachmentId,
      ref: stored.ref,
    };
  }
  const path = resolvePath(input.path);
  const data = await readImageFile(path);
  if (!data || data.length === 0) throw new Error(`图片文件为空：${path}`);
  return { data, path, label: path };
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/** 落盘到宿主 attachments 服务，拿到可用于 ImageBlock 的引用。 */
async function saveImageToHost(attachmentsRef, prepared, input) {
  const service = attachmentsRef();
  if (!service) {
    throw new Error('本部署没有可用的 attachments 服务，无法把图片送入模型；请确认 attachment 相关插件已启用。');
  }
  const name = input.path ? input.path.split(/[\\/]/).pop() : input.label;
  const ref = await service.saveImage({ data: prepared.data, mediaType: prepared.mediaType, name });
  return ref;
}

function composeInstruction(args, preset, local) {
  const parts = [];
  if (args?.extraInstruction) parts.push(String(args.extraInstruction));
  if (args?.question) parts.push(`请额外回答这个具体问题：${String(args.question)}`);
  if (local?.quality?.verdict && local.quality.verdict !== 'good') {
    parts.push(`注意：本地检测显示该图${local.quality.notes.join('；')}，请对把握不足的内容明确标注到 uncertainty。`);
  }
  if (local?.layout?.likelyKind === 'ui-or-document') {
    parts.push('该图疑似界面截图或文档扫描件：请优先保证文字与布局的准确性，objects 里可忽略纯装饰元素。');
  }
  if (preset.tasks.length === 0) parts.push('本次只需给出客观描述与文字，不需要定位坐标。');
  return parts.join(' ');
}

/**
 * 尽力取到「当前会话真正会用的模型」；取不到就返回 undefined（不影响自动选择）。
 * 顺序：
 *   1. 工具执行上下文（宿主若在 exec.agent 上暴露 model）
 *   2. 宿主 agentDefaultModel.currentSelection() —— 新 agent 实际使用的 {provider, model, reasoningEffort?}
 * 第 2 条很关键：provider 必须是**本机可认证的路由**（如 OAuth 的 deepseek-account），
 * 而不是模型目录里的 provider id（如 deepseek-official，需要 API key）。
 */
function currentModelOf(exec, defaultModelService) {
  try {
    const candidate = exec?.agent?.model ?? exec?.model;
    if (candidate && typeof candidate.provider === 'string' && typeof candidate.model === 'string') return candidate;
    if (candidate && typeof candidate.providerId === 'string' && typeof candidate.modelId === 'string') {
      return { provider: candidate.providerId, model: candidate.modelId };
    }
  } catch {
    // 宿主未暴露该信息：继续找默认模型服务。
  }
  try {
    const selection = defaultModelService?.()?.currentSelection?.();
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model, source: 'agent-default' };
    }
  } catch {
    // 服务不可用（不是所有部署都装了 agent-default-model）：不猜，交给自动选择。
  }
  return undefined;
}

function isStale(payload, ttlDays) {
  if (!ttlDays || ttlDays <= 0) return false;
  const savedAt = payload?.savedAt;
  if (typeof savedAt !== 'number') return false;
  return Date.now() - savedAt > ttlDays * 24 * 60 * 60 * 1000;
}

function truncateRaw(text) {
  const flat = typeof text === 'string' ? text : String(text ?? '');
  return flat.length > 20000 ? `${flat.slice(0, 20000)}\n…（原文过长已截断）` : flat;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 云端调用失败时，若错误像「这条路由没有凭据」，补一句可执行的指引。
 * 为什么需要：自动挑选路由只能是「模型目录里第一个声明了图像输入的模型」，而目录里的 provider id
 * （如 deepseek-official）可能与本机已登录的路由（如 OAuth 的 deepseek-account）不是同一条；
 * 后者才是当前会话真正能认证成功的路由。宿主原始报错只说没有 API key，用户不知道还能怎么改。
 */
async function recognizeSafely(options, route, sessionModel) {
  try {
    return await recognizeVision(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const credentialLike = /no API key|MISSING_CREDENTIAL|unauthoriz|invalid api key|401/i.test(message);
    if (!credentialLike || route?.source !== 'auto-vision-catalog') throw error;
    const hint = sessionModel
      ? `本次使用的是自动挑选的路由 ${route.provider}/${route.model}，它没有可用凭据。` +
        `请显式指定一条本机已配置凭据的路由：把 provider/model 参数传给工具，或写进插件配置。` +
        `（当前会话模型为 ${sessionModel.provider}/${sessionModel.model}，可作为 provider 的候选。）`
      : `本次使用的是自动挑选的路由 ${route.provider}/${route.model}，它没有可用凭据；` +
        `请用 provider/model 参数（或插件配置）指定一条已配置凭据的路由。`;
    const wrapped = new Error(`${message}\n${hint}`);
    wrapped.code = error?.code;
    throw wrapped;
  }
}

/** 有限并发（保留结果顺序），失败以占位对象返回而不中断整批。 */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(items.length || 1, limit));
  await Promise.all(
    new Array(width).fill(null).map(async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index], index);
        } catch (error) {
          results[index] = {
            source: items[index]?.input?.path ?? items[index]?.input?.attachmentId ?? `image-${index + 1}`,
            local: items[index]?.local,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }),
  );
  return results;
}

export default { name, inject, apply };

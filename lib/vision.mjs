/**
 * dsh-image-insight —— Layer-3 云端视觉（宿主 llm 服务）
 *
 * 只用宿主已装的 llm 服务，不引入任何外部 API key、不新增网络依赖：
 * 插件通过 ctx.get('llm') / ctx.llm 调用当前 profile 里已配置的视觉模型。
 *
 * 三条为“准确 + 迅速”服务的硬约束：
 *  1. 调用前 prepareCall() 检查 inputModalities 含 'image'，不支持就换模型或明确报错，
 *     绝不把图发给纯文本模型（那会得到臆造的描述，是最严重的“不准”）。
 *  2. 模型输出必须收敛成结构化 JSON：系统提示词给出严格 schema，解析走多层兜底，
 *     解析失败时保留原文并标注 jsonParsed=false，让调用方知道降级了。
 *  3. temperature 默认 0：识别是抽取任务，不是创作任务，低温显著减少幻觉字段。
 */

import { parseJsonLoose, withTimeout } from './util.mjs';

/**
 * 严格的结构化输出契约。字段名同时出现在提示词、JSON 解析结果和输出 schema 里，
 * 三者必须一致——任何漂移都会让“识别准确”变成“字段对不上”。
 */
export const VISION_SCHEMA = {
  summary: '一句话总体结论（不超过 40 字）',
  description: '2-6 句的客观详细描述：主体、场景、动作、氛围；不臆测图中不存在的信息',
  objects: [
    {
      name: '物体名称（中文）',
      confidence: '0-1',
      bbox: '[x%, y%, w%, h%] 相对整图百分比，左上为原点；无法定位则 null',
      attributes: '该物体的细粒度属性：颜色/数量/款式/品牌/型号/材质/状态等，键值对',
    },
  ],
  text: {
    hasText: 'boolean',
    fullText: '按阅读顺序拼接的完整文字，保留换行用 \\n；无文字则为空串',
    blocks: [{ content: '文字内容', type: 'title|paragraph|button|label|code|table|other', confidence: '0-1', bbox: '[x%,y%,w%,h%] 或 null' }],
  },
  attributes: { 品牌: '', 型号: '', 颜色: '', 数量: '', 风格: '', 材质: '', 场景: '', 其他: '' },
  composition: '画面构图与视觉焦点（如“主体居中，三分法，背景虚化”）',
  imageType: 'photo|screenshot|document|chart|diagram|poster|meme|product|other 之一',
  uncertainty: ['你不确定或看不清的点，逐条列出；没有则空数组'],
};

const SYSTEM_PROMPT = `你是严谨的图像识别引擎，输出会被程序直接解析使用。

要求：
1. 只输出一个 JSON 对象，不要 markdown 围栏，不要任何解释性前后缀。
2. 严格按给定结构输出，不要新增或改名顶层字段；未知内容用 null 或空数组，绝不编造。
3. 坐标一律用相对整图百分比 [x, y, w, h]（左上角为原点），范围 0-100，保留一位小数。
4. 文字识别：逐字准确转写，保留原有大小写、数字、标点、换行。看不清的字符用"?"占位，
   并在 uncertainty 里说明。识别不到的字段填 null，不要猜测内容。
5. objects 只列出你确实看到的物体；confidence 反映真实把握，低于 0.4 的不要列出。
6. 全部文字使用简体中文（专有名词、代码、品牌名保留原文）。`;

/** 按识别重点裁剪提示词：全选时给完整 schema，单项时只强调相关字段以降延迟。 */
function buildUserPrompt(analysis, tasks, extraInstruction) {
  const lines = [];
  lines.push('请识别这张图片。');
  if (tasks.length > 0) lines.push(`本次重点：${tasks.join('、')}。`);
  lines.push(`本地预处理测得的客观数据（可交叉印证，也可与你的判断冲突）：`);
  lines.push(`- 尺寸：${analysis.width}×${analysis.height}，比例 ${analysis.aspectRatio ?? '未知'}`);
  lines.push(`- 清晰度：拉普拉斯方差 ${analysis.sharpness.laplacianVariance}（${analysis.sharpness.verdict}）`);
  lines.push(`- 曝光：均值 ${analysis.tone.mean}/255，标准差 ${analysis.tone.stdDev}，过曝 ${analysis.tone.clippedHighPct}%，欠曝 ${analysis.tone.clippedLowPct}%`);
  lines.push(`- 主色：${analysis.colors.dominant.map((item) => `${item.hex}(${item.sharePct}%)`).join('、') || '未知'}`);
  lines.push(`- 类型预判：${analysis.layout.likelyKind}，边缘密度 ${analysis.layout.edgeDensityPct}%`);
  lines.push(`- 本地连通域候选区域数：${analysis.layout.candidateRegions}（仅供参考，不是物体数）`);
  lines.push('');
  lines.push(`输出 JSON 结构（字段含义）：\n${JSON.stringify(VISION_SCHEMA, null, 1)}`);
  if (extraInstruction) {
    lines.push('');
    lines.push(`补充要求：${extraInstruction}`);
  }
  return lines.join('\n');
}

/**
 * 把 llm.stream() 的 chunk 流收敛成 { text, reasoning, usage, finish }。
 * 只关心 text-delta 与 block-end 的文本块；图像/工具块在识别场景下不产生。
 */
export async function collectStream(stream) {
  let text = '';
  let reasoning = '';
  let usage;
  let finish;
  let failure;
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish') {
      finish = chunk.reason;
      if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        failure = chunk.reason.failure;
      }
    }
  }
  return { text, reasoning, usage, finish, failure };
}

/**
 * 解析模型回复为结构化结果。
 * @returns {{ parsed?: object, raw: string, jsonParsed: boolean }}
 */
export function parseVisionOutput(raw) {
  const value = parseJsonLoose(raw);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { parsed: normalizeVisionResult(value), raw, jsonParsed: true };
  }
  return { raw, jsonParsed: false };
}

/** 归一化模型输出：补齐缺失字段、夹取置信度、清洗坐标，让下游永远拿到同一形状。 */
export function normalizeVisionResult(value) {
  const asString = (input) => (typeof input === 'string' ? input : input === undefined || input === null ? '' : String(input));
  const asNumber = (input) => {
    const num = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(num) ? num : undefined;
  };
  const cleanBbox = (input) => {
    if (!Array.isArray(input) || input.length < 4) return null;
    const numbers = input.slice(0, 4).map((item) => asNumber(item));
    if (numbers.some((item) => item === undefined)) return null;
    return numbers.map((item) => Math.max(0, Math.min(100, Number(item.toFixed(1)))));
  };
  const objects = Array.isArray(value.objects)
    ? value.objects
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          name: asString(item.name),
          confidence: clamp01(asNumber(item.confidence)),
          bbox: cleanBbox(item.bbox),
          attributes: item.attributes && typeof item.attributes === 'object' ? item.attributes : undefined,
        }))
        .filter((item) => item.name.length > 0)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 40)
    : [];
  const textInput = value.text && typeof value.text === 'object' ? value.text : {};
  const blocks = Array.isArray(textInput.blocks)
    ? textInput.blocks
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          content: asString(item.content),
          type: asString(item.type) || 'other',
          confidence: clamp01(asNumber(item.confidence)),
          bbox: cleanBbox(item.bbox),
        }))
        .filter((item) => item.content.length > 0)
        .slice(0, 200)
    : [];
  return {
    summary: asString(value.summary),
    description: asString(value.description),
    objects,
    text: {
      hasText: typeof textInput.hasText === 'boolean' ? textInput.hasText : blocks.length > 0,
      fullText: asString(textInput.fullText),
      blocks,
    },
    attributes: value.attributes && typeof value.attributes === 'object' ? value.attributes : {},
    composition: asString(value.composition),
    imageType: asString(value.imageType) || 'other',
    uncertainty: Array.isArray(value.uncertainty) ? value.uncertainty.map(asString).filter(Boolean).slice(0, 12) : [],
  };
}

function clamp01(value) {
  if (value === undefined) return undefined;
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

/** 只在明确的“低档”名字里挑才安全；模型只声明一个档位时也可以直接用。 */
const FAST_EFFORT_PATTERN = /^(none|off|minimal|minimal_effort|low|fast|instant)$/i;

/** 询问模型能力，挑一个“最快”的思考档；拿不准就返回 undefined（交给模型默认值）。 */
async function pickFastEffort(llm, provider, model) {
  if (typeof llm?.resolveModelInfo !== 'function') return undefined;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    const efforts = info?.reasoning?.efforts;
    if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
    const ids = efforts
      .map((item) => (typeof item === 'string' ? item : item?.id))
      .filter((id) => typeof id === 'string' && id.length > 0);
    const known = ids.find((id) => FAST_EFFORT_PATTERN.test(id));
    if (known !== undefined) return known;
    return ids.length === 1 ? ids[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析本次请求的思考档：
 *   'auto'（默认）→ 挑模型最快档；'default' 或空串 → 不指定（用模型默认）；其他字符串 → 原样透传。
 */
async function resolveReasoningEffort(llm, provider, model, requested) {
  if (typeof requested === 'string' && requested.trim() !== '' && requested.trim() !== 'auto') {
    const value = requested.trim();
    return value === 'default' ? undefined : value;
  }
  return pickFastEffort(llm, provider, model);
}

/**
 * 只取宿主 callConfigEquals() 会比对的那几个字段
 * （provider / model / reasoningEffort / temperature / maxTokens / stop）。
 */
function callConfigFields(source, fallback) {
  const effort = source?.reasoningEffort ?? fallback.reasoningEffort;
  const stop = source?.stop ?? fallback.stop;
  return {
    provider: source?.provider ?? fallback.provider,
    model: source?.model ?? fallback.model,
    temperature: source?.temperature ?? fallback.temperature,
    maxTokens: source?.maxTokens ?? fallback.maxTokens,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(stop === undefined ? {} : { stop }),
  };
}

/**
 * 走宿主 llm 服务完成一次视觉识别。
 *
 * @param {object} params
 * @param {object} params.llm           宿主 llm 服务（ctx.get('llm') 或 ctx.llm）
 * @param {string} params.provider
 * @param {string} params.model
 * @param {{ attachmentId: string, mediaType: string, bytes: number, width: number, height: number, name?: string }} params.imageRef
 * @param {object} params.analysis      本地分析结果
 * @param {string[]} params.tasks
 * @param {string} [params.extraInstruction]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {string} [params.reasoningEffort] 'auto'（默认，挑模型最快档）| 'default' | 具体档位
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<object>}
 */
export async function recognizeVision(params) {
  const {
    llm,
    provider,
    model,
    imageRef,
    analysis,
    tasks = [],
    extraInstruction,
    temperature = 0,
    maxTokens = 3000,
    reasoningEffort,
    timeoutMs = 60000,
    signal,
  } = params;

  // 速度优先：识别是感知任务，不指定时优先挑模型声明里最低的思考档，避免默认高档拖慢响应。
  const effort = await resolveReasoningEffort(llm, provider, model, reasoningEffort);

  // 关键契约（宿主 dsh-llm prepareCall 源码）：prepared.stream(options) 在派发前会执行
  // callConfigEquals(options, resolvedConfig)，只比对 provider / model / reasoningEffort /
  // temperature / maxTokens / stop；而 prepareCall 会 materialize 适配器默认值
  // （例如模型默认 reasoningEffort=high）。任何一处不一致，宿主就抛
  // “prepared LLM call config changed before adapter dispatch”并拒绝派发，
  // 所以必须把 prepared.config 的这几个字段原样带进 options。
  const baseConfig = { provider, model, temperature, maxTokens };
  if (effort !== undefined) baseConfig.reasoningEffort = effort;

  let prepared;
  let preparedOk = false;
  if (typeof llm.prepareCall === 'function') {
    try {
      prepared = await llm.prepareCall(baseConfig, signal);
    } catch (error) {
      // 我们挑的思考档不被该模型接受：退回模型默认档重新准备，别让整次识别失败。
      if (effort !== undefined && error?.code === 'UNSUPPORTED_REASONING_EFFORT') {
        delete baseConfig.reasoningEffort;
        prepared = await llm.prepareCall(baseConfig, signal);
      } else {
        throw error;
      }
    }
    const modalities = prepared?.inputModalities;
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      const error = new Error(
        `模型 ${provider}/${model} 未声明图片输入能力（inputModalities=${JSON.stringify(modalities)}），无法用于图像识别`,
      );
      error.code = 'IMAGE_INSIGHT_MODEL_NOT_VISION';
      throw error;
    }
    preparedOk = true;
  }

  const options = {
    ...callConfigFields(preparedOk ? prepared?.config : baseConfig, baseConfig),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', attachment: imageRef },
          { type: 'text', text: buildUserPrompt(analysis, tasks, extraInstruction) },
        ],
      },
    ],
    system: SYSTEM_PROMPT,
    ...(signal === undefined ? {} : { signal }),
  };

  const started = Date.now();
  const streamPromise = preparedOk
    ? collectStream(prepared.stream(options))
    : collectStream(llm.stream(options));
  const collected = await withTimeout(streamPromise, timeoutMs, signal, `视觉模型 ${provider}/${model} 调用`);

  if (collected.failure) {
    const error = new Error(`视觉模型调用失败：${collected.failure.message}`);
    error.code = collected.failure.code ?? 'IMAGE_INSIGHT_LLM_FAILED';
    error.status = collected.failure.status;
    throw error;
  }

  const parsed = parseVisionOutput(collected.text);
  return {
    ...parsed,
    model: {
      provider,
      model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    },
    usage: collected.usage,
    finish: collected.finish,
    reasoningChars: collected.reasoning.length,
    latencyMs: Date.now() - started,
    inputModalities: Array.isArray(prepared?.inputModalities) ? prepared.inputModalities : undefined,
  };
}

/**
 * 解析要用的视觉模型路由。
 * 顺序：显式参数 → 插件配置 → 会话当前模型（若支持图像）→ 已注册模型里第一个支持图像的。
 * 每次都返回 route 与来源，让“用了哪个模型”写进工具输出里，可审计。
 */
export async function resolveVisionRoute(llm, options = {}) {
  const explicit = options.provider && options.model ? { provider: options.provider, model: options.model, source: 'explicit' } : undefined;
  const configured =
    options.configProvider && options.configModel
      ? { provider: options.configProvider, model: options.configModel, source: 'config' }
      : undefined;
  const candidates = [explicit, configured].filter(Boolean);

  const current = options.current;
  if (current && current.provider && current.model) {
    candidates.push({ provider: current.provider, model: current.model, source: current.source ?? 'current-session' });
  }

  for (const candidate of candidates) {
    try {
      const prepared = await llm.prepareCall({ provider: candidate.provider, model: candidate.model });
      const modalities = prepared?.inputModalities;
      if (!Array.isArray(modalities) || modalities.includes('image')) return candidate;
      candidate.rejected = `inputModalities=${JSON.stringify(modalities)} 不含 image`;
    } catch (error) {
      candidate.rejected = error instanceof Error ? error.message : String(error);
    }
  }

  // 兜底：遍历已注册 provider 的模型目录，挑一个声明了图像输入的。
  let providers = [];
  try {
    providers = llm.listProviders() ?? [];
  } catch {
    providers = [];
  }
  for (const providerInfo of providers) {
    let models = [];
    try {
      models = await llm.listModels(providerInfo.id);
    } catch {
      continue;
    }
    for (const modelInfo of models ?? []) {
      if (!Array.isArray(modelInfo?.inputModalities) || !modelInfo.inputModalities.includes('image')) continue;
      return {
        provider: providerInfo.id,
        model: modelInfo.id,
        source: 'auto-vision-catalog',
      };
    }
  }

  // 把“每个候选为什么被拒 + 目录里到底有哪些模型”都写进错误里，
  // 否则用户只会看到一句“找不到视觉模型”，无从下手。
  const details = candidates.map((item) => `${item.provider}/${item.model}: ${item.rejected ?? '不支持图像'}`).join('； ');
  const catalog = [];
  for (const providerInfo of providers) {
    try {
      const models = (await llm.listModels(providerInfo.id)) ?? [];
      const labelled = models
        .slice(0, 20)
        .map((model) => `${model.id}${Array.isArray(model.inputModalities) && model.inputModalities.includes('image') ? '(支持图片)' : '(纯文本)'}`);
      if (labelled.length > 0) catalog.push(`${providerInfo.id}: ${labelled.join(', ')}`);
    } catch {
      // 该 provider 无法列模型，忽略。
    }
  }
  const error = new Error(
    `找不到可用的视觉模型（图不会被发给纯文本模型，因此已降级为本地感知）。` +
      `候选拒绝原因：${details || '无可解析模型'}。` +
      (catalog.length > 0 ? `当前 provider 的模型目录：${catalog.join(' | ')}。` : '当前没有任何已注册 provider 能列出模型。') +
      `请在 settings 的模型选项中为某个模型勾选 Image 输入，或用 provider/model 参数指定一个支持图片的模型。`,
  );
  error.code = 'IMAGE_INSIGHT_NO_VISION_MODEL';
  throw error;
}

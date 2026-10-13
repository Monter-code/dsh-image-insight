/**
 * dsh-image-insight —— 呈现层
 *
 * 两条输出通道，各自服务不同读者：
 *  - execute() 返回的 value（结构化 JSON）给程序与调用方，字段稳定、可断言；
 *  - output.render() 返回的 ContentBlock 给模型与用户看的卡片，紧凑、可扫读、带耗时。
 *
 * 渲染必须足够吝啬：识别结果里的坐标与逐块 OCR 可能上百行，全量塞进上下文会
 * 反过来拖慢整轮对话，所以这里按预算截断，并明确写出“已截断 + 去哪里拿全量”。
 */

import { formatMs, oneLine, toJsonValue, truncate } from './util.mjs';

/** 卡片里最多展示的 OCR 文本块数与本文字符数。 */
const RENDER_LIMITS = { textBlocks: 40, textChars: 4000, objects: 25 };

/**
 * 两个不同的宿主钩子，返回值类型不同，绝不能混：
 *   - output.render(args, value) → ContentBlock[]（数组，宿主自己套卡片外壳）
 *   - presentResult(args, result) → ToolResultView（这里用 genericView 构造）
 * 依据是 app.asar 里的 ToolOutputDefinition / GenericResultView 接口，以及宿主对 render 结果的
 * 断言原文：“output.render returned … — it must return an ARRAY of content blocks”。
 * 曾经把 render 写成返回 view 对象，属“形状对了但类型错了”，会让卡片渲染失败而不报错——
 * 所以这里集中构造，不各处分头拼装。
 */
function genericView(title, content) {
  return { card: 'generic', title, content };
}

export function renderCall(args) {
  const mode = typeof args?.mode === 'string' ? args.mode : 'full';
  const source = typeof args?.path === 'string' ? oneLine(args.path, 120) : args?.attachmentId ? '会话内图片' : '图片';
  return {
    card: 'generic',
    title: `图像洞察 · ${mode}`,
    kind: 'read',
    locations: typeof args?.path === 'string' ? [{ path: args.path }] : undefined,
    rawInput: args,
  };
}

/** 结果卡片：presentResult 收到的是宿主 ToolResult（{content, isError, meta}，注意没有 value 字段）。 */
export function renderResult(args, result) {
  const title = result?.isError ? '图像洞察（失败）' : '图像洞察';
  // 真实宿主路径：content 就是 output.render 已经产出的块，直接用，别再渲染一遍。
  if (Array.isArray(result?.content) && result.content.length > 0) return genericView(title, result.content);
  return genericView(title, result?.isError ? renderError(result) : renderSuccess(result?.value));
}

/** 只取内容块，供 output.render 使用（宿主自行决定卡片外壳）。 */
export function resultContent(args, result) {
  return result?.isError ? renderError(result) : renderSuccess(result?.value);
}

/**
 * 给网页端卡片用的结构化元数据（宿主会持久化并在重放时读回）。
 * Web Client 不消费 presentResult，它从「原始参数 + 结果内容 + 失败状态 + 这份 metadata」派生卡片，
 * 所以这里只放稳定、紧凑、可读的字段。
 */
export function presentationMeta(args, value) {
  if (!value || typeof value !== 'object') return undefined;
  return toJsonValue({
    mode: value.mode,
    model: value.model,
    timing: value.timing,
    cache: value.cache,
    notice: value.notice,
    images: Array.isArray(value.results) ? value.results.length : undefined,
  });
}

function renderError(result) {
  const meta = result?.meta && typeof result.meta === 'object' ? result.meta : undefined;
  const message = oneLine(meta?.error ?? result?.value?.error ?? '图像洞察执行失败', 400);
  return [{ type: 'text', text: `❌ 图像洞察失败：${message}` }];
}

function renderSuccess(value) {
  if (!value || typeof value !== 'object') return [{ type: 'text', text: '（无结果）' }];
  const blocks = [];
  const timing = value.timing ?? {};
  const cache = value.cache ?? {};
  const header = [];
  if (value.mode) header.push(`模式 ${value.mode}`);
  if (value.model?.provider) {
    const effort = value.model.reasoningEffort ? `/${value.model.reasoningEffort}` : '';
    header.push(`${value.model.provider}/${value.model.model}${effort}`);
  }
  if (typeof timing.totalMs === 'number') header.push(`总计 ${formatMs(timing.totalMs)}`);
  if (typeof timing.localMs === 'number') header.push(`本地 ${formatMs(timing.localMs)}`);
  if (typeof timing.cloudMs === 'number') header.push(`云端 ${formatMs(timing.cloudMs)}`);
  if (cache.hit) header.push(`缓存命中（${cache.kind}${typeof cache.distance === 'number' ? ` d=${cache.distance}` : ''}）`);
  else if (cache.checked) header.push('缓存未命中');
  blocks.push({ type: 'text', text: `🔎 图像洞察｜${header.join(' · ')}` });

  if (value.notice) blocks.push({ type: 'text', text: `⚠️ ${oneLine(value.notice, 300)}` });

  const results = Array.isArray(value.results) ? value.results : [];
  for (const [index, item] of results.entries()) {
    if (results.length > 1) blocks.push({ type: 'text', text: `\n── 图 ${index + 1}/${results.length} ──` });
    blocks.push(...renderSingle(item));
  }
  if (value.similar && Array.isArray(value.similar.matches)) blocks.push(...renderSimilar(value.similar));
  return blocks;
}

function renderSingle(item) {
  if (!item || typeof item !== 'object') return [];
  const blocks = [];
  if (item.error) return [{ type: 'text', text: `❌ ${oneLine(item.source ?? '图片', 120)}：${oneLine(item.error, 400)}` }];

  const local = item.local;
  if (local) {
    const quality = local.quality ?? {};
    const line = [
      `${local.width}×${local.height}`,
      local.mediaType,
      local.bytes ? `${Math.round(local.bytes / 1024)}KB` : undefined,
      `质量 ${quality.score ?? '?'}（${quality.verdict ?? '?'}）`,
      `清晰度 ${local.sharpness?.laplacianVariance ?? '?'}`,
      local.colors?.dominant?.length ? `主色 ${local.colors.dominant.slice(0, 3).map((color) => color.hex).join('/')}` : undefined,
      local.layout?.likelyKind ? `类型预判 ${local.layout.likelyKind}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    blocks.push({ type: 'text', text: `📐 ${line}` });
    if (Array.isArray(quality.notes) && quality.notes.length > 0) {
      blocks.push({ type: 'text', text: `· ${quality.notes.join('；')}` });
    }
    if (local.fingerprints?.dhash) {
      blocks.push({ type: 'text', text: `· 指纹 dHash ${local.fingerprints.dhash} / aHash ${local.fingerprints.ahash}` });
    }
  }

  const insight = item.insight;
  if (insight?.jsonParsed === false) {
    blocks.push({ type: 'text', text: `⚠️ 模型未按 JSON 输出，以下为原文（jsonParsed=false）：` });
    blocks.push({ type: 'text', text: truncate(insight.raw ?? '', 1500) });
    return blocks;
  }
  const data = insight?.parsed;
  if (!data) {
    if (item.mode === 'local') return blocks;
    return blocks;
  }

  if (data.summary) blocks.push({ type: 'text', text: `📝 ${oneLine(data.summary, 200)}` });
  if (data.description) blocks.push({ type: 'text', text: truncate(data.description, 1200) });
  if (data.imageType && data.imageType !== 'other') blocks.push({ type: 'text', text: `· 判定类型 ${data.imageType}` });
  if (data.composition) blocks.push({ type: 'text', text: `· 构图 ${oneLine(data.composition, 200)}` });

  if (Array.isArray(data.objects) && data.objects.length > 0) {
    blocks.push({ type: 'text', text: `🎯 识别到 ${data.objects.length} 个物体：` });
    const lines = data.objects.slice(0, RENDER_LIMITS.objects).map((object) => {
      const confidence = typeof object.confidence === 'number' ? ` ${(object.confidence * 100).toFixed(0)}%` : '';
      const bbox = object.bbox ? ` @[${object.bbox.join(',')}]` : '';
      const attributes = object.attributes ? ` ${oneLine(JSON.stringify(object.attributes), 120)}` : '';
      return `  - ${object.name}${confidence}${bbox}${attributes}`;
    });
    if (data.objects.length > RENDER_LIMITS.objects) {
      lines.push(`  … 其余 ${data.objects.length - RENDER_LIMITS.objects} 个见结构化结果`);
    }
    blocks.push({ type: 'text', text: lines.join('\n') });
  }

  if (data.text) {
    if (data.text.hasText) {
      const fullText = data.text.fullText ?? '';
      const shown = truncate(fullText, RENDER_LIMITS.textChars);
      blocks.push({ type: 'text', text: `🔤 OCR（${data.text.blocks?.length ?? 0} 块，${fullText.length} 字）：\n${shown}` });
      const withBbox = (data.text.blocks ?? []).filter((block) => block.bbox);
      if (withBbox.length > 0) {
        const lines = withBbox
          .slice(0, RENDER_LIMITS.textBlocks)
          .map((block) => `  - [${block.bbox.join(',')}] ${oneLine(block.content, 80)}`);
        blocks.push({ type: 'text', text: `· 带坐标文本块（前 ${Math.min(withBbox.length, RENDER_LIMITS.textBlocks)} 个）：\n${lines.join('\n')}` });
      }
    } else {
      blocks.push({ type: 'text', text: '🔤 未检测到文字' });
    }
  }

  if (data.attributes && typeof data.attributes === 'object') {
    const entries = Object.entries(data.attributes).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
    if (entries.length > 0) {
      blocks.push({ type: 'text', text: `🏷️ 细粒度属性：${entries.map(([key, value]) => `${key}=${oneLine(value, 40)}`).join('；')}` });
    }
  }

  if (Array.isArray(data.uncertainty) && data.uncertainty.length > 0) {
    blocks.push({ type: 'text', text: `❓ 不确定：${data.uncertainty.map((item) => oneLine(item, 60)).join('；')}` });
  }

  if (item.insight?.usage) {
    const usage = item.insight.usage;
    blocks.push({
      type: 'text',
      text: `· tokens in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0}${usage.cacheReadTokens ? ` / cache ${usage.cacheReadTokens}` : ''}`,
    });
  }
  return blocks;
}

function renderSimilar(similar) {
  const blocks = [{ type: 'text', text: `\n🧭 相似图检索：命中 ${similar.matches.length} 张（阈值 dHash≤${similar.maxDistance ?? '?'}）` }];
  for (const match of similar.matches.slice(0, 10)) {
    const parts = [`d=${match.distance}`, match.aHashDistance !== undefined ? `a=${match.aHashDistance}` : undefined, match.label]
      .filter(Boolean)
      .join(' · ');
    blocks.push({ type: 'text', text: `  - ${match.key}｜${parts}` });
  }
  return blocks;
}

/**
 * 给 output.schema 用的 JSON Schema。
 * 只描述程序真正依赖的字段（而非全部嵌套细节），既保证契约稳定，又避免 schema 本身过大。
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否整体成功（单图失败时仍可能为 true，具体看 results[].error）' },
    mode: { type: 'string', enum: ['full', 'local', 'ocr', 'objects', 'attributes'], description: '本次使用的识别模式' },
    model: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        source: {
          type: 'string',
          enum: ['explicit', 'config', 'current-session', 'agent-default', 'auto-vision-catalog', 'none', 'unavailable'],
          description: 'explicit=参数指定，config=插件配置，current-session=当前会话模型，agent-default=宿主默认模型（本机可认证的路由），auto-vision-catalog=自动挑选的视觉模型，unavailable=无可用视觉模型（已降级）',
        },
        reasoningEffort: { type: 'string', description: '本次实际使用的思考档位（未指定时不出现）' },
      },
    },
    timing: {
      type: 'object',
      properties: {
        totalMs: { type: 'number' },
        localMs: { type: 'number' },
        cloudMs: { type: 'number' },
      },
    },
    cache: {
      type: 'object',
      properties: {
        checked: { type: 'boolean' },
        hit: { type: 'boolean' },
        kind: { type: 'string', enum: ['exact', 'near'] },
        distance: { type: 'number' },
        key: { type: 'string' },
      },
    },
    results: {
      type: 'array',
      description: '按输入顺序一一对应',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          attachmentId: { type: 'string' },
          skipped: { type: 'string', description: '被跳过的原因（如内容相同）' },
          error: { type: 'string' },
          local: {
            type: 'object',
            description: '本地感知结果：尺寸/指纹/曝光/清晰度/主色/布局/质量评分',
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
              aspectRatio: { type: 'number' },
              mediaType: { type: 'string' },
              bytes: { type: 'number' },
              sha256: { type: 'string' },
              fingerprints: {
                type: 'object',
                properties: { dhash: { type: 'string' }, ahash: { type: 'string' } },
              },
              quality: {
                type: 'object',
                properties: {
                  score: { type: 'number' },
                  verdict: { type: 'string', enum: ['good', 'fair', 'poor', 'unusable'] },
                  notes: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
          insight: {
            type: 'object',
            properties: {
              jsonParsed: { type: 'boolean', description: 'false 表示模型没给出合法 JSON，parsed 缺失、raw 为原文' },
              raw: { type: 'string' },
              parsed: {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  description: { type: 'string' },
                  imageType: { type: 'string' },
                  composition: { type: 'string' },
                  objects: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        confidence: { type: 'number' },
                        bbox: { type: 'array', items: { type: 'number' }, description: '相对整图百分比 [x,y,w,h]' },
                        attributes: { type: 'object' },
                      },
                    },
                  },
                  text: {
                    type: 'object',
                    properties: {
                      hasText: { type: 'boolean' },
                      fullText: { type: 'string' },
                      blocks: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            content: { type: 'string' },
                            type: { type: 'string' },
                            confidence: { type: 'number' },
                            bbox: { type: 'array', items: { type: 'number' } },
                          },
                        },
                      },
                    },
                  },
                  attributes: { type: 'object' },
                  uncertainty: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    similar: {
      type: 'object',
      description: '以图搜图结果：在本地缓存索引中按感知哈希检索',
      properties: {
        query: {
          type: 'object',
          properties: { dhash: { type: 'string' }, ahash: { type: 'string' } },
        },
        maxDistance: { type: 'number' },
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
              summary: { type: 'string' },
              at: { type: 'number' },
            },
          },
        },
      },
    },
    notice: { type: 'string', description: '降级/替代/跳过的整体说明' },
    error: { type: 'string' },
  },
  required: ['ok', 'mode', 'results'],
};

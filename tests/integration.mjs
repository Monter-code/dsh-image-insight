/**
 * dsh-image-insight —— 端到端集成测试
 *
 * 用最小可用的假宿主（记录注册的工具 + 假 attachments + 假 llm）真实驱动插件的
 * apply()/execute()，覆盖那些“跑起来才知道”的风险：
 *
 *  1. 插件注册得成不成、工具契约字段全不全（output.schema / output.render / presentCall）；
 *  2. 本地模式是否真的一次网络都不出；
 *  3. 第二次分析同一张图是否命中缓存且不再调用模型（这是“迅速”的核心承诺）；
 *  4. 批量里的重复图是否被正确跳过，结果顺序是否与输入一致；
 *  5. 模型不声明 image 输入模态时，插件是否**拒绝发图**而不是偷偷发出去；
 *  6. render/presentResult 是否总能产出合法 ContentBlock（卡片崩了会污染整轮对话）；
 *  7. 缓存维护工具与相似图工具的返回形状。
 *
 * 运行：node tests/integration.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDependency } from '../lib/deps.mjs';
import { apply, inject, name } from '../lib/index.js';
import { runHostPipeline, validateJsonSchema } from './host-sim.mjs';

const sharp = await loadDependency('sharp');

let passed = 0;
let failed = 0;
const failures = [];

async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${title}`);
  } catch (error) {
    failed += 1;
    failures.push({ title, error });
    console.log(`  ❌ ${title}\n     ${error?.message ?? error}`);
  }
}

/**
 * 复刻宿主 dsh-llm/call-config.js 的 callConfigEquals（逐字对齐源码的比对字段），
 * 否则“准备了却不按准备结果派发”这个真实缺陷在测试里永远不会暴露。
 */
function callConfigEquals(a, b) {
  if (a.provider !== b.provider || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort) return false;
  if (a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false;
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop;
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}

/** 假宿主：捕获工具注册、伪造 attachments 与 llm，并记录所有调用次数。 */
function makeHost(options = {}) {
  const tools = new Map();
  const calls = { saveImage: 0, readImage: 0, stream: 0, prepareCall: 0, prepareConfigs: [], lastStreamOptions: undefined };
  const visionOk = options.visionOk !== false;
  const modelReplies = options.modelReplies ?? [defaultModelReply()];
  // 复刻宿主行为：模型声明了思考档时，prepareCall 会把“默认档”materialize 进 config；
  // rejectEffort=true 时还会像宿主那样对不支持的档位抛 UNSUPPORTED_REASONING_EFFORT。
  const efforts = options.efforts ?? undefined;
  const defaultEffort = options.defaultEffort ?? 'high';
  const rejectEffort = options.rejectEffort === true;
  // 会话模型：宿主 agentDefaultModel.currentSelection() 返回的 {provider, model, reasoningEffort?}。
  // sessionModelVision=false 用来模拟“会话模型是纯文本模型”，此时插件必须回退到模型目录挑视觉模型。
  const sessionModel = options.sessionModel;
  const sessionModelVision = options.sessionModelVision !== false;
  let replyIndex = 0;

  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`工具重复注册：${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(key) {
      if (key === 'attachments') return attachments;
      if (key === 'llm') return llm;
      if (key === 'agentDefaultModel') {
        return sessionModel === undefined ? undefined : { currentSelection: () => ({ ...sessionModel }) };
      }
      return undefined;
    },
  };

  const attachments = {
    imageLimits: { maxImageBytes: 10 * 1024 * 1024, maxImagesPerMessage: 10, maxMessageImageBytes: 20 * 1024 * 1024, maxImagePixels: 40e6, maxImageDimension: 8000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    async saveImage(input) {
      calls.saveImage += 1;
      const meta = await sharp(input.data).metadata();
      return {
        attachmentId: `att-${calls.saveImage}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: meta.width,
        height: meta.height,
        name: input.name,
      };
    },
    async saveImages(inputs) {
      return Promise.all(inputs.map((input) => this.saveImage(input)));
    },
    async readImage(ref) {
      calls.readImage += 1;
      const data = options.attachmentBytes ?? (await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer());
      return { ref: { attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: data.length, width: 32, height: 32 }, data };
    },
    imageHostPath() {
      return undefined;
    },
    async validateImage() {},
  };

  const llm = {
    async prepareCall(config) {
      calls.prepareCall += 1;
      calls.prepareConfigs.push({ ...config });
      if (rejectEffort && config.reasoningEffort !== undefined) {
        const error = new Error(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${config.reasoningEffort}"`);
        error.code = 'UNSUPPORTED_REASONING_EFFORT';
        throw error;
      }
      // 宿主 resolveCallWithInfo 的行为：未显式给档位时把适配器默认档写进 resolved config。
      const resolved = config.reasoningEffort === undefined && efforts !== undefined
        ? { ...config, reasoningEffort: defaultEffort }
        : { ...config };
      const resolvesVision = sessionModel !== undefined && config.provider === sessionModel.provider && config.model === sessionModel.model
        ? sessionModelVision
        : visionOk;
      return {
        config: Object.freeze(resolved),
        retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: [], initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.1 },
        inputModalities: resolvesVision ? ['text', 'image'] : ['text'],
        adapterDefaults: resolved.reasoningEffort !== undefined && config.reasoningEffort === undefined ? { reasoningEffort: true } : {},
        // 宿主在 prepared.stream() 里派发前会做这同一次比对，不一致就抛 INVALID_PREPARED_CALL。
        stream: (streamOptions) => {
          if (!callConfigEquals(streamOptions, resolved)) {
            const error = new Error('prepared LLM call config changed before adapter dispatch');
            error.code = 'INVALID_PREPARED_CALL';
            throw error;
          }
          return llm.stream(streamOptions);
        },
      };
    },
    async resolveModelInfo(provider, model) {
      const vision = sessionModel !== undefined && provider === sessionModel.provider && model === sessionModel.model
        ? sessionModelVision
        : visionOk;
      return {
        provider,
        id: model,
        name: model,
        inputModalities: vision ? ['text', 'image'] : ['text'],
        ...(efforts === undefined ? {} : { reasoning: { efforts: efforts.map((id) => ({ id })), defaultEffort } }),
      };
    },
    listProviders() {
      return [{ id: 'mock', name: 'Mock Provider' }];
    },
    async listModels() {
      return [{ provider: 'mock', id: 'mock-vision', name: 'Mock Vision', inputModalities: visionOk ? ['text', 'image'] : ['text'] }];
    },
    stream(streamOptions) {
      calls.stream += 1;
      calls.lastStreamOptions = streamOptions;
      if (options.streamError !== undefined) throw new Error(options.streamError);
      const text = modelReplies[Math.min(replyIndex, modelReplies.length - 1)];
      replyIndex += 1;
      // 校验：真正送到模型的消息必须带 image 块，否则“识别”本身无从谈起。
      const hasImage = streamOptions.messages?.some((message) =>
        Array.isArray(message.content) ? message.content.some((block) => block.type === 'image') : false,
      );
      if (!hasImage) throw new Error('集成测试断言失败：请求里没有 image 内容块');
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (const piece of text.match(/[\s\S]{1,64}/g) ?? []) {
          yield { type: 'text-delta', index: 0, text: piece };
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 812, outputTokens: 210, totalTokens: 1022 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };

  return { ctx, tools, calls, attachments, llm };
}

/**
 * 所有工具调用都必须经过 tests/host-sim.mjs 的宿主复刻流水线：
 * 无损 JSON 快照 → output.schema 严格校验 → deepFreeze → render（必须返回 ContentBlock[]）
 * → presentResult（必须返回 ToolResultView）。
 * 这样“契约写错”会在测试里立刻炸，而不是在真实界面里静默变成空白卡片。
 */
async function callTool(definition, args, exec = { signal: new AbortController().signal }) {
  const { value, content, result, view } = await runHostPipeline(definition, args, exec);
  // content = output.render 产出的块（真实界面卡片用的就是它）；
  // result = 宿主 ToolResult；view = presentResult 产出的 ToolResultView（仅 Host 本地消费方使用）。
  return { value, view, content, result };
}

function defaultModelReply() {  return JSON.stringify({
    summary: '红色圆形与一行深色文字条',
    description: '白色背景上一块红色矩形与一个蓝色圆形，右侧有若干条状深色标记。',
    objects: [
      { name: '红色矩形', confidence: 0.95, bbox: [6.2, 11.1, 28.1, 50.0], attributes: { 颜色: '红', 数量: '1' } },
      { name: '蓝色圆形', confidence: 0.88, bbox: [74.0, 12.2, 14.4, 25.6], attributes: { 颜色: '蓝' } },
    ],
    text: {
      hasText: true,
      fullText: 'SAMPLE TEXT 2026',
      blocks: [
        { content: 'SAMPLE', type: 'label', confidence: 0.91, bbox: [53.1, 33.3, 15.6, 2.2] },
        { content: 'TEXT 2026', type: 'label', confidence: 0.83, bbox: [53.1, 37.2, 20.1, 2.2] },
      ],
    },
    attributes: { 品牌: '未知', 颜色: '红/蓝', 数量: '2', 风格: '扁平矢量', 材质: '', 型号: '' },
    composition: '元素分布在左右两侧，留白充足',
    imageType: 'diagram',
    uncertainty: ['文字条过小，个别字符可能识别有误'],
  });
}

async function fixtureImage(path, { width = 640, height = 360, variant = 0 } = {}) {
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f8fafc"/>
      <rect x="40" y="40" width="180" height="180" rx="12" fill="${variant === 0 ? '#dc2626' : '#16a34a'}"/>
      <circle cx="520" cy="90" r="46" fill="#2563eb"/>
      ${Array.from({ length: 8 }).map((_, index) => `<rect x="340" y="${120 + index * 14}" width="${40 + (index % 3) * 60}" height="8" fill="#111827"/>`).join('')}
    </svg>`,
  );
  const data = await sharp(svg).jpeg({ quality: 92 }).toBuffer();
  await writeFile(path, data);
  return data;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-image-insight-it-'));
  const cacheDir = join(dir, 'cache');
  const imagePath = join(dir, 'a.jpg');
  const otherPath = join(dir, 'b.jpg');
  const copyPath = join(dir, 'a-copy.jpg');
  const resizedPath = join(dir, 'a-small.jpg');
  const bytes = await fixtureImage(imagePath);
  await fixtureImage(otherPath, { variant: 1 });
  await writeFile(copyPath, bytes); // 与 a.jpg 字节完全相同
  await sharp(bytes).resize(320).jpeg({ quality: 70 }).toBuffer().then((data) => writeFile(resizedPath, data));

  try {
    console.log('\n1. 插件注册与工具契约');

    const host = makeHost();
    apply(host.ctx, { cacheDir, provider: 'mock', model: 'mock-vision', maxConcurrency: 3 });

    await test('导出 name / inject 正确', () => {
      assert.equal(name, 'dsh-image-insight');
      assert.deepEqual(inject, ['tools', 'attachments', 'llm']);
    });

    await test('注册三个工具且契约字段完整', () => {
      assert.deepEqual([...host.tools.keys()].sort(), ['image_insight', 'image_insight_cache', 'image_similarity']);
      for (const [toolName, definition] of host.tools) {
        assert.equal(typeof definition.description, 'string', `${toolName} 缺少 description`);
        assert.equal(definition.description.length > 40, true, `${toolName} 的 description 太短，模型难以判断何时使用`);
        assert.equal(definition.parameters?.type, 'object', `${toolName} 缺少 parameters`);
        assert.equal(typeof definition.execute, 'function', `${toolName} 缺少 execute`);
        assert.equal(definition.output?.schema?.type, 'object', `${toolName} 缺少 output.schema`);
        assert.equal(typeof definition.output?.render, 'function', `${toolName} 缺少 output.render`);
      }
    });

    const insight = host.tools.get('image_insight');

    await test('output.render 返回 ContentBlock[]，presentResult 返回 ToolResultView', () => {
      const value = {
        ok: true,
        mode: 'full',
        results: [{ local: { width: 640, height: 360, quality: { score: 90, verdict: 'good', notes: [] }, fingerprints: { dhash: '0'.repeat(16), ahash: '1'.repeat(16) }, sharpness: { laplacianVariance: 900 }, colors: { dominant: [{ hex: '#dc2626', sharePct: 20 }] }, layout: { likelyKind: 'photo' } }, insight: { jsonParsed: true, parsed: JSON.parse(defaultModelReply()) } }],
        model: { provider: 'mock', model: 'mock-vision' },
        timing: { totalMs: 1234, localMs: 40, cloudMs: 1190 },
      };
      // 关键契约（app.asar: ToolOutputDefinition）：render 必须返回 ContentBlock 数组。
      const blocks = insight.output.render({ path: imagePath }, value);
      assert.equal(Array.isArray(blocks), true, 'output.render 必须返回 ContentBlock[]，而不是 ToolResultView');
      assert.equal(blocks.length > 0, true);
      assert.equal(blocks.every((block) => block.type === 'text'), true);
      assert.equal(blocks.map((block) => block.text).join('').includes('SAMPLE'), true, 'OCR 文本应出现在卡片里');
      assert.ok(blocks.some((block) => block.text.includes('@[6.2,11.1,28.1,50]')), '物体坐标应出现在卡片里');

      // presentResult 才是产出卡片视图的钩子。
      const view = insight.presentResult({ path: imagePath }, { content: blocks, isError: false, value });
      assert.equal(view.card, 'generic');
      assert.equal(Array.isArray(view.content), true);

      const errorBlocks = insight.output.render({}, { isError: true, value: undefined, content: [], meta: { error: '模型未声明图片输入' } });
      assert.equal(Array.isArray(errorBlocks), true);
      assert.equal(errorBlocks[0].type, 'text');
      assert.equal(errorBlocks[0].text.includes('模型未声明图片输入'), true);

      const degradedBlocks = insight.output.render({}, { ok: true, mode: 'full', results: [{ local: null, insight: { jsonParsed: false, raw: '一匹马' } }] });
      assert.equal(degradedBlocks.some((block) => block.text.includes('jsonParsed=false')), true, '降级必须显式告知，不能假装成功');
    });

    await test('showImage=true 时卡片附带原图引用块', () => {
      const ref = { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 100, width: 10, height: 10 };
      const blocks = insight.output.render({ showImage: true }, { ok: true, mode: 'full', results: [{ imageRef: ref }], timing: {} });
      const imageBlocks = blocks.filter((block) => block.type === 'image');
      assert.equal(imageBlocks.length, 1);
      assert.deepEqual(imageBlocks[0].attachment, ref);
    });

    await test('presentCall / presentResult 返回可渲染的卡片结构', () => {
      const callCard = insight.presentCall({ path: imagePath, mode: 'ocr' });
      assert.equal(callCard.card, 'generic');
      assert.equal(callCard.title.includes('ocr'), true);
      const resultCard = insight.presentResult({ path: imagePath }, { content: [], isError: false, meta: { summary: 'x' } });
      assert.equal(resultCard.card, 'generic');
      assert.equal(Array.isArray(resultCard.content), true);
    });

    console.log('\n2. 本地模式：零出网 + 五项本地能力');

    await test('mode=local 不触碰模型与附件服务', async () => {
      const localHost = makeHost();
      apply(localHost.ctx, { cacheDir: join(dir, 'cache-local'), provider: 'mock', model: 'mock-vision' });
      const value = await localHost.tools.get('image_insight').execute(
        { path: imagePath, mode: 'local' },
        { signal: new AbortController().signal },
      );
      assert.equal(localHost.calls.stream, 0, 'local 模式必须一次模型调用都没有');
      assert.equal(localHost.calls.saveImage, 0, 'local 模式不应写附件');
      assert.equal(value.ok, true);
      assert.equal(value.mode, 'local');
      assert.equal(value.model.source, 'unavailable', 'local 模式没有启用视觉，来源应标注 unavailable');
      assert.equal(typeof value.results[0].local.width, 'number');
      assert.equal(value.results[0].insight, undefined);
      assert.equal(value.notice.includes('未调用任何模型'), true);
      assert.equal(value.results[0].local.quality.score > 0, true);
      assert.equal(value.results[0].local.layout.candidateRegions >= 2, true);
    });

    console.log('\n3. 云端识别 + 缓存命中（速度承诺）');

    const firstRun = await callTool(insight, { path: imagePath, mode: 'full' });
    const first = firstRun.value;

    await test('真实宿主流水线（execute → output.render）产出的卡片合法且有界', () => {
      const view = firstRun.view;
      assert.equal(view.card, 'generic');
      const content = view.content;
      assert.equal(Array.isArray(content), true);
      assert.equal(content.length > 0, true);
      assert.equal(content.every((block) => typeof block.type === 'string'), true);
      const text = content.map((block) => block.text ?? '').join('\n');
      assert.equal(text.includes('SAMPLE'), true, 'OCR 正文应出现在最终卡片里');
      assert.equal(text.includes('🔎 图像洞察'), true, '卡片头部应包含工具标识与耗时');
      assert.equal(text.includes('ms'), true, '卡片头部应包含耗时信息');
      assert.equal(text.length < 12000, true, `卡片应保持在合理体量内，实际 ${text.length} 字符`);
      // presentResult 收到的是宿主包装后的 ToolResult，必须能吃下并渲染。
      const card = insight.presentResult({ path: imagePath }, firstRun.result);
      assert.equal(card.card, 'generic');
      assert.equal(card.content.length > 0, true);
    });

    await test('显式传入 provider/model 时来源标注为 explicit', async () => {
      const explicitHost = makeHost();
      apply(explicitHost.ctx, { cacheDir: join(dir, 'cache-explicit') });
      const { value } = await callTool(explicitHost.tools.get('image_insight'), {
        path: imagePath,
        mode: 'full',
        provider: 'mock',
        model: 'mock-vision',
      });
      assert.equal(value.model.source, 'explicit');
      assert.equal(value.ok, true);
      assert.equal(explicitHost.calls.stream, 1);
    });

    await test('首次识别：状态完整、坐标与 OCR 正确回落', () => {
      assert.equal(first.ok, true);
      assert.equal(host.calls.stream, 1);
      assert.equal(host.calls.saveImage, 1);
      assert.equal(first.model.provider, 'mock');
      assert.equal(first.model.model, 'mock-vision');
      assert.equal(first.model.source, 'config', 'provider/model 来自插件配置时应标注 config');
      assert.equal(first.results.length, 1);
      const item = first.results[0];
      assert.equal(item.insight.jsonParsed, true);
      assert.equal(item.insight.parsed.objects.length, 2);
      assert.deepEqual(item.insight.parsed.objects[0].bbox, [6.2, 11.1, 28.1, 50]);
      assert.equal(item.insight.parsed.text.fullText, 'SAMPLE TEXT 2026');
      assert.equal(item.insight.usage.inputTokens, 812);
      assert.equal(item.cache.hit, false);
      assert.equal(typeof item.local.quality.score, 'number');
      assert.equal(typeof item.local.fingerprints.dhash, 'string');
      assert.ok(item.attachmentId, '结果里应带会话附件 id，便于前端展示原图');
      assert.equal(first.timing.cloudMs > 0, true);
    });

    await test('二次识别同一张图：命中缓存且不再调用模型', async () => {
      const streamsBefore = host.calls.stream;
      const second = await insight.execute({ path: imagePath, mode: 'full' }, { signal: new AbortController().signal });
      assert.equal(host.calls.stream, streamsBefore, '缓存命中不允许再次出网');
      assert.equal(second.results[0].cache.hit, true);
      assert.equal(second.results[0].cache.kind, 'exact');
      assert.equal(second.cache.hit, true, '顶层 cache 也必须标命中');
      assert.equal(second.cache.kind, 'exact', '顶层 cache 必须带上命中方式，否则卡片标题会渲染成“缓存命中（undefined）”');
      assert.equal(typeof second.cache.key, 'string');
      assert.equal(second.results[0].insight.parsed.summary, '红色圆形与一行深色文字条');
      assert.equal(second.timing.cloudMs, 0);
      assert.equal(second.timing.totalMs < 2000, true, `命中应远快于首次，实际 ${second.timing.totalMs}ms`);
      const headerBlocks = insight.output.render({ path: imagePath, mode: 'full' }, second);
      assert.equal(headerBlocks[0].text.includes('缓存命中（exact）'), true, `卡片标题必须写清命中方式：${headerBlocks[0].text}`);
    });

    await test('refresh=true 强制重新识别', async () => {
      const streamsBefore = host.calls.stream;
      const refreshed = await insight.execute({ path: imagePath, mode: 'full', refresh: true }, { signal: new AbortController().signal });
      assert.equal(host.calls.stream, streamsBefore + 1);
      assert.equal(refreshed.results[0].cache.hit, false);
    });

    await test('缩放版本走感知哈希近似命中（不精确但明确标注）', async () => {
      const streamsBefore = host.calls.stream;
      const resized = await insight.execute({ path: resizedPath, mode: 'full' }, { signal: new AbortController().signal });
      const item = resized.results[0];
      if (item.cache?.hit) {
        assert.equal(item.cache.kind, 'near');
        assert.equal(typeof item.cache.distance, 'number');
        assert.equal(item.notice.includes('近似命中'), true, '近似命中必须如实标注，不能冒充精确命中');
        assert.equal(host.calls.stream, streamsBefore, '近似命中同样不应出网');
      } else {
        // 距离超出阈值时允许重新识别，但必须真的调用了模型。
        assert.equal(host.calls.stream, streamsBefore + 1);
      }
      assert.equal(item.local.width > 0, true, 'approximate 命中也要给出本次图片的本地数据');
    });

    console.log('\n4. 批量、去重与并发');

    await test('批量识别：顺序一致 + 字节重复被跳过', async () => {
      const batchHost = makeHost();
      apply(batchHost.ctx, { cacheDir: join(dir, 'cache-batch'), provider: 'mock', model: 'mock-vision', maxConcurrency: 2 });
      const batch = batchHost.tools.get('image_insight');
      const value = await batch.execute(
        { paths: [imagePath, otherPath, copyPath], mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.results.length, 3);
      assert.equal(value.results[0].source.includes('a.jpg'), true);
      assert.equal(value.results[1].source.includes('b.jpg'), true);
      assert.equal(value.results[2].source.includes('a-copy.jpg'), true);
      assert.equal(value.results[2].skipped?.includes('第 1 张'), true, '完全相同的图应被跳过并指明与哪张重复');
      assert.equal(batchHost.calls.stream, 2, '只应为两张不同图各调用一次模型');
      assert.equal(value.results[2].local.width, 640, '被跳过的图片仍应有本地数据');
    });

    await test('相同路径在参数里重复出现时只处理一次', async () => {
      const dedupeHost = makeHost();
      apply(dedupeHost.ctx, { cacheDir: join(dir, 'cache-dedupe'), provider: 'mock', model: 'mock-vision' });
      const value = await dedupeHost.tools.get('image_insight').execute(
        { paths: [imagePath, imagePath], mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.results.length, 1);
      assert.equal(dedupeHost.calls.stream, 1);
    });

    await test('缺失输入与不存在的文件都给出明确错误', async () => {
      await assert.rejects(
        () => insight.execute({ mode: 'full' }, { signal: new AbortController().signal }),
        (error) => error.code === 'IMAGE_INSIGHT_NO_INPUT',
      );
      const missing = await insight.execute({ path: join(dir, 'nope.jpg'), mode: 'local' }, { signal: new AbortController().signal });
      assert.equal(missing.ok, false);
      assert.equal(typeof missing.results[0].error, 'string');
      assert.equal(missing.results[0].error.length > 0, true);
    });

    console.log('\n5. 拒绝把图发给纯文本模型（准确性的底线）');

    await test('模型不支持图片输入时降级为本地感知，且绝不发图', async () => {
      const textOnlyHost = makeHost({ visionOk: false });
      apply(textOnlyHost.ctx, { cacheDir: join(dir, 'cache-textonly') });
      const value = await textOnlyHost.tools.get('image_insight').execute(
        { path: otherPath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(textOnlyHost.calls.stream, 0, '不支持视觉就不允许发图');
      assert.equal(value.ok, true, '降级不等于失败：本地结论仍然有效');
      assert.equal(value.model.source, 'unavailable');
      assert.equal(value.timing.cloudMs, 0);
      assert.equal(value.notice.includes('已降级为本地感知'), true);
      assert.equal(value.notice.includes('mock-vision'), true, '降级原因要具体到哪个模型、为什么被拒');
      assert.equal(value.notice.includes('纯文本'), true, '应说明目录里该模型是纯文本模型');
      assert.equal(typeof value.results[0].local.width, 'number', '本地数据必须完整保留');
      assert.equal(value.results[0].insight, undefined);
      assert.equal(value.cache.checked, false, '没有视觉能力时不应声称做过云端缓存查询');
    });

    await test('显式指定的视觉模型不可用时，错误文本可指导用户换模型', async () => {
      const textOnlyHost = makeHost({ visionOk: false });
      apply(textOnlyHost.ctx, { cacheDir: join(dir, 'cache-textonly2') });
      const value = await textOnlyHost.tools.get('image_insight').execute(
        { path: otherPath, mode: 'full', provider: 'mock', model: 'mock-vision' },
        { signal: new AbortController().signal },
      );
      assert.equal(textOnlyHost.calls.stream, 0);
      assert.equal(value.model.source, 'unavailable');
      assert.equal(value.notice.includes('mock/mock-vision'), true, '显式指定时，应指出是哪个模型不支持');
      assert.equal(value.notice.includes('inputModalities'), true, '应给出被拒的具体模态声明');
    });
    await test('quality=unusable 的图默认跳过云端以杜绝臆造', async () => {
      const blankPath = join(dir, 'blank.jpg');
      await sharp({ create: { width: 600, height: 400, channels: 3, background: '#808080' } })
        .jpeg()
        .toBuffer()
        .then((data) => writeFile(blankPath, data));
      const blankHost = makeHost();
      apply(blankHost.ctx, { cacheDir: join(dir, 'cache-blank'), provider: 'mock', model: 'mock-vision' });
      const value = await blankHost.tools.get('image_insight').execute(
        { path: blankPath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      const item = value.results[0];
      if (item.local.quality.verdict === 'unusable') {
        assert.equal(blankHost.calls.stream, 0, 'unusable 的图不应发往云端');
        assert.equal(item.notice.includes('已跳过云端识别'), true);
      } else {
        assert.equal(blankHost.calls.stream, 1, `质量判定为 ${item.local.quality.verdict}，应正常识别`);
      }
    });

    console.log('\n6. 相似图检索与缓存维护');

    await test('image_similarity 能找回已索引的图片', async () => {
      const similarity = host.tools.get('image_similarity');
      const value = await similarity.execute({ path: imagePath, maxDistance: 6, limit: 5 }, { signal: new AbortController().signal });
      assert.equal(value.matches.length >= 1, true, '刚索引过的图应能被找回');
      assert.equal(value.matches[0].distance, 0, '同一文件距离应为 0');
      assert.equal(value.matches[0].sameFile, true, 'sha256 相同应标记同源');
      assert.equal(typeof value.indexed, 'number');
      assert.equal(value.query.dhash.length, 16);

      // 走一遍真实宿主流水线：presentResult 只能从 result.meta 读命中数（ToolResult 没有 value 字段）。
      const run = await callTool(similarity, { path: imagePath, maxDistance: 6, limit: 5 });
      assert.equal(run.value.matches.length >= 1, true);
      assert.equal(run.result.meta.matchCount, run.value.matches.length, 'presentationMeta 必须暴露命中数');
      assert.equal(run.view.title, '相似图检索');
      assert.match(run.view.content[0].text, /命中 \d+ 张相似图/, `presentResult 文案应显示真实命中数，实际：${run.view.content[0].text}`);
    });

    await test('image_similarity 用缩放版也能命中（距离 > 0）', async () => {
      const similarity = host.tools.get('image_similarity');
      const value = await similarity.execute({ path: resizedPath, maxDistance: 10, limit: 5 }, { signal: new AbortController().signal });
      assert.equal(value.matches.length >= 1, true, '缩放版应在放宽阈值后命中');
      assert.equal(value.matches[0].sameFile, false, '不同字节不应标为同源');
    });

    await test('缓存工具 stats/gc 返回可读报告', async () => {
      const cacheTool = host.tools.get('image_insight_cache');
      const stats = await cacheTool.execute({ action: 'stats' }, { signal: new AbortController().signal });
      assert.equal(stats.action, 'stats');
      assert.equal(stats.entries >= 1, true);
      assert.equal(stats.hits.exact >= 1, true);
      assert.equal(typeof stats.sizeBytes, 'number');
      assert.equal(stats.callStats.calls >= 1, true);

      const gc = await cacheTool.execute({ action: 'gc', ttlDays: 30 }, { signal: new AbortController().signal });
      assert.equal(gc.action, 'gc');
      assert.equal(typeof gc.removedEntries, 'number');
      const blocks = cacheTool.output.render({ action: 'gc' }, gc);
      assert.equal(Array.isArray(blocks), true, 'output.render 必须返回 ContentBlock 数组');
      assert.equal(blocks[0].type, 'text');
      assert.equal(blocks[0].text.includes('条目'), true);
      const card = cacheTool.presentResult({ action: 'gc' }, { content: blocks, isError: false });
      assert.equal(card.card, 'generic');
      assert.equal(card.content[0].text.includes('本次清理'), true, 'presentResult 应直接复用 output.render 的块');
    });

    console.log('\n7. 模型输出不规范时的降级行为');

    await test('模型返回非 JSON：保留原文并标记 jsonParsed=false，不丢结果', async () => {
      const messyHost = makeHost({
        modelReplies: ['这张图里有一个红色矩形和一个蓝色圆形，右侧还有文字。'],
      });
      apply(messyHost.ctx, { cacheDir: join(dir, 'cache-messy'), provider: 'mock', model: 'mock-vision' });
      const value = await messyHost.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.ok, true, '模型不听话不应导致整次失败');
      assert.equal(value.results[0].insight.jsonParsed, false);
      assert.equal(value.results[0].insight.parsed, undefined);
      assert.equal(value.results[0].insight.raw.includes('红色矩形'), true);
      assert.equal(value.results[0].local.width, 640, '本地数据仍必须完整');
    });

    await test('模型返回围栏包裹的 JSON 也能解析', async () => {
      const fencedHost = makeHost({ modelReplies: [`\`\`\`json\n${defaultModelReply()}\n\`\`\``] });
      apply(fencedHost.ctx, { cacheDir: join(dir, 'cache-fenced'), provider: 'mock', model: 'mock-vision' });
      const value = await fencedHost.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.results[0].insight.jsonParsed, true);
      assert.equal(value.results[0].insight.parsed.imageType, 'diagram');
    });

    await test('question / extraInstruction 被拼进提示词', async () => {
      const captureHost = makeHost();
      apply(captureHost.ctx, { cacheDir: join(dir, 'cache-instr'), provider: 'mock', model: 'mock-vision' });
      let captured;
      const originalStream = captureHost.llm.stream;
      captureHost.llm.stream = (options) => {
        captured = options;
        return originalStream(options);
      };
      // ctx.get('llm') 每次返回同一对象，替换其方法即可拦截。
      await captureHost.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full', question: '这是不是促销海报？', extraInstruction: '重点看水印' },
        { signal: new AbortController().signal },
      );
      const textBlock = captured.messages[0].content.find((block) => block.type === 'text');
      assert.equal(textBlock.text.includes('重点看水印'), true);
      assert.equal(textBlock.text.includes('这是不是促销海报？'), true);
      assert.equal(captured.temperature, 0, '识别任务默认温度为 0');
      assert.equal(captured.system.includes('JSON'), true);
      assert.equal(Array.isArray(captured.messages[0].content), true);
      assert.equal(captured.messages[0].content[0].type, 'image', '图片块应在文字之前');
    });

    console.log('\n8. prepareCall 与派发必须用同一份配置（真实缺陷回归）');

    await test('宿主 materialize 的 reasoningEffort 必须原样带进 stream options', async () => {
      // 真实缺陷：宿主 prepareCall 会把模型默认档（deepseek-flash 为 high）写进 resolved config，
      // 派发前用 callConfigEquals 比对；如果插件自己另起一份 config 去 stream，
      // 宿主就抛 “prepared LLM call config changed before adapter dispatch”。
      const host = makeHost({ efforts: ['minimal', 'low', 'high'], defaultEffort: 'high' });
      apply(host.ctx, { cacheDir: join(dir, 'cache-effort'), provider: 'mock', model: 'mock-vision' });
      const value = await host.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.ok, true, `不应被宿主拒绝：${value.results?.[0]?.error ?? ''}`);
      assert.equal(host.calls.stream, 1);
      assert.equal(host.calls.lastStreamOptions.reasoningEffort, 'minimal', '默认应挑模型声明里最低的思考档以求快');
      assert.equal(value.model.reasoningEffort, 'minimal', '顶层 model 也要带档位，否则卡片标题显示不出来');
      assert.equal(value.results[0].insight.model.reasoningEffort, 'minimal', '实际使用的档位必须写进结果，便于审计');
    });

    await test('挑中的思考档不被模型接受时退回默认档，而不是让整次识别失败', async () => {
      const host = makeHost({ efforts: ['low', 'high'], defaultEffort: 'high', rejectEffort: true });
      apply(host.ctx, { cacheDir: join(dir, 'cache-effort-retry'), provider: 'mock', model: 'mock-vision' });
      const value = await host.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.ok, true, '降级重试后仍应成功');
      const lastTwo = host.calls.prepareConfigs.slice(-2);
      assert.equal(lastTwo[0].reasoningEffort, 'low', '第一次带着挑中的档位去准备');
      assert.equal(lastTwo[1].reasoningEffort, undefined, '被拒后第二次不带档位重新准备');
      assert.equal(host.calls.lastStreamOptions.reasoningEffort, 'high', '退回后应使用宿主 materialize 的默认档');
      assert.equal(value.results[0].insight.model.reasoningEffort, 'high');
    });

    await test('reasoningEffort="default" 时不指定档位，交由模型默认', async () => {
      const host = makeHost({ efforts: ['minimal', 'high'], defaultEffort: 'high' });
      apply(host.ctx, { cacheDir: join(dir, 'cache-effort-default'), provider: 'mock', model: 'mock-vision', reasoningEffort: 'default' });
      const value = await host.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.ok, true);
      assert.equal(host.calls.lastStreamOptions.reasoningEffort, 'high', '未指定档位时宿主 materialize 的默认档仍须一致');
    });

    console.log('\n9. 路由优先级与凭据可诊断性（真机踩到的缺陷回归）');

    await test('有宿主默认模型时优先用它，而不是模型目录里任挑一个', async () => {
      // 真机现象：插件曾在模型目录里挑到 provider "deepseek-official"（需要 API key），
      // 而本机真正能认证的是 OAuth 的 "deepseek-account"；host 的 agentDefaultModel.currentSelection()
      // 才是权威答案（宿主自己也这么取默认模型）。
      const host = makeHost({ sessionModel: { provider: 'deepseek-account', model: 'deepseek-flash' } });
      apply(host.ctx, { cacheDir: join(dir, 'cache-agent-default') });
      const value = await host.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.ok, true, `默认模型应可用：${value.results?.[0]?.error ?? ''}`);
      assert.equal(value.model.source, 'agent-default', '来源必须标成 agent-default 以便审计');
      assert.equal(value.model.provider, 'deepseek-account');
      assert.equal(host.calls.lastStreamOptions.provider, 'deepseek-account', '真正派发的必须是这条可认证路由');
      assert.equal(host.calls.lastStreamOptions.model, 'deepseek-flash');
    });

    await test('自动挑选的路由没有凭据时，错误里附带可执行的指引', async () => {
      const host = makeHost({
        sessionModel: { provider: 'deepseek-account', model: 'text-only' },
        sessionModelVision: false, // 会话模型是纯文本 → 插件只能回退到模型目录
        streamError: 'llm-deepseek: no API key for provider route "mock"',
      });
      apply(host.ctx, { cacheDir: join(dir, 'cache-cred-hint') });
      const value = await host.tools.get('image_insight').execute(
        { path: imagePath, mode: 'full' },
        { signal: new AbortController().signal },
      );
      assert.equal(value.ok, false);
      const error = value.results[0].error;
      assert.equal(error.includes('no API key'), true, '宿主原文必须保留');
      assert.equal(error.includes('本机已配置凭据'), true, '必须告诉用户怎么改');
      assert.equal(error.includes('deepseek-account/text-only'), true, '必须点名当前会话模型作为候选');
    });

    console.log(`\n${failed === 0 ? '🎉 全部通过' : '⚠️ 存在失败'}：${passed} 通过 / ${failed} 失败`);
    if (failed > 0) {
      console.log('\n失败明细：');
      for (const item of failures) console.log(`- ${item.title}\n  ${item.error?.stack ?? item.error}`);
      process.exitCode = 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('集成测试自身崩溃：', error);
  process.exitCode = 1;
});

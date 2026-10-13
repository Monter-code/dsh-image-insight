/**
 * 输出契约校验：用 OUTPUT_SCHEMA 亲自校验真实执行结果。
 *
 * 为什么需要它：工具输出既给模型也给人看，schema 一旦与 execute() 的真实返回值脱节，
 * 模型会读到不存在的字段、或拿到它没被告知的字段。这里不引第三方校验库（插件要零开发依赖），
 * 实现一个覆盖本 schema 用到的关键字（type/properties/required/items/enum/additionalProperties）的
 * 最小校验器，对 mock 宿主下的真实返回值做严格校验。
 *
 * 运行：node tests/schema-contract.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDependency } from '../lib/deps.mjs';
import { apply } from '../lib/index.js';
import { OUTPUT_SCHEMA } from '../lib/present.mjs';

const sharp = await loadDependency('sharp');

/** 最小 JSON Schema 校验器：只支持本仓库 schema 实际用到的关键字。 */
function validate(schema, value, path = '$', errors = []) {
  const fail = (message) => errors.push(`${path}: ${message}`);
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.enum) {
    if (!schema.enum.includes(value)) fail(`值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)} 中`);
    return errors;
  }

  const type = schema.type;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type) {
    const matches =
      (type === 'object' && actual === 'object') ||
      (type === 'array' && actual === 'array') ||
      (type === 'string' && actual === 'string') ||
      (type === 'number' && actual === 'number') ||
      (type === 'integer' && actual === 'number') ||
      (type === 'boolean' && actual === 'boolean') ||
      (type === 'null' && actual === 'null');
    if (!matches) {
      fail(`期望 ${type}，实际 ${actual}`);
      return errors;
    }
  }

  if (type === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) fail(`缺少必填字段 ${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) fail(`出现未声明字段 ${key}`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!(key in value)) continue;
      validate(child, value[key], `${path}.${key}`, errors);
    }
  }

  if (type === 'array' && schema.items) {
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`, errors));
  }
  return errors;
}

/** 假宿主（与集成测试同构，这里只要能产出真实返回值即可）。 */
function makeHost() {
  const tools = new Map();
  let saveCount = 0;
  const reply = JSON.stringify({
    summary: '一张扁平矢量图',
    description: '白底上有红色方形与蓝色圆形。',
    objects: [{ name: '红色方形', confidence: 0.9, bbox: [8.3, 12.5, 37.5, 56.3], attributes: { 颜色: '红' } }],
    text: { hasText: true, fullText: 'HELLO', blocks: [{ content: 'HELLO', type: 'label', confidence: 0.8, bbox: [50, 30, 20, 5] }] },
    attributes: { 颜色: '红/蓝' },
    composition: '左右分布',
    imageType: 'diagram',
    uncertainty: [],
  });
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
    get(key) {
      if (key === 'attachments') return attachments;
      if (key === 'llm') return llm;
      return undefined;
    },
  };
  const attachments = {
    async saveImage(input) {
      saveCount += 1;
      const meta = await sharp(input.data).metadata();
      return { attachmentId: `att-${saveCount}`, mediaType: input.mediaType, bytes: input.data.length, width: meta.width, height: meta.height, name: input.name };
    },
    async readImage() {
      return { ref: { attachmentId: 'att-x', mediaType: 'image/png', bytes: 10, width: 4, height: 4 }, data: Buffer.alloc(10) };
    },
  };
  const llm = {
    async prepareCall(config) {
      return { config, inputModalities: ['text', 'image'], adapterDefaults: {}, stream: (options) => llm.stream(options) };
    },
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: async () => [{ provider: 'mock', id: 'mock-vision', name: 'Mock Vision', inputModalities: ['text', 'image'] }],
    stream() {
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  return { ctx, tools };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-image-insight-schema-'));
  try {
    const svg = Buffer.from(
      '<svg width="200" height="120" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/><rect x="10" y="10" width="60" height="60" fill="#dc2626"/></svg>',
    );
    const imagePath = join(dir, 'sample.png');
    await writeFile(imagePath, await sharp(svg).png().toBuffer());

    const host = makeHost();
    apply(host.ctx, { cacheDir: join(dir, 'cache'), provider: 'mock', model: 'mock-vision' });

    console.log('1. image_insight 输出必须完全符合 OUTPUT_SCHEMA');
    const insight = host.tools.get('image_insight');
    const value = await insight.execute({ path: imagePath, mode: 'full', saveIndexLabel: '样例' }, { signal: new AbortController().signal });
    let errors = validate(OUTPUT_SCHEMA, value);
    assert.deepEqual(errors, [], `schema 校验失败：\n${errors.join('\n')}`);
    console.log('   ✅ 首次识别结果通过校验');

    console.log('\n2. 缓存命中、跳过、错误等分支的结果形状同样合规');
    const cached = await insight.execute({ path: imagePath, mode: 'full' }, { signal: new AbortController().signal });
    assert.equal(cached.results[0].cache.hit, true);
    errors = validate(OUTPUT_SCHEMA, cached);
    assert.deepEqual(errors, [], `缓存分支 schema 校验失败：\n${errors.join('\n')}`);

    const batch = await insight.execute({ paths: [imagePath, imagePath, join(dir, 'missing.png')], mode: 'full' }, { signal: new AbortController().signal });
    errors = validate(OUTPUT_SCHEMA, batch);
    assert.deepEqual(errors, [], `批量/错误分支 schema 校验失败：\n${errors.join('\n')}`);
    assert.equal(batch.results.length, 2, '同一路径去重后应为 2 项（含 1 个不存在文件）');
    console.log('   ✅ 缓存命中 / 文件不存在分支均通过校验');

    console.log('\n3. 其他两个工具的输出形状');
    const similarity = host.tools.get('image_similarity');
    const similarValue = await similarity.execute({ path: imagePath }, { signal: new AbortController().signal });
    errors = validate(similarity.output.schema, similarValue);
    assert.deepEqual(errors, [], `image_similarity schema 校验失败：\n${errors.join('\n')}`);

    const cacheTool = host.tools.get('image_insight_cache');
    const cacheValue = await cacheTool.execute({ action: 'stats' }, { signal: new AbortController().signal });
    errors = validate(cacheTool.output.schema, cacheValue);
    assert.deepEqual(errors, [], `image_insight_cache schema 校验失败：\n${errors.join('\n')}`);
    console.log('   ✅ image_similarity / image_insight_cache 通过校验');

    console.log('\n4. 校验器本身能抓到偏差（避免“永远通过”的假测试）');
    const broken = { ...value, results: [{ ...value.results[0], local: { ...value.results[0].local, width: '640' } }] };
    const brokenErrors = validate(OUTPUT_SCHEMA, broken);
    assert.equal(brokenErrors.length > 0, true, '校验器必须能发现字段类型错误');
    const missingRequired = validate(OUTPUT_SCHEMA, { mode: 'full', results: [] });
    assert.equal(missingRequired.some((item) => item.includes('缺少必填字段 ok')), true, '校验器必须能发现缺少必填字段');
    console.log('   ✅ 校验器对类型错误与缺字段都能报错');

    console.log('\n🎉 输出契约校验全部通过');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('schema 校验失败：', error);
  process.exitCode = 1;
});

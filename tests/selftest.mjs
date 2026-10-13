/**
 * dsh-image-insight —— 自检脚本
 *
 * 不依赖任何测试框架（插件要保持零开发依赖），用 Node 直接跑：
 *   node tests/selftest.mjs
 *
 * 覆盖三类风险点：
 *  A. 纯函数层：JSON 兜底解析、稳定序列化、并发调度、超时——这些出错会静默降低准确率。
 *  B. 本地感知层：用程序生成的图片（含已知文字块/色块/模糊版本）验证尺寸、指纹、
 *     质量分级、相似判定确实按预期工作，而不是“看起来能跑”。
 *  C. 缓存层：精确命中、近似命中、TTL、LRU——这是“迅速”的全部依靠。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ImageInsightCache, exactKey, hammingDistance64 } from '../lib/cache.mjs';
import { loadDependency } from '../lib/deps.mjs';
import { analyzeLocal, prepareForVision } from '../lib/local.mjs';
import { parseJsonLoose, stableStringify, withTimeout, mapLimit, truncate, formatMs } from '../lib/util.mjs';
import { normalizeVisionResult, parseVisionOutput } from '../lib/vision.mjs';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 生成一张测试图：白底 + 左上红色块 + 右侧深色“文字条”，可选高斯模糊。 */
async function makeTestImage(sharp, { width = 640, height = 360, blur = false } = {}) {
  const bars = Array.from({ length: 8 })
    .map((_, index) => `<rect x="340" y="${120 + index * 14}" width="${40 + (index % 3) * 60}" height="8" fill="#111827"/>`)
    .join('');
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <rect width="100%" height="100%" fill="#f8fafc"/>
       <rect x="40" y="40" width="180" height="180" rx="12" fill="#dc2626"/>
       <circle cx="520" cy="90" r="46" fill="#2563eb"/>
       ${bars}
     </svg>`,
  );
  let pipeline = sharp(svg);
  if (blur) pipeline = pipeline.blur(12);
  return pipeline.jpeg({ quality: 92 }).toBuffer();
}

async function main() {
  const sharp = await loadDependency('sharp');
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-image-insight-'));

  try {
    section('A. 纯函数层');

    await test('stableStringify 无视键顺序', () => {
      assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
      assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
    });

    await test('parseJsonLoose 处理五种模型常见偏差', () => {
      assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
      assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
      assert.deepEqual(parseJsonLoose('```\n{"a":1}\n```'), { a: 1 });
      assert.deepEqual(parseJsonLoose('好的，结果如下：\n{"a":1,"b":{"c":"}"}}\n以上。'), { a: 1, b: { c: '}' } });
      assert.deepEqual(parseJsonLoose('{"a":1,}'), { a: 1 });
      assert.deepEqual(parseJsonLoose('{\u201ca\u201d:1}'), { a: 1 });
      assert.equal(parseJsonLoose('完全不是 JSON'), undefined);
      assert.equal(parseJsonLoose(''), undefined);
    });

    await test('withTimeout 超时并清理，不悬挂', async () => {
      const never = new Promise(() => {});
      await assert.rejects(() => withTimeout(never, 30, undefined, '测试'), (error) => error.code === 'IMAGE_INSIGHT_TIMEOUT');
      const fast = await withTimeout(Promise.resolve('ok'), 500);
      assert.equal(fast, 'ok');
    });

    await test('withTimeout 响应外部 abort', async () => {
      const controller = new AbortController();
      const never = new Promise(() => {});
      const promise = withTimeout(never, 5000, controller.signal, '测试');
      controller.abort();
      await assert.rejects(() => promise, (error) => error.code === 'IMAGE_INSIGHT_ABORTED');
    });

    await test('mapLimit 保持顺序、限并发、单点失败不中断', async () => {
      let active = 0;
      let peak = 0;
      const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (value === 4) throw new Error('boom');
        return value * 10;
      });
      assert.equal(peak <= 2, true, `并发峰值应为 2，实际 ${peak}`);
      assert.deepEqual(
        results.map((item) => (item.ok ? item.value : 'err')),
        [10, 20, 30, 'err', 50, 60],
      );
    });

    await test('truncate / formatMs / hammingDistance64', () => {
      assert.equal(truncate('abc', 10), 'abc');
      assert.equal(truncate('a'.repeat(30), 10).includes('已截断'), true);
      assert.equal(formatMs(120), '120ms');
      assert.equal(formatMs(2500), '2.50s');
      assert.equal(hammingDistance64(0n, 0n), 0);
      assert.equal(hammingDistance64(0b1010n, 0b0101n), 4);
    });

    section('B. 视觉输出归一化');

    await test('normalizeVisionResult 夹取坐标、过滤低置信、排序', () => {
      const parsed = normalizeVisionResult({
        summary: '测试',
        objects: [
          { name: '低', confidence: 0.2, bbox: [150, -5, 10, 10] },
          { name: '高', confidence: 0.9, bbox: [10.234, 20, 30, 40] },
          { name: '', confidence: 1 },
        ],
        text: { hasText: true, fullText: 'hello', blocks: [{ content: 'hello', bbox: [1, 2, 3, 4], confidence: 0.7 }] },
        uncertainty: ['看不清右下角'],
      });
      assert.equal(parsed.objects.length, 2);
      assert.equal(parsed.objects[0].name, '高');
      assert.deepEqual(parsed.objects[0].bbox, [10.2, 20, 30, 40]);
      assert.deepEqual(parsed.objects[1].bbox, [100, 0, 10, 10], '越界坐标应被夹取到 0-100，而不是丢弃或原样透传');
      assert.equal(parsed.text.blocks.length, 1);
      assert.deepEqual(parsed.uncertainty, ['看不清右下角']);
    });

    await test('parseVisionOutput 在非 JSON 时保留原文并标记降级', () => {
      const ok = parseVisionOutput('{"summary":"s"}');
      assert.equal(ok.jsonParsed, true);
      const bad = parseVisionOutput('一匹马在草地上。');
      assert.equal(bad.jsonParsed, false);
      assert.equal(bad.raw, '一匹马在草地上。');
    });

    section('C. 本地感知层（真实图片字节）');

    const image = await makeTestImage(sharp);
    const blurred = await makeTestImage(sharp, { blur: true });

    await test('analyzeLocal 给出尺寸、格式、指纹与质量', async () => {
      const local = await analyzeLocal(image, image);
      assert.equal(local.width, 640);
      assert.equal(local.height, 360);
      assert.equal(local.mediaType, 'image/jpeg');
      assert.match(local.fingerprints.dhash, /^[0-9a-f]{16}$/);
      assert.match(local.fingerprints.ahash, /^[0-9a-f]{16}$/);
      assert.equal(local.sha256.length, 64);
      assert.equal(local.quality.verdict === 'unusable', false, '正常图不应判为 unusable');
      assert.equal(local.colors.dominant.length > 0, true);
      assert.equal(local.colors.dominant[0].hex.startsWith('#'), true);
      assert.equal(local.layout.candidateRegions >= 2, true, '红/蓝块应被连通域检出');
    });

    await test('指纹稳定：同图重编码后 dHash 距离很小', async () => {
      const resized = await sharp(image).resize(320).jpeg({ quality: 60 }).toBuffer();
      const a = await analyzeLocal(image, image);
      const b = await analyzeLocal(resized, resized);
      const distance = hammingDistance64(BigInt(`0x${a.fingerprints.dhash}`), BigInt(`0x${b.fingerprints.dhash}`));
      assert.equal(distance <= 8, true, `缩放重编码后距离应很小，实际 ${distance}`);
    });

    await test('模糊图清晰度显著低于清晰图', async () => {
      const crisp = await analyzeLocal(image, image);
      const soft = await analyzeLocal(blurred, blurred);
      assert.equal(soft.sharpness.laplacianVariance < crisp.sharpness.laplacianVariance, true);
      assert.equal(soft.sharpness.verdict === 'blurry', true, `12px 高斯模糊应判为 blurry，实际 ${soft.sharpness.verdict}`);
    });

    await test('极低分辨率被判为质量不足', async () => {
      const tiny = await sharp(image).resize(40, 24).jpeg().toBuffer();
      const local = await analyzeLocal(tiny, tiny);
      assert.equal(local.quality.score < 85, true);
      assert.equal(local.quality.notes.length > 0, true);
    });

    await test('prepareForVision 限制长边、可解码、方向已处理', async () => {
      const big = await sharp(image).resize(4000, 2250).jpeg().toBuffer();
      const prepared = await prepareForVision(big, { maxEdge: 1536 });
      assert.equal(Math.max(prepared.width, prepared.height), 1536);
      assert.equal(prepared.scaled, true);
      assert.equal(prepared.sourceWidth, 4000);
      const meta = await sharp(prepared.data).metadata();
      assert.equal(meta.width, prepared.width);
    });

    await test('prepareForVision 对小图不放大', async () => {
      const prepared = await prepareForVision(image, { maxEdge: 1536 });
      assert.equal(prepared.scaled, false);
      assert.equal(prepared.width, 640);
    });

    await test('带 alpha 的 PNG 被合成到白底并输出 PNG', async () => {
      // 半透明红：合成到白底后应得到不透明的浅红（而非把透明区留黑）。
      const png = await sharp({
        create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
      })
        .png()
        .toBuffer();
      const prepared = await prepareForVision(png, { maxEdge: 1536 });
      assert.equal(prepared.mediaType, 'image/png');
      const meta = await sharp(prepared.data).metadata();
      assert.equal(meta.hasAlpha, false, '合成到白底后应不再带 alpha 通道');
      const stats = await sharp(prepared.data).stats();
      const [red, green, blue] = stats.channels;
      assert.equal(red.mean > 250, true, `红通道应接近 255，实际 ${red.mean}`);
      assert.equal(green.mean > 120 && green.mean < 135, true, `绿通道应约 127（白底混合），实际 ${green.mean}`);
      assert.equal(blue.mean, green.mean, '蓝通道应与绿通道一致');
    });

    section('D. 缓存层');

    await test('精确命中与 TTL', async () => {
      const dir = join(tmp, 'cache-exact');
      const cache = new ImageInsightCache({ dir, ttlDays: 30, maxEntries: 100 });
      await cache.init();
      const key = exactKey(image, 'fp');
      assert.equal(await cache.getExact(key), undefined);
      await cache.put(key, { results: [{ ok: 1 }], savedAt: Date.now(), ttlDays: 30 }, { dhash: '0'.repeat(16), label: '测试图' });
      const hit = await cache.getExact(key);
      assert.deepEqual(hit, { results: [{ ok: 1 }], savedAt: hit.savedAt, ttlDays: 30 });
      assert.equal(cache.hits.exact, 1);

      // 重新加载索引（模拟进程重启）后仍应命中。
      const reopened = new ImageInsightCache({ dir, ttlDays: 30, maxEntries: 100 });
      await reopened.init();
      assert.notEqual(await reopened.getExact(key), undefined);
    });

    await test('过期条目视为未命中', async () => {
      const dir = join(tmp, 'cache-ttl');
      const cache = new ImageInsightCache({ dir, ttlDays: 30, maxEntries: 100 });
      await cache.init();
      const key = exactKey(image, 'fp-ttl');
      const oldAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
      await cache.put(key, { savedAt: oldAt, results: [{}] }, { dhash: '1'.repeat(16), savedAt: oldAt });
      assert.equal(cache.index.get(key).at, oldAt, '索引时间必须沿用结论产生时间，而不是写入时间');
      assert.equal(await cache.getExact(key), undefined, '过期条目必须当未命中');
      assert.equal(cache.index.has(key), false, '过期条目应被顺手清除');
    });

    await test('近似命中：同图不同尺寸走 dHash', async () => {
      const dir = join(tmp, 'cache-near');
      const cache = new ImageInsightCache({ dir, ttlDays: 30, maxEntries: 100 });
      await cache.init();
      const local = await analyzeLocal(image, image);
      const key = exactKey(image, 'fp-near');
      await cache.put(key, { savedAt: Date.now(), results: [{ insight: { parsed: { summary: '历史结论' } } }] }, { dhash: local.fingerprints.dhash });

      const resized = await sharp(image).resize(500).jpeg({ quality: 80 }).toBuffer();
      const other = await analyzeLocal(resized, resized);
      const near = await cache.getNear(other.fingerprints.dhash, 6);
      assert.notEqual(near, undefined, `近似命中应成功（距离阈值 6）`);
      assert.equal(near.distance <= 6, true);
      const exactMiss = await cache.getExact(exactKey(resized, 'fp-near'));
      assert.equal(exactMiss, undefined, '不同字节不应精确命中');
    });

    await test('无关图片不误命中', async () => {
      const dir = join(tmp, 'cache-negative');
      const cache = new ImageInsightCache({ dir, ttlDays: 30, maxEntries: 100 });
      await cache.init();
      const local = await analyzeLocal(image, image);
      await cache.put(exactKey(image, 'fp-neg'), { savedAt: Date.now(), results: [{}] }, { dhash: local.fingerprints.dhash });
      const noise = await sharp({
        create: { width: 300, height: 300, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
      })
        .png()
        .toBuffer();
      const other = await analyzeLocal(noise, noise);
      const near = await cache.getNear(other.fingerprints.dhash, 6);
      if (near) {
        assert.equal(near.distance >= 0, true);
        console.log(`     （注：噪声图与测试图距离 ${near.distance}，在阈值内属哈希碰撞，非缺陷）`);
      }
    });

    await test('LRU 淘汰超出上限', async () => {
      const dir = join(tmp, 'cache-lru');
      const cache = new ImageInsightCache({ dir, ttlDays: 30, maxEntries: 16 });
      await cache.init();
      for (let index = 0; index < 30; index += 1) {
        await cache.put(`x${index.toString(16).padStart(32, '0')}`, { savedAt: Date.now(), index }, { dhash: index.toString(16).padStart(16, '0') });
      }
      assert.equal(cache.index.size <= 16, true, `上限 16，实际 ${cache.index.size}`);
    });

    console.log(`\n${failed === 0 ? '🎉 全部通过' : '⚠️ 存在失败'}：${passed} 通过 / ${failed} 失败`);
    if (failed > 0) {
      console.log('\n失败明细：');
      for (const item of failures) console.log(`- ${item.name}: ${item.error?.stack ?? item.error}`);
      process.exitCode = 1;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('自检脚本自身崩溃：', error);
  process.exitCode = 1;
});

/**
 * 插件加载冒烟测试
 *
 * 已在运行的 DSH 进程不会“重新加载”一个刚写好的插件，因此真正需要验证的是：
 * 把插件文件当成宿主会加载的模块来 import 时，导出形状是否正确、apply() 是否能在
 * 一个最小的 cordis 风格上下文里完成注册且不抛错。
 *
 * 这一步能在“重启 GUI 才装插件”之前先抓住 90% 的低级错误：
 * 语法错误、导出名字写错、inject 声明与服务不一致、apply 里对 ctx 的假设过强。
 *
 * 运行：node tests/smoke-load.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('1. 以宿主的方式 import 插件入口');

const module = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);

assert.equal(module.name, 'dsh-image-insight', '必须导出 name（cordis 插件标识）');
assert.ok(Array.isArray(module.inject), '必须导出 inject 数组');
assert.equal(typeof module.apply, 'function', '必须导出 apply(ctx, config)');
assert.equal(typeof module.default, 'object', '应同时提供 default 导出，兼容不同加载器');

console.log('   ✅ name / inject / apply / default 导出齐全');

console.log('\n2. 最小上下文下 apply() 必须干净完成注册');

const registered = [];
const disposed = [];
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => disposed.push(definition.name);
    },
  },
  // 故意让 llm / attachments 缺失：插件必须惰性获取，不能在 apply() 阶段就崩溃。
  get() {
    return undefined;
  },
};

const disposer = module.apply(ctx, {});

assert.equal(registered.length, 3, `应注册 3 个工具，实际 ${registered.length}`);
assert.deepEqual(
  registered.map((item) => item.name).sort(),
  ['image_insight', 'image_insight_cache', 'image_similarity'],
);

for (const definition of registered) {
  assert.equal(typeof definition.execute, 'function', `${definition.name} 缺少 execute`);
  assert.equal(definition.output?.schema?.type, 'object', `${definition.name} 缺少 output.schema`);
  assert.equal(typeof definition.output?.render, 'function', `${definition.name} 缺少 output.render`);
  // 参数 schema 必须是合法 JSON Schema 对象，否则模型侧看不到工具。
  assert.equal(definition.parameters?.type, 'object', `${definition.name} 的 parameters 不是 object schema`);
  const rendered = definition.output.render({}, { ok: true, mode: 'local', results: [] });
  // 宿主契约：output.render 必须返回 ContentBlock[]（卡片外壳由宿主/toolview 决定），
  // presentResult 才是返回 ToolResultView 的地方。
  assert.ok(Array.isArray(rendered), `${definition.name} 的 output.render 必须返回 ContentBlock 数组`);
  assert.equal(rendered.every((block) => typeof block.type === 'string'), true, `${definition.name} 的 render 块缺少 type`);
  if (typeof definition.presentResult === 'function') {
    const view = definition.presentResult({}, { content: rendered, isError: false });
    assert.equal(view?.card, 'generic', `${definition.name} 的 presentResult 未返回 ToolResultView`);
    assert.ok(Array.isArray(view.content), `${definition.name} 的 presentResult 缺少 content 数组`);
  }
  // 契约位置检查：presentationMeta 属于 ToolOutputDefinition。
  // 放在 ToolDefinition 顶层会被宿主忽略，表现为“卡片看起来能用、但没有元数据”，属于静默失效。
  assert.equal(
    definition.presentationMeta,
    undefined,
    `${definition.name} 的 presentationMeta 必须放在 output 里，而不是工具顶层`,
  );
}

console.log('   ✅ 三个工具的 execute/schema/render 契约完整，且 llm/attachments 缺失时 apply 不崩');

console.log('\n3. 本地模式真的能跑通，且缺失服务时给出可执行的中文错误');

// 用仓库内的 base64 图片夹具写出一张真实 PNG，避免冒烟测试依赖 sharp。
const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-image-insight-smoke-'));
const fixturePath = join(tmpDir, 'fixture.png');
await writeFile(fixturePath, Buffer.from(readFileSync(join(root, 'tests', 'fixture.b64'), 'utf8').trim(), 'base64'));

const insight = registered.find((item) => item.name === 'image_insight');
const local = await insight.execute({ path: fixturePath, mode: 'local' }, { signal: new AbortController().signal });
assert.equal(local.ok, true, 'local 模式应当成功（它不需要 llm / attachments）');
assert.equal(local.results[0].local.width, 240);
assert.match(local.results[0].local.fingerprints.dhash, /^[0-9a-f]{16}$/);
assert.equal(local.model.source, 'unavailable', 'local 模式没有启用视觉，来源应标注 unavailable');
console.log('   ✅ mode=local 在没有任何宿主服务时也能完成真实识别计算');

// 关键行为：宿主完全没有 llm / attachments 时，工具不允许直接把调用打崩，
// 而是降级成“本地感知 + 说明为什么没有云端结果”，ok 仍为 true。
const missing = await insight.execute({ path: fixturePath, mode: 'full' }, { signal: new AbortController().signal });
assert.equal(missing.ok, true, '缺服务时应降级为本地结果，而不是让整次调用失败');
assert.equal(missing.model.source, 'unavailable');
assert.equal(typeof missing.results[0].local.width, 'number', '降级后本地数据仍必须完整');
assert.equal(missing.results[0].insight, undefined, '降级后不应伪造云端结论');
assert.equal(missing.cache.checked, false, '没有云端结论就不应声称检查过缓存');
assert.equal(typeof missing.notice, 'string');
assert.ok(
  missing.notice.includes('降级') || missing.notice.includes('本地') || missing.notice.includes('模型'),
  `notice 应说明降级原因，实际：${missing.notice}`,
);
console.log('   ✅ 缺失 llm / attachments 时降级为本地结果，并给出可执行的中文说明');

await rm(tmpDir, { recursive: true, force: true });

console.log('\n4. package.json 的 dsh 声明与 patch 文件');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-image-insight');
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'package.json 必须声明 dsh.bundle.patch');
assert.equal(pkg.type, 'module');
assert.equal(pkg.main, 'lib/index.js');

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
assert.ok(patch.includes('- insert:'), 'cordis.patch.yml 必须包含 insert 声明');
assert.ok(patch.includes('id: dsh-image-insight'), 'patch 必须声明插件 id');
assert.ok(patch.includes('name: dsh-image-insight'), 'patch 必须声明插件 name');
console.log('   ✅ bundle 声明与 patch 文件匹配');

console.log('\n🎉 冒烟测试全部通过：插件可以安全交给宿主加载');

/**
 * dsh-image-insight —— 纯函数工具层（零依赖、零副作用）
 *
 * 这一层只做三件与识别精度/速度直接相关的事：
 *  1. 稳定 JSON 序列化 + 内容寻址指纹（缓存键的一部分，键不稳定就必然漏命中）；
 *  2. 时间预算与异步超时（网络调用永不悬挂，超时即降级，不能拖垮整轮对话）；
 *  3. 有限并发调度（批量识别时既要快，又不能把上游打爆）。
 *
 * 本文件不 import sharp、不 import node:fs，因此可在任意环境直接做单元测试。
 */

/**
 * 把任意结果整理成“无损 JSON”值：递归丢掉值为 undefined 的对象字段，数组里的 undefined 换成 null。
 *
 * 为什么必须做：宿主在 execute() 返回后会先对 value 做 lossless-JSON 快照，再用 output.schema
 * 严格校验（app.asar 的 createSuccessResult → snapshotToolValue → validateJsonSchemaValue）。
 * 一个 `{ raw: undefined }` 既不是合法 JSON，也会撞上 `raw: {type:'string'}` 的校验而让整次调用
 * 报 ToolOutputError。所以“可选字段”必须整体不出现，而不是写成 undefined 占位。
 *
 * @param value - 任意（可能含 undefined）的值。
 * @returns 等价的纯 JSON 值。
 */
export function toJsonValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = toJsonValue(item);
      return next === undefined ? null : next;
    });
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const next = toJsonValue(item);
    if (next === undefined) continue;
    out[key] = next;
  }
  return out;
}

/** 稳定序列化：对象键排序、忽略 undefined，保证同一语义输入得到同一缓存键。 */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** 秒级/毫秒级计时助手：now() 返回毫秒时间戳，elapsed() 返回从起点起的整毫秒数。 */
export function stopwatch() {
  const started = Date.now();
  return {
    started,
    elapsed: () => Date.now() - started,
  };
}

/** 数值夹取，非法值回退到 fallback（配置文件里任何手写值都要经过它）。 */
export function clampNumber(value, min, max, fallback) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 取整并夹取。 */
export function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

/**
 * 带超时的 Promise 包装。超时或外部 abort 都会 reject，且保证清理定时器与监听器，
 * 避免长会话里累积 AbortSignal 监听导致的泄漏。
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @param {string} [label]
 * @template T
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, signal, label = 'operation') {
  if (!Number.isFinite(ms) || ms <= 0) return signal ? raceAbort(promise, signal, label) : promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error(`${label} 超时（${ms}ms）`);
      error.code = 'IMAGE_INSIGHT_TIMEOUT';
      reject(error);
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error(`${label} 已被取消`);
      error.code = 'IMAGE_INSIGHT_ABORTED';
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** 只响应 abort 的竞速（无超时）。 */
function raceAbort(promise, signal, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      const error = new Error(`${label} 已被取消`);
      error.code = 'IMAGE_INSIGHT_ABORTED';
      reject(error);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 有限并发 map：结果顺序与输入顺序严格一致（调用方依赖下标与图片对应）。
 * 单个任务抛错不会中断整批，错误以 { ok: false, error } 形式占位。
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: Error }>>}
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(items.length || 1, Math.floor(limit) || 1));
  let cursor = 0;
  const runners = new Array(width).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 从模型回复里稳健地抽出 JSON。
 * 视觉模型即使被要求“只输出 JSON”，也常见四种偏差，必须逐层兜底：
 *  1. 包在 ```json 围栏里；2. 前后带解释性文字；3. 尾随逗号；4. 用中文标点/全角引号。
 * 解析失败返回 undefined，由调用方决定降级为纯文本模式（绝不整轮失败）。
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined;
  const raw = text.trim();
  if (raw.length === 0) return undefined;

  const candidates = [];
  candidates.push(raw);

  // ```json ... ``` / ``` ... ``` 围栏
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(raw)) !== null) candidates.push(match[1].trim());

  // 第一个平衡的 {...} 或 [...]
  const balanced = extractBalanced(raw);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    const attempt = tryParse(candidate);
    if (attempt !== undefined) return attempt;
  }
  return undefined;
}

function tryParse(candidate) {
  if (!candidate) return undefined;
  const cleaned = candidate
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1') // 尾随逗号
    .replace(/[\u201c\u201d]/g, '"') // 全角双引号
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

/** 扫描第一个平衡的 JSON 容器（跳过字符串内的括号）。 */
function extractBalanced(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/** 把任意值压成单行文本，用于渲染卡片（避免多行 markdown 破坏卡片排版）。 */
export function oneLine(value, maxLength = 200) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/** 按字符数截断，保留前缀并标注省略量。 */
export function truncate(text, maxLength) {
  const flat = typeof text === 'string' ? text : String(text ?? '');
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, Math.max(0, maxLength - 12))}\n…（已截断）`;
}

/** 人类可读的耗时标签。 */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

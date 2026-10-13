/**
 * 宿主流水线模拟器 —— 让测试用“宿主的规则”而不是“我以为的规则”来验收工具。
 *
 * 起因（真实踩坑）：插件早期把 output.render 写成返回 {card, content} 视图对象，并让 execute()
 * 的返回值里带上 `undefined` 占位字段。自写的假宿主照单全收，测试全绿；但真实宿主在
 * app.asar 的 ToolRuntime 里做三件事，两处都会直接失败：
 *
 *   1. snapshotToolValue(candidate) —— 无损 JSON 快照，`{raw: undefined}` 不是无损 JSON；
 *   2. validateJsonSchemaValue(tool.output.schema, value) —— 严格按 schema 校验，undefined 不是 string；
 *   3. snapshotProjection(tool.output.render(args, value)) —— render 必须返回 ContentBlock[] 数组，
 *      否则报 “output.render returned … — it must return an ARRAY of content blocks”。
 *
 * 这个文件把这三步复刻出来，供所有测试共用：任何工具调用都走 runHostPipeline()，
 * 契约错了就在测试里炸，而不是在用户界面里静默空白。
 */

/**
 * 最小 JSON Schema 校验器：覆盖本仓库 schema 用到的关键字
 * （type/properties/required/items/enum/additionalProperties）。
 *
 * @param schema - JsonSchemaNode 子集。
 * @param value - 待校验的值。
 * @returns 违规说明数组，空数组表示通过。
 */
export function validateJsonSchema(schema, value, path = 'value', errors = []) {
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
      (type === 'integer' && Number.isInteger(value)) ||
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
      validateJsonSchema(child, value[key], `${path}.${key}`, errors);
    }
  }

  if (type === 'array' && schema.items) {
    value.forEach((item, index) => validateJsonSchema(schema.items, item, `${path}[${index}]`, errors));
  }
  return errors;
}

/**
 * 复刻 snapshotToolValue：无损 JSON 快照。
 * 判定“无损”的方式与宿主一致——值经 JSON 序列化/反序列化后必须与原值语义等价，
 * 任何 undefined / 函数 / Symbol / 循环引用都要被拒绝。
 *
 * @param toolName - 工具名，用于报错信息。
 * @param candidate - execute() 的返回值。
 * @returns 快照后的值。
 */
export function snapshotToolValue(toolName, candidate) {
  if (candidate === undefined) throw new Error(`[${toolName}] value is not lossless JSON`);
  let json;
  try {
    json = JSON.stringify(candidate);
  } catch (error) {
    throw new Error(`[${toolName}] value snapshot failed: ${error.message}`);
  }
  if (json === undefined) throw new Error(`[${toolName}] value is not lossless JSON`);
  const detached = JSON.parse(json);
  const diff = firstLossyDifference(candidate, detached, 'value');
  if (diff) throw new Error(`[${toolName}] value is not lossless JSON → ${diff}`);
  return detached;
}

/** 找出第一处“快照后变了”的位置（undefined 字段、NaN、Date 之类）。 */
function firstLossyDifference(original, snapshot, path) {
  if (original === null || typeof original !== 'object') {
    if (typeof original === 'undefined') return `${path} 是 undefined（JSON 会丢弃它，宿主会判为非无损 JSON）`;
    if (typeof original === 'number' && Number.isNaN(original)) return `${path} 是 NaN（JSON 会写成 null）`;
    if (typeof original === 'function' || typeof original === 'symbol') return `${path} 是 ${typeof original}（不是 JSON 值）`;
    return undefined;
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(snapshot) || snapshot.length !== original.length) return `${path} 数组长度在快照后变了`;
    for (const [index, item] of original.entries()) {
      const found = firstLossyDifference(item, snapshot[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(original)) {
    if (typeof item === 'undefined') return `${path}.${key} 是 undefined（JSON 会丢弃它，宿主会判为非无损 JSON）`;
    if (!(key in snapshot)) return `${path}.${key} 在快照后消失了`;
    const found = firstLossyDifference(item, snapshot[key], `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

/** 递归冻结，模拟宿主 deepFreeze（render/presentationMeta 拿到的是冻结值，不能就地改）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

/** ContentBlock 判定：宿主用 isContentBlockShape 检查，这里按其要点实现。 */
function isContentBlockShape(block) {
  return (
    block !== null &&
    typeof block === 'object' &&
    typeof block.type === 'string' &&
    (block.type === 'text' ? typeof block.text === 'string' : true)
  );
}

/**
 * 完整复刻宿主一次成功调用的尾部流水线：
 *   execute → 无损 JSON 快照 → schema 严格校验 → deepFreeze → render（必须是 ContentBlock[]）
 *   → presentCall/presentResult（必须是 ToolResultView）→ ToolResult
 *
 * @param definition - 工具定义（ToolDefinition）。
 * @param args - 工具参数。
 * @param exec - ToolRunContext（至少要带 signal）。
 * @returns { value, content, result, view, callView }
 */
export async function runHostPipeline(definition, args, exec = { signal: new AbortController().signal }) {
  const toolName = definition.name;
  const raw = await definition.execute(args, exec);
  const value = snapshotToolValue(toolName, raw);

  const violations = validateJsonSchema(definition.output.schema, value);
  if (violations.length > 0) {
    throw new Error(`[${toolName}] output schema 校验失败：\n  - ${violations.join('\n  - ')}`);
  }

  const frozen = deepFreeze(value);
  let rendered;
  try {
    rendered = definition.output.render(args, frozen);
  } catch (error) {
    throw new Error(`[${toolName}] output.render 抛出异常：${error.message}`);
  }
  if (!Array.isArray(rendered) || !rendered.every(isContentBlockShape)) {
    throw new Error(
      `[${toolName}] output.render 必须返回 ContentBlock 数组，实际是 ${
        Array.isArray(rendered) ? '含非法元素' : typeof rendered
      }。宿主会报：it must return an ARRAY of content blocks`,
    );
  }

  const content = JSON.parse(JSON.stringify(rendered));
  const result = { content, isError: false };
  if (definition.output.presentationMeta) {
    const meta = definition.output.presentationMeta(args, frozen);
    if (meta !== undefined) result.meta = JSON.parse(JSON.stringify(meta));
  }
  const view = definition.presentResult ? definition.presentResult(args, result) : undefined;
  if (definition.presentResult) {
    if (!view || typeof view !== 'object' || typeof view.card !== 'string') {
      throw new Error(`[${toolName}] presentResult 必须返回 ToolResultView（含 card 字段）`);
    }
    if (view.content !== undefined && !(Array.isArray(view.content) && view.content.every(isContentBlockShape))) {
      throw new Error(`[${toolName}] presentResult.content 必须是 ContentBlock[]`);
    }
  }
  const callView = definition.presentCall ? definition.presentCall(args) : undefined;
  return { value, content, result, view, callView };
}

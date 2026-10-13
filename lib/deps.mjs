/**
 * dsh-image-insight —— 原生依赖（sharp）加载器
 *
 * 为什么需要这个文件：sharp 带预编译原生二进制，插件在「profile 的 node_modules 里」
 * 与「工作区里开发的插件目录里」被加载时，Node 的解析起点不同。直接 `import('sharp')`
 * 在工作区内会失败，而 sharp 恰恰已经随 DSH profile 装好了。
 *
 * 因此这里按四级顺序解析，任何一级命中即可，全部失败才抛出带指引的错误：
 *   1. 常规 import('sharp')（插件被安装进 profile 时走这条）
 *   2. $DSH_HOME/profiles/<name>/node_modules/sharp
 *   3. 各 profile 目录的通配搜索
 *   4. cwd 向上找 node_modules/sharp
 *
 * 只做路径拼接，不下载、不安装、不执行任何外部命令——插件绝不能偷偷改用户环境。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

let cached;
let cachedError;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function profilesRoot() {
  return process.env.DSH_PROFILES_DIR || join(dshHome(), 'profiles');
}

/** 逐个候选目录尝试 require.resolve；命中返回可 import 的 URL。 */
function resolveCandidates(packageName) {
  const candidates = [];
  try {
    candidates.push(require.resolve(`${packageName}/package.json`));
  } catch {
    // 常规解析失败：继续找 profile 副本。
  }

  const roots = [];
  if (process.env.DSH_PROFILE) roots.push(join(profilesRoot(), process.env.DSH_PROFILE, 'node_modules'));
  try {
    for (const entry of readdirSync(profilesRoot(), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(profilesRoot(), entry.name, 'node_modules'));
    }
  } catch {
    // profiles 目录不存在：忽略。
  }

  // cwd 向上找，覆盖“在工作区里 link 开发”的场景。
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    roots.push(join(current, 'node_modules'));
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }

  for (const root of roots) {
    const manifest = join(root, packageName, 'package.json');
    if (existsSync(manifest)) candidates.push(manifest);
  }
  return [...new Set(candidates)];
}

/**
 * 加载一个依赖包。
 * @param {string} packageName
 * @returns {Promise<unknown>} 模块的默认导出（ESM/CJS 都归一）
 */
export async function loadDependency(packageName) {
  if (cached && cached.name === packageName) return cached.module;
  if (cachedError && cachedError.name === packageName) throw cachedError;

  const candidates = resolveCandidates(packageName);
  const problems = [];
  for (const manifest of candidates) {
    const packageRoot = manifest.slice(0, -'/package.json'.length);
    for (const entry of entryFilesFor(packageRoot, manifest)) {
      try {
        const imported = await import(pathToFileURL(entry).href);
        const module = imported?.default ?? imported;
        cached = { name: packageName, module };
        return module;
      } catch (error) {
        problems.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const error = new Error(
    `无法加载依赖 "${packageName}"。这不是插件缺陷：请确认它已装在当前 DSH profile 下（例如 ` +
      `${join(profilesRoot(), '<profile>', 'node_modules', packageName)}），或在插件目录执行 pnpm install。` +
      `已尝试：${problems.join(' | ') || '无候选路径'}`,
  );
  error.code = 'IMAGE_INSIGHT_DEPENDENCY_MISSING';
  cachedError = { name: packageName, error };
  throw error;
}

/**
 * 从一个包根目录推导可 import 的入口文件。
 * 原生包（如 sharp）的入口常按条件导出分发，这里按 ESM 优先级依次尝试：
 * exports['.'] → exports（字符串形式）→ exports['.'].require/import/default → main → index.js。
 */
function entryFilesFor(packageRoot, manifest) {
  const entries = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    pkg = undefined;
  }

  const pushRelative = (relative) => {
    if (typeof relative !== 'string' || relative === '') return;
    const path = resolve(packageRoot, relative.replace(/^\.\//, ''));
    if (existsSync(path)) entries.push(path);
  };

  if (pkg) {
    const exports = pkg.exports;
    if (typeof exports === 'string') pushRelative(exports);
    else if (exports && typeof exports === 'object') {
      const root = exports['.'] ?? exports;
      if (typeof root === 'string') pushRelative(root);
      else if (root && typeof root === 'object') {
        for (const condition of ['require', 'node', 'import', 'default']) {
          if (typeof root[condition] === 'string') pushRelative(root[condition]);
        }
      }
    }
    pushRelative(pkg.main);
  }
  // 最后兜底：Node 对目录 import 会读 package.json 的 main / index.js。
  if (existsSync(join(packageRoot, 'index.js'))) entries.push(join(packageRoot, 'index.js'));
  entries.push(packageRoot);
  return [...new Set(entries)];
}

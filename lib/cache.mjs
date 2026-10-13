/**
 * dsh-image-insight —— 双层缓存
 *
 * “反应要迅速”的第一来源不是更快的模型，而是不出网。
 * 本模块提供两级本地命中：
 *
 *  第 1 级 精确指纹命中：sha256(原图字节) + 请求参数指纹 → 直接返回历史结论。
 *          典型耗时 < 5ms，且天然抗“同一张图反复问”的重复付费。
 *  第 2 级 感知哈希命中：dHash(64bit) 汉明距离 ≤ 阈值 → 同图不同压缩/缩放/轻微裁剪
 *          也命中，并如实标注 distance，绝不把“相似”伪装成“精确”。
 *
 * 目录布局（全部落在 <cacheDir> 内）：
 *   index.json                     精确指纹索引（key → {file, bytes, at, costMs, preview}）
 *   hash-index.json                dHash 索引（dhash → [key…]）
 *   entries/<ab>/<key>.json        结论正文
 *
 * 设计取舍：索引常驻内存（默认上限 2000 条，约几百 KB），条目正文只在命中时读盘，
 * 因此冷启动零扫描、热路径零遍历目录。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const INDEX_VERSION = 1;

/** 短哈希：取 sha256 前 32 位十六进制，足够避免内容寻址冲突，又便于人眼排查。 */
function shortHash(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

export function exactKey(bytes, requestFingerprint) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return `x${shortHash(`${digest}|${requestFingerprint}`)}`;
}

export class ImageInsightCache {
  /**
   * @param {{ dir: string, ttlDays?: number, maxEntries?: number }} options
   */
  constructor(options) {
    this.dir = options.dir;
    this.ttlMs = Math.max(0, (options.ttlDays ?? 30)) * 24 * 60 * 60 * 1000;
    this.maxEntries = Math.max(16, options.maxEntries ?? 2000);
    /** @type {Map<string, {file: string, bytes: number, at: number, costMs: number, label?: string}>} */
    this.index = new Map();
    /** @type {Map<string, Set<string>>} */
    this.hashIndex = new Map();
    this.ready = null;
    this.hits = { exact: 0, near: 0, miss: 0 };
  }

  /** 幂等初始化：只读一次索引，重复调用复用同一个 Promise。 */
  init() {
    if (!this.ready) this.ready = this.#load().catch(() => this.#resetSilently());
    return this.ready;
  }

  async #resetSilently() {
    this.index.clear();
    this.hashIndex.clear();
  }

  async #load() {
    await mkdir(join(this.dir, 'entries'), { recursive: true });
    await this.#loadIndexFile('index.json', (data) => {
      if (data && data.version === INDEX_VERSION && data.entries) {
        for (const [key, entry] of Object.entries(data.entries)) {
          if (entry && typeof entry.file === 'string') this.index.set(key, entry);
        }
      }
    });
    await this.#loadIndexFile('hash-index.json', (data) => {
      if (data && data.version === INDEX_VERSION && data.hashes) {
        for (const [hash, keys] of Object.entries(data.hashes)) {
          if (Array.isArray(keys) && keys.length > 0) this.hashIndex.set(hash, new Set(keys));
        }
      }
    });
  }

  async #loadIndexFile(name, apply) {
    try {
      const text = await readFile(join(this.dir, name), 'utf8');
      apply(JSON.parse(text));
    } catch {
      // 索引缺失/损坏都视为空索引：缓存是纯加速层，绝不能因它失败而阻断识别。
    }
  }

  /**
   * 精确命中查询。过期条目视为未命中并顺手清除。
   * @param {string} key
   */
  async getExact(key) {
    const entry = this.index.get(key);
    if (!entry) {
      this.hits.miss += 1;
      return undefined;
    }
    if (this.#expired(entry)) {
      await this.delete(key);
      this.hits.miss += 1;
      return undefined;
    }
    try {
      const payload = JSON.parse(await readFile(this.#entryPath(key), 'utf8'));
      this.hits.exact += 1;
      this.#touch(entry);
      return payload;
    } catch {
      await this.delete(key);
      this.hits.miss += 1;
      return undefined;
    }
  }

  /**
   * 感知哈希近似查询：在索引里找汉明距离最近的一条。
   * @param {string} dhash 16 位十六进制（64bit）
   * @param {number} maxDistance
   * @returns {Promise<{ key: string, distance: number, payload: unknown } | undefined>}
   */
  async getNear(dhash, maxDistance) {
    if (!dhash || this.hashIndex.size === 0) return undefined;
    const target = BigInt(`0x${dhash}`);
    let best;
    for (const [candidate] of this.hashIndex) {
      const distance = hammingDistance64(target, BigInt(`0x${candidate}`));
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = { hash: candidate, distance };
        if (distance === 0) break;
      }
    }
    if (!best) return undefined;
    const keys = this.hashIndex.get(best.hash);
    if (!keys) return undefined;
    for (const key of keys) {
      const entry = this.index.get(key);
      if (!entry || this.#expired(entry)) continue;
      try {
        const payload = JSON.parse(await readFile(this.#entryPath(key), 'utf8'));
        this.hits.near += 1;
        return { key, distance: best.distance, payload };
      } catch {
        await this.delete(key);
      }
    }
    return undefined;
  }

  /**
   * 写入一条结论。
   * @param {string} key
   * @param {unknown} payload
   * @param {{ dhash?: string, ahash?: string, sha256?: string, bytes?: number, costMs?: number, label?: string, savedAt?: number, summary?: string }} [meta]
   *   savedAt 允许调用方注入时间戳（测试与回填历史数据用）；缺省取当前时间。
   *   dhash/ahash/sha256/summary 一并写进索引：相似图检索因此只需读内存，
   *   不必为每条索引打开一次条目文件（索引 2000 条时这是 2000 次磁盘读的差别）。
   */
  async put(key, payload, meta = {}) {
    await this.init();
    const file = this.#entryPath(key);
    const text = JSON.stringify(payload);
    await mkdir(join(this.dir, 'entries', key.slice(1, 3)), { recursive: true });
    await writeFile(file, text, 'utf8');
    const entry = {
      file,
      bytes: meta.bytes ?? Buffer.byteLength(text, 'utf8'),
      // 索引里的 at 必须反映“结论何时产生”，否则 TTL 判断会被写入时刻掩盖。
      at: typeof meta.savedAt === 'number' ? meta.savedAt : Date.now(),
      costMs: meta.costMs ?? 0,
      label: meta.label,
      dhash: meta.dhash,
      ahash: meta.ahash,
      sha256: meta.sha256,
      summary: meta.summary,
      hits: 0,
    };
    this.index.set(key, entry);
    if (meta.dhash) {
      const bucket = this.hashIndex.get(meta.dhash) ?? new Set();
      bucket.add(key);
      this.hashIndex.set(meta.dhash, bucket);
    }
    await this.#persist();
    await this.#prune();
    return entry;
  }

  async delete(key) {
    const entry = this.index.get(key);
    this.index.delete(key);
    for (const [hash, keys] of this.hashIndex) {
      keys.delete(key);
      if (keys.size === 0) this.hashIndex.delete(hash);
    }
    if (entry) {
      try {
        await unlink(this.#entryPath(key));
      } catch {
        // 文件可能已被外部清理；索引已更新即可。
      }
    }
  }

  /**
   * 读取一条索引条目（不读条目文件，指纹/摘要等元数据都在内存索引里）。
   * @param {string} key
   */
  entry(key) {
    return this.index.get(key);
  }

  /**
   * 遍历索引条目。用于相似图检索等只需要元数据的场景。
   * @returns {IterableIterator<[string, {dhash?: string, ahash?: string, sha256?: string, label?: string, summary?: string, at: number, file: string}]>}
   */
  entries() {
    return this.index.entries();
  }

  /** 统计信息，用于工具输出里的 cacheInfo（让“为什么快”可解释）。 */
  stats() {
    return {
      entries: this.index.size,
      hashes: this.hashIndex.size,
      hits: { ...this.hits },
      dir: this.dir,
    };
  }

  #entryPath(key) {
    return join(this.dir, 'entries', key.slice(1, 3), `${key}.json`);
  }

  #expired(entry) {
    return this.ttlMs > 0 && Date.now() - entry.at > this.ttlMs;
  }

  #touch(entry) {
    entry.at = Date.now();
    entry.hits = (entry.hits ?? 0) + 1;
  }

  /** 原子落盘：先写 .tmp 再 rename 语义（这里用 writeFile 覆盖，索引本身可重建）。 */
  async #persist() {
    try {
      const entries = {};
      for (const [key, entry] of this.index) entries[key] = entry;
      await writeFile(
        join(this.dir, 'index.json'),
        JSON.stringify({ version: INDEX_VERSION, entries }),
        'utf8',
      );
      const hashes = {};
      for (const [hash, keys] of this.hashIndex) hashes[hash] = [...keys];
      await writeFile(
        join(this.dir, 'hash-index.json'),
        JSON.stringify({ version: INDEX_VERSION, hashes }),
        'utf8',
      );
    } catch {
      // 索引写失败只影响下次冷启动，不影响本次结果。
    }
  }

  /** LRU 淘汰：按最后访问时间倒序保留 maxEntries 条。 */
  async #prune() {
    if (this.index.size <= this.maxEntries) return;
    const ordered = [...this.index.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    const overflow = this.index.size - this.maxEntries;
    for (let index = 0; index < overflow; index += 1) {
      const [key] = ordered[index];
      await this.delete(key);
    }
    await this.#persist();
  }
}

/** 64bit 汉明距离。 */
export function hammingDistance64(a, b) {
  let value = a ^ b;
  let count = 0;
  while (value > 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

/**
 * 清理缓存目录：删除孤立条目文件（索引里没有的）与过期条目。
 * 供 image_insight_cache 工具的 maintenance 动作使用。
 * @param {ImageInsightCache} cache
 * @param {{ ttlDays?: number }} [options]
 */
export async function garbageCollect(cache, options = {}) {
  await cache.init();
  const report = { removedEntries: 0, removedFiles: 0, orphanFiles: 0 };
  const ttlMs = options.ttlDays === undefined ? cache.ttlMs : options.ttlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [key, entry] of [...cache.index]) {
    if (ttlMs > 0 && now - entry.at > ttlMs) {
      await cache.delete(key);
      report.removedEntries += 1;
    }
  }
  const entriesDir = join(cache.dir, 'entries');
  let shards = [];
  try {
    shards = await readdir(entriesDir);
  } catch {
    return report;
  }
  const known = new Set([...cache.index.keys()].map((key) => `${key}.json`));
  for (const shard of shards) {
    const shardDir = join(entriesDir, shard);
    let files = [];
    try {
      files = await readdir(shardDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (known.has(file)) continue;
      try {
        await unlink(join(shardDir, file));
        report.removedFiles += 1;
        report.orphanFiles += 1;
      } catch {
        // 忽略并发删除竞态。
      }
    }
  }
  return report;
}

/** 目录体积（字节），用于维护报告。 */
export async function cacheSize(cache) {
  let total = 0;
  try {
    const shards = await readdir(join(cache.dir, 'entries'));
    for (const shard of shards) {
      const shardDir = join(cache.dir, 'entries', shard);
      let files = [];
      try {
        files = await readdir(shardDir);
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          total += (await stat(join(shardDir, file))).size;
        } catch {
          // 忽略。
        }
      }
    }
  } catch {
    // 目录尚不存在。
  }
  return total;
}

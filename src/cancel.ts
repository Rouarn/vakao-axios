import type { AxiosRequestConfig } from 'axios';

interface FormDataWithEntries extends FormData {
  entries(): IterableIterator<[string, string | Blob]>;
}

/**
 * 稳定序列化
 * - 按对象 key 排序，确保等价对象得到一致字符串
 * - 用于生成请求唯一 key（method/url/params/data）
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toJSON());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object URLSearchParams]') {
    const entries = Array.from((value as URLSearchParams).entries()).sort((a, b) => {
      if (a[0] === b[0]) return a[1] > b[1] ? 1 : a[1] < b[1] ? -1 : 0;
      return a[0] > b[0] ? 1 : -1;
    });
    return stableStringify(entries);
  }
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    // 检查 entries 是否存在 (部分环境可能不完全支持)
    if (typeof (value as unknown as { entries: unknown }).entries !== 'function') {
      return 'FormData';
    }
    const rawEntries = Array.from((value as FormDataWithEntries).entries());
    const entries = rawEntries
      .map(([k, v]) => {
        if (v instanceof Blob) {
          const name = (v as File).name || '';
          return [String(k), { name, size: v.size, type: v.type }];
        }
        return [String(k), v];
      })
      .sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0));
    return stableStringify(entries);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

type PendingConfig = AxiosRequestConfig & {
  requestKey?: string;
  /** 内部字段：本请求独占的 AbortController，与去重登记解耦，便于 cancelAll 覆盖未进拦截器的请求 */
  __controller?: AbortController;
};

/**
 * 重复请求取消处理器
 * 基于 AbortController 维护 pending 请求，同 key 后发请求取消先前请求
 *
 * 两级登记：
 * - activeControllers：请求一发出就登记（早于请求拦截器），cancelAll 依赖它覆盖
 *   尚未进入拦截器、以及 dedupe: false 而不会进 pendingMap 的请求
 * - pendingMap：请求进入拦截器且开启去重后才登记，仅用于同 key 互斥
 */
export class CancelHandler {
  private pendingMap: Map<string, AbortController> = new Map();

  /** 所有已发出且尚未结束的请求控制器 */
  private activeControllers: Set<AbortController> = new Set();

  /**
   * 生成请求的唯一 Key
   */
  getRequestKey(config: PendingConfig): string {
    if (config.requestKey) return config.requestKey;
    return [config.method, config.url, stableStringify(config.params), stableStringify(config.data)].join('&');
  }

  /**
   * 请求发出时登记控制器
   *
   * 复用 config 上已有的控制器，保证去重与 cancelAll 操作的是同一个 signal；
   * 放在拦截器之前调用，才能覆盖「已发出但还没进拦截器」的请求。
   */
  track(config: PendingConfig): AbortController {
    let controller = config.__controller;
    if (!controller) {
      controller = new AbortController();
      config.__controller = controller;
      config.signal = controller.signal;
    }
    this.activeControllers.add(controller);
    return controller;
  }

  /**
   * 将请求加入挂起映射（同 key 旧请求会被取消）
   */
  addPending(config: PendingConfig): void {
    this.removePending(config);
    const key = this.getRequestKey(config);
    this.pendingMap.set(key, this.track(config));
  }

  /**
   * 取消并移除挂起请求
   */
  removePending(config: PendingConfig): void {
    const key = this.getRequestKey(config);
    const controller = this.pendingMap.get(key);
    if (controller) {
      controller.abort();
      this.pendingMap.delete(key);
      this.activeControllers.delete(controller);
    }
  }

  /**
   * 请求结束：注销去重登记与活跃登记（正常返回、业务失败、取消都需调用）
   */
  release(config: PendingConfig): void {
    this.pendingMap.delete(this.getRequestKey(config));
    this.untrack(config);
  }

  /**
   * 仅注销活跃登记（未开启去重的请求结束时调用，省去生成去重 key）
   */
  untrack(config: PendingConfig): void {
    if (config.__controller) this.activeControllers.delete(config.__controller);
  }

  /**
   * 取消所有已发出的请求（含尚未进入拦截器、未开启去重的请求）
   */
  removeAllPending(): void {
    this.activeControllers.forEach((controller) => controller.abort());
    this.activeControllers.clear();
    this.pendingMap.clear();
  }
}

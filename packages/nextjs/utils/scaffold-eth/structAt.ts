/**
 * viem 对 Solidity struct getter 的返回是【位置数组】而非具名对象——
 * 具名访问会得到 undefined，Number(undefined)=NaN，再喂给 BigInt 直接 RangeError 崩掉整页。
 * 统一按位置映射成具名对象。
 */
export const structAt = <T extends object>(raw: unknown, keys: readonly (keyof T)[]): T | undefined => {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    return Object.fromEntries(keys.map((k, i) => [k, (raw as unknown[])[i]])) as T;
  }
  return raw as T;
};

/**
 * 供应商页纯函数（P1供应商增强：可单测，不依赖 Electron/store）。
 * 解析、过滤、计数逻辑集中于此，组件只负责渲染与 IPC。
 */

export function parseModels(text: string): string[] {
  return text
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseHeaders(text: string): Record<string, string> {
  const r: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf(':')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim()
    if (k) r[k] = v
  }
  return r
}

export function providerHost(url: string): string {
  try {
    const u = new URL(url)
    return u.host || url
  } catch {
    return url
  }
}

export function providerInitial(name: string): string {
  return (name || '?').trim().slice(0, 2).toUpperCase()
}

export function getModelKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

export function isModelHiddenByKeys(
  hiddenKeys: string[],
  providerId: string,
  model: string
): boolean {
  const key = getModelKey(providerId, model)
  return hiddenKeys.includes(key) || hiddenKeys.includes(model)
}

export function countVisibleModels(
  hiddenKeys: string[],
  providerId: string,
  models: string[]
): number {
  return models.filter((m) => !isModelHiddenByKeys(hiddenKeys, providerId, m)).length
}

export function filterModels(models: string[], query: string, onlySelected: boolean, hiddenKeys: string[], providerId: string): string[] {
  const q = query.trim().toLowerCase()
  let list = [...models]
  if (q) list = list.filter((m) => m.toLowerCase().includes(q))
  if (onlySelected) list = list.filter((m) => !isModelHiddenByKeys(hiddenKeys, providerId, m))
  return list
}

export function isFreeModel(model: string): boolean {
  return model.toLowerCase().includes('free')
}

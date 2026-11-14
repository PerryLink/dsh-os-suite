/**
 * Pure core logic for dsh-os-NAME.
 * No @deepseek-ai imports here: testable with `node --test`.
 */

/**
 * @typedef {object} Item
 * @property {string} id
 * @property {string} [parentId]
 */

/**
 * @param {Item[]} items
 * @returns {Map<string, Item[]>}
 */
export function childrenByParent(items) {
  /** @type {Map<string, Item[]>} */
  const out = new Map()
  for (const item of items) {
    const key = item.parentId ?? ''
    const list = out.get(key) ?? []
    list.push(item)
    out.set(key, list)
  }
  return out
}

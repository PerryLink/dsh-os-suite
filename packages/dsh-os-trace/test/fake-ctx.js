/**
 * Minimal fake Cordis context used by the offline tests.
 *
 * It implements the two surfaces this plugin touches: tool registration and
 * event subscription. `emit` dispatches to every handler registered for that
 * exact event name; wildcard patterns are stored as opaque names (Cordis has
 * no wildcard dispatch), so tests exercise the concrete subscriptions.
 *
 * @param {{ rejectEvents?: string[] }} [options]
 */
export function createFakeCtx(options = {}) {
  const rejected = new Set(options.rejectEvents ?? [])
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {any[]} */
  const definitions = []

  return {
    tools: {
      /**
       * @param {any} definition
       * @returns {() => void}
       */
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    /**
     * @param {string} eventName
     * @param {Function} handler
     * @returns {() => boolean}
     */
    on(eventName, handler) {
      if (rejected.has(eventName)) {
        throw new Error(`fake ctx rejects event "${eventName}"`)
      }
      const list = listeners.get(eventName) ?? []
      list.push(handler)
      listeners.set(eventName, list)
      let active = true
      return () => {
        if (!active) return false
        active = false
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
        return true
      }
    },
    /**
     * @param {string} eventName
     * @param {...unknown} args
     * @returns {unknown[]}
     */
    emit(eventName, ...args) {
      const list = [...(listeners.get(eventName) ?? [])]
      return list.map((handler) => handler(...args))
    },
    /** @param {string} eventName */
    handlers(eventName) {
      return [...(listeners.get(eventName) ?? [])]
    },
    eventNames() {
      return [...listeners.keys()]
    },
    definitions,
  }
}

/**
 * @param {any[]} definitions
 * @returns {Record<string, any>}
 */
export function toolsByName(definitions) {
  /** @type {Record<string, any>} */
  const tools = {}
  for (const definition of definitions) tools[definition.name] = definition
  return tools
}

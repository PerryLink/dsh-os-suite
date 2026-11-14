import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/index.js'

function setup() {
  /** @type {any[]} */
  const definitions = []
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx)
  /** @type {Record<string, any>} */
  const byName = {}
  for (const definition of definitions) byName[definition.name] = definition
  return { definitions, tools: byName }
}

test('apply registers the three service tools', () => {
  const { definitions, tools } = setup()
  assert.equal(name, 'dsh-os-registry')
  assert.deepEqual(inject, ['tools'])
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['service_register', 'service_list', 'service_stop'],
  )
  for (const definition of definitions) {
    assert.ok(definition.parameters)
    assert.ok(definition.output)
  }
})

test('service_register, service_list and service_stop share one registry', async () => {
  const { tools } = setup()

  const registered = await tools.service_register.execute({ name: 'web' }, {})
  assert.equal(registered.ok, true)
  assert.equal(registered.service.name, 'web')
  assert.equal(registered.service.owner, 'agent')
  assert.equal(registered.service.port, 4100)
  assert.equal(registered.service.health, 'unknown')

  const listed = await tools.service_list.execute({}, {})
  assert.equal(listed.ok, true)
  assert.equal(listed.services.length, 1)
  assert.equal(listed.services[0].id, registered.service.id)

  const filtered = await tools.service_list.execute({ owner: 'someone-else' }, {})
  assert.deepEqual(filtered.services, [])

  const stopped = await tools.service_stop.execute({ id: registered.service.id }, {})
  assert.equal(stopped.ok, true)
  assert.equal(stopped.released, true)

  const stoppedAgain = await tools.service_stop.execute({ id: registered.service.id }, {})
  assert.equal(stoppedAgain.ok, true)
  assert.equal(stoppedAgain.released, false)

  const empty = await tools.service_list.execute({}, {})
  assert.deepEqual(empty.services, [])
})

test('service_register reports core errors as structured failures', async () => {
  const { tools } = setup()

  const first = await tools.service_register.execute(
    { name: 'api', port: 5000, owner: 'agent-a', pid: 1234 },
    {},
  )
  assert.equal(first.ok, true)
  assert.equal(first.service.port, 5000)
  assert.equal(first.service.pid, 1234)

  const conflict = await tools.service_register.execute(
    { name: 'api-2', port: 5000, owner: 'agent-b' },
    {},
  )
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'PORT_IN_USE')

  const invalidTtl = await tools.service_register.execute(
    { name: 'docs', ttlMs: -1 },
    {},
  )
  assert.equal(invalidTtl.ok, false)
  assert.equal(invalidTtl.error.code, 'INVALID_TTL')
})

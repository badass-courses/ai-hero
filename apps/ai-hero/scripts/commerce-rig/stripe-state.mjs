// @ts-nocheck: untyped Node operator tooling, covered by rig.test.mjs; not app code.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertTestObject, privateWrite } from './safety.mjs'

export async function remember(state, run, kind, id) {
  const file = join(state, 'artifacts.json')
  const data = await readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return { run, objects: [] } })
  if (data.run !== run) throw new Error('Stripe journal belongs to another run')
  if (!data.objects.some(item => item.kind === kind && item.id === id)) data.objects.push({ kind, id })
  await privateWrite(file, JSON.stringify(data, null, 2) + '\n')
}
export async function archiveRun(stripe, state, run) {
  const data = await readFile(join(state, 'artifacts.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return { run, objects: [] } })
  if (data.run !== run) throw new Error('Stripe journal run mismatch')
  let archived = 0, expired = 0
  for (const kind of ['session', 'price', 'product']) {
    const service = kind === 'session' ? stripe.checkout.sessions : kind === 'price' ? stripe.prices : stripe.products
    // Reconcile lost create responses using exact run metadata; never clean another worker's run.
    if (service.list) {
      for await (const object of service.list({ limit: 100 })) {
        if (object.metadata?.rig === 'aihero-commerce' && object.metadata?.rig_run === run && !data.objects.some(item => item.kind === kind && item.id === object.id)) data.objects.push({ kind, id: object.id })
      }
    }
    for (const item of data.objects.filter(item => item.kind === kind)) {
      const object = assertTestObject(await service.retrieve(item.id))
      if (object.metadata?.rig !== 'aihero-commerce' || object.metadata?.rig_run !== run) throw new Error('Refusing to clean up an unowned Stripe object')
      if (kind === 'session') {
        if (object.status === 'open') { assertTestObject(await service.expire(item.id)); expired++ }
      } else if (object.active) { assertTestObject(await service.update(item.id, { active: false })); archived++ }
    }
  }
  return { archived, expired }
}

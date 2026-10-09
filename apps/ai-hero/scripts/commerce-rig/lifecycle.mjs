import { createMachine, createActor } from 'xstate'
// Command supervisor: down -> preparing -> starting -> running; failures fence retries.
export const lifecycle = createMachine({
  id: 'commerceRig', initial: 'down',
  states: {
    down: { on: { UP: 'preparing' } },
    preparing: { on: { READY: 'starting', FAIL: 'blocked', DOWN: 'down' } },
    starting: { on: { READY: 'running', FAIL: 'blocked', DOWN: 'down' } },
    running: { on: { FAIL: 'blocked', DOWN: 'down' } },
    blocked: { on: { DOWN: 'down' } },
  },
})
export function startLifecycle(onChange) {
  const actor = createActor(lifecycle)
  actor.subscribe(snapshot => onChange(snapshot.value))
  actor.start()
  return actor
}

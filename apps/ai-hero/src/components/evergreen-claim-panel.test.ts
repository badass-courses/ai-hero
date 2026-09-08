import {describe,it,expect,vi,afterEach} from 'vitest'
import {createActor,waitFor} from 'xstate'
import {evergreenClaimMachine} from './evergreen-claim-panel'
afterEach(()=>vi.unstubAllGlobals())
describe('claim presentation state machine',()=>{
 it('only an explicit ready-state action POSTs; duplicate clicks and pending never automatically retry',async()=>{
  const calls:RequestInit[]=[]
  vi.stubGlobal('fetch',vi.fn(async (_url:string,init:RequestInit)=>{calls.push(init);return Response.json(init.method==='POST'?{status:'pending'}:{status:'ready',csrf:'synthetic-csrf'})}))
  const actor=createActor(evergreenClaimMachine,{input:{endpoint:'/api/evergreen/claim'}}).start()
  try{
   await waitFor(actor,s=>s.matches('displaying'));expect(calls.map(c=>c.method)).toEqual(['GET'])
   actor.send({type:'CLAIM'});actor.send({type:'CLAIM'});await waitFor(actor,s=>s.matches('displaying')&&s.context.status==='pending')
   actor.send({type:'CLAIM'});expect(calls.map(c=>c.method)).toEqual(['GET','POST']);expect(calls[1]!.body).toBe(JSON.stringify({csrf:'synthetic-csrf'}))
   actor.send({type:'REFRESH'});await waitFor(actor,s=>s.matches('displaying')&&s.context.status==='ready');expect(calls.map(c=>c.method)).toEqual(['GET','POST','GET'])
  }finally{actor.stop()}
 })
 it('failed requests stay failed until explicit read-only refresh',async()=>{
  const fetch=vi.fn(async()=>{throw new Error('offline')});vi.stubGlobal('fetch',fetch)
  const actor=createActor(evergreenClaimMachine,{input:{endpoint:'/api/evergreen/claim'}}).start()
  try{await waitFor(actor,s=>s.matches('error'));actor.send({type:'CLAIM'});expect(fetch).toHaveBeenCalledTimes(1)}finally{actor.stop()}
 })
})

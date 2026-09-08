import {afterEach,describe,expect,it,vi} from 'vitest'
import {codingWorkflowFixture} from '../__fixtures__/quick-question-fixtures'
import {dryRunSubscriberMarketingFixture,InMemorySubscriberMarketingRepository} from '../dry-run'
import {InMemoryOperatorLookupRepository,previewSubscriberMarketingReplay} from '../operator-lookup'
import * as classifier from '../signal-classifier'
import * as reducer from '../state-reducer'
import * as planner from '../intent-planner'
import {EMAIL_TOKEN_LOGIN_OBSERVED,OFFER_CLAIM_OBSERVED} from './verified-owner-evidence'
const types=[EMAIL_TOKEN_LOGIN_OBSERVED,OFFER_CLAIM_OBSERVED,'evergreen.delivery-mapping.recorded']
async function fixture(type:string,stored=true){
 const repository=new InMemorySubscriberMarketingRepository()
 const initial=await dryRunSubscriberMarketingFixture({repository,fixture:codingWorkflowFixture,now:'2026-05-04T13:00:00.000Z'})
 const event={...initial.contactEvent,id:'internal-event',eventType:type,occurredAt:'2026-09-08T01:00:00.000Z',createdAt:'2026-09-08T01:00:00.000Z',summary:'Internal configuration record.'}
 repository.contactEvents.set(event.id,event)
 if(!stored)repository.states.clear()
 return {repository,initial,event,lookup:new InMemoryOperatorLookupRepository(repository)}
}
afterEach(()=>{vi.restoreAllMocks()})
describe('exact internal observation preview exceptions',()=>{
 it.each(types.flatMap(type=>[true,false].flatMap(stored=>[true,false].map(explicit=>({type,stored,explicit})))) )('$type stored=$stored explicit=$explicit',async({type,stored,explicit})=>{
  const f=await fixture(type,stored),before=structuredClone([...f.repository.states.values()])
  const classify=vi.spyOn(classifier,'classifyContactEvent'),reduce=vi.spyOn(reducer,'reduceContactState'),plan=vi.spyOn(planner,'planDryRunIntents')
  const result=await previewSubscriberMarketingReplay({repository:f.lookup,contactId:f.initial.contact.id,...(explicit?{eventId:f.event.id}:{})})
  expect(result.mode).toBe('non-behavioral-replay-preview')
  if(result.mode!=='non-behavioral-replay-preview')throw new Error('Expected exact exception')
  expect(result.preview.contactEvent.id).toBe(f.event.id)
  expect(result.preview.state).toBe(stored?'stored-state':'no-stored-state')
  expect(result.preview.contactState).toEqual(stored?before[0]:null)
  expect(result.preview.classification).toBeNull();expect(result.preview.nextAction).toBeNull();expect(result.preview.sideEffectIntents).toEqual([])
  expect(Object.values(result.diff)).toEqual([false,false,false,false])
  expect(classify).not.toHaveBeenCalled();expect(reduce).not.toHaveBeenCalled();expect(plan).not.toHaveBeenCalled()
  expect([...f.repository.states.values()]).toEqual(before)
 })
 it.each(types)('retains Contact and ProviderIdentity checks for %s',async type=>{
  const f=await fixture(type)
  f.repository.contactEvents.set(f.event.id,{...f.event,contactId:'other'})
  await expect(previewSubscriberMarketingReplay({repository:f.lookup,contactId:f.initial.contact.id,eventId:f.event.id})).rejects.toThrow('No replayable event')
  f.repository.contactEvents.set(f.event.id,{...f.event,providerIdentityId:'other'})
  await expect(previewSubscriberMarketingReplay({repository:f.lookup,contactId:f.initial.contact.id,eventId:f.event.id})).rejects.toThrow('Provider identity')
 })
 it.each(['auth.other','evergreen.offer_claim_observed.v2','ordinary.event'])('does not introduce a wildcard for %s',async type=>{
  const f=await fixture(type)
  const result=await previewSubscriberMarketingReplay({repository:f.lookup,contactId:f.initial.contact.id})
  expect(result.mode).toBe('replay-preview');expect(result.preview.classification).not.toBeNull()
 })
})

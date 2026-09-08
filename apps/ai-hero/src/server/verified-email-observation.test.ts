import { Auth } from '@auth/core'
import type { Adapter, AdapterUser, AdapterSession } from '@auth/core/adapters'
import Postmark from '@auth/core/providers/postmark'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVerifiedEmailObservation, type EmailLoginCapture } from './verified-email-observation'

const secret='synthetic-auth-secret-not-production'
const email='learner@example.test',token='synthetic-email-token'
const at='2026-09-08T04:30:00.123Z'
function fixture(options:{enabled?:boolean;newUser?:boolean;sameUser?:boolean;expired?:boolean;missing?:boolean;identifier?:string;authorize?:boolean;writerFails?:boolean;diagnosticFails?:boolean;priorFails?:boolean}={}) {
 const order:string[]=[],captures:EmailLoginCapture[]=[]
 let user:AdapterUser={id:'user-fixture',email,emailVerified:null,roles:[],entitlements:[]}
 let created:AdapterSession|null=null
 const observer=createVerifiedEmailObservation(options.enabled===false?{enabled:false}:{enabled:true,providerId:'postmark',now:()=>new Date(),writer:async capture=>{
  order.push('observe');if(options.writerFails)throw new Error('sensitive SQL email token must not escape');captures.push(capture);return {type:'Recorded'}
 },diagnostic:()=>{if(options.diagnosticFails)throw new Error('diagnostic down')}})
 const adapter:Adapter={
  createUser:async data=>{order.push('createUser');user={...data,id:'user-fixture',roles:[],entitlements:[]};return {...user}},
  getUser:async()=>user,getUserByEmail:async()=>options.newUser?null:user,getUserByAccount:async()=>null,
  updateUser:async data=>{order.push('updateUser');user={...user,...data};return {...user}},
  deleteUser:async()=>undefined,linkAccount:async()=>undefined,unlinkAccount:async()=>undefined,
  createSession:async data=>{order.push('createSession');created={...data,expires:new Date(Math.floor(data.expires.getTime()/1000)*1000)};return {...created}},
  getSessionAndUser:async()=>options.sameUser?{user,session:{sessionToken:'old-session',userId:user.id,expires:new Date(Date.now()+60000)}}:null,
  updateSession:async()=>null,deleteSession:async()=>undefined,createVerificationToken:async data=>data,
  useVerificationToken:async data=>{order.push('token');return options.missing?null:{...data,identifier:options.identifier??email,expires:new Date(Date.now()+(options.expired?-1:60000))}},
 }
 const run=(scope=true)=>{
  const hash=createHash('sha256').update(token+secret).digest('hex')
  const request=new Request(`https://auth.example.test/api/auth/callback/postmark?token=${token}&email=${email}`,{method:'POST',headers:options.sameUser?{cookie:'__Secure-authjs.session-token=old-session'}:{}})
  const operation=()=>Auth(request,{adapter:observer.wrapAdapter(adapter),secret,trustHost:true,basePath:'/api/auth',providers:[Postmark({apiKey:'synthetic',from:'fixture@example.test',sendVerificationRequest:async()=>{throw new Error('No email transport allowed')}})],callbacks:{signIn:async()=>options.authorize!==false},events:{signIn:observer.wrapSignIn(async()=>{order.push('prior-signIn');if(options.priorFails)throw new Error('prior side effect failed')})},logger:{error:()=>undefined,warn:()=>undefined,debug:()=>undefined}})
  return {response:scope?observer.run(request,operation):operation(),hash}
 }
 return {run,observer,adapter,order,captures,get created(){return created}}
}
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at))})
afterEach(()=>{vi.useRealTimers()})
describe('actual installed Auth email callback observation',()=>{
 it.each([{},{newUser:true},{sameUser:true}])('correlates actual callback returns and session cookie %j',async options=>{
  const f=fixture(options),run=f.run(),response=await run.response
  expect(response.status).toBe(302)
  expect(response.headers.get('set-cookie')).toContain(f.created!.sessionToken)
  expect(f.order).toEqual(['token',options.newUser?'createUser':'updateUser','createSession','prior-signIn','observe'])
  expect(f.captures).toHaveLength(1)
  expect(f.captures[0]).toMatchObject({userId:'user-fixture',email,verifiedAt:at,acceptedToken:run.hash,sessionToken:f.created!.sessionToken})
 })
 it.each([{enabled:false},{expired:true},{missing:true},{identifier:'other@example.test'},{authorize:false}])('does not observe unproved callback %j',async options=>{
  const f=fixture(options);await f.run().response;expect(f.captures).toEqual([]);expect(f.order).not.toContain('observe')
 })
 it('no request scope captures nothing',async()=>{const f=fixture();await f.run(false).response;expect(f.captures).toEqual([])})
 it.each([{writerFails:true},{diagnosticFails:true},{writerFails:true,diagnosticFails:true}])('observer failures preserve successful cookie %j',async options=>{
  const f=fixture(options),response=await f.run().response
  expect(response.status).toBe(302);expect(response.headers.get('set-cookie')).toContain(f.created!.sessionToken)
 })
 it('does not observe after prior signIn side effects throw',async()=>{const f=fixture({priorFails:true});await f.run().response;expect(f.order).not.toContain('observe')})
})

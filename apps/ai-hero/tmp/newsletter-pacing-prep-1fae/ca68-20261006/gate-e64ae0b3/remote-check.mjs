// Effect 3.21.3 transport wrapper; frozen assertions/mocks/guards remain separate.
// No Bun, provider client, real DB, env acquisition or runtime behavior replacement.
import * as Effect from '../../../../node_modules/effect/dist/esm/Effect.js'
import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
const dir=fileURLToPath(new URL('.',import.meta.url)), app=fileURLToPath(new URL('../../../../',import.meta.url))
const phase=process.argv[2], predecessor=process.argv[3]??null
const sha=b=>createHash('sha256').update(b).digest('hex')
const error=(operation,e)=>({_tag:'RemoteCheckBoundaryError',operation,detail:String(e)})
const boundary=(operation,task)=>Effect.tryPromise({try:task,catch:e=>error(operation,e)})
const read=p=>boundary('read',()=>readFile(p))
const save=(name,value)=>boundary('immutable-'+name,()=>writeFile(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}))
const prove=(ok,reason)=>{if(!ok)throw new Error(reason)}
const run=(argv,cwd,env)=>boundary('spawn',()=>new Promise((resolve,reject)=>{
 const child=spawn(argv[0],argv.slice(1),{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr=''
 child.stdout.on('data',b=>{stdout+=b.toString();process.stdout.write(b)})
 child.stderr.on('data',b=>{stderr+=b.toString();process.stderr.write(b)})
 child.once('error',reject);child.once('close',(exit,signal)=>resolve({argv,cwd,env,exit,signal,stdout,stderr,stdoutSha256:sha(Buffer.from(stdout)),stderrSha256:sha(Buffer.from(stderr))}))
}))
const program=Effect.gen(function*(){
 prove(phase==='full'||phase==='candidate','Unknown phase')
 if(phase==='candidate')prove(typeof predecessor==='string'&&/^[a-f0-9-]{36}$/.test(predecessor),'Missing qualified predecessor run ID')
 const inputsBytes=yield* read(join(dir,'gate-inputs.json'));const inputs=JSON.parse(inputsBytes.toString())
 const root=fileURLToPath(new URL('../../../../../../',import.meta.url))
 for(const row of inputs.sourceRows)prove(sha(yield* read(join(root,row.path)))===row.sha256,'Frozen source drift: '+row.path)
 for(const row of inputs.scratchRows)prove(sha(yield* read(join(dir,row.path)))===row.sha256,'Scratch input drift: '+row.path)
 prove(JSON.parse((yield* read(join(app,'node_modules/effect/package.json'))).toString()).version==='3.21.3','Installed Effect pin mismatch')
 const home=join(dir,'home-'+phase);yield* boundary('new-empty-HOME',()=>mkdir(home,{mode:0o700}))
 const childEnv={PATH:'/usr/bin:/bin',HOME:home,GOMEMLIMIT:'3GiB'}
 const base={schema:'aih.newsletter.e64.remote.v1',authority:'desk-e64ae0b3',phase,startedAt:new Date().toISOString(),inputSha256:sha(inputsBytes),node:process.version,platform:process.platform,predecessorRunId:predecessor,softwareGuardsNotOsSandbox:true,environment:childEnv}
 yield* save('started-'+phase+'.json',base)
 prove(process.platform==='linux'&&process.version==='v24.18.0','Remote platform/Node mismatch')
 let parity=null
 if(phase==='full'){
  const declared=JSON.parse((yield* read(join(root,'package.json'))).toString()).packageManager
  parity=yield* run(['/usr/local/bin/pnpm','--version'],root,{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home})
  yield* save('parity.json',{...parity,declared,kitDeclared:'11.3.0',expectedRepoEffective:'11.1.2'})
  if(parity.exit!==0||parity.signal!==null||parity.stdout.trim()!=='11.1.2'||declared!=='pnpm@11.1.2')return {...base,qualified:false,safeClass:'STOP-parity-version',parity,testInvocations:0,compilerInvocations:0}
 }
 const argv=phase==='full'
  ?[process.execPath,join(app,'node_modules/vitest/vitest.mjs'),'run','--config',join(dir,'full.vitest.config.ts')]
  :[process.execPath,join(app,'node_modules/typescript-native/bin/tsc'),'--noEmit','--singleThreaded','--pretty','false','--incremental','false','-p','tsconfig.typecheck.json']
 const check=yield* run(argv,app,childEnv)
 let qualified=false, databaseAudit=null, diagnostics=null, counts=null
 if(phase==='full'){
  const audits=check.stdout.split('\n').filter(l=>l.startsWith('DB_IMPORT_STUB_AUDIT ')).map(l=>JSON.parse(l.slice('DB_IMPORT_STUB_AUDIT '.length)))
  const paths=audits.map(a=>relative(app,a.file));const selected=JSON.parse((yield* read(join(dir,'selected-paths.json'))).toString()).full
  const calls=audits.reduce((n,a)=>n+a.operations.length,0)
  databaseAudit={expectedFiles:15,observedFiles:audits.length,uniqueFiles:new Set(paths).size,deniedCallCount:calls,exactSelectedPaths:paths.length===selected.length&&selected.every(p=>paths.includes(p)),files:audits}
  counts={files:check.stdout.split('\n').find(l=>/Test Files\s/.test(l))?.trim()??null,tests:check.stdout.split('\n').find(l=>/\bTests\s+/.test(l))?.trim()??null}
  qualified=check.exit===0&&check.signal===null&&audits.length===15&&new Set(paths).size===15&&calls===0&&databaseAudit.exactSelectedPaths&&/Test Files\s+15 passed \(15\)/.test(check.stdout)
 }else{
  const before=JSON.parse((yield* read(join(dir,'baseline-diagnostic-lines.json'))).toString()).lines
  const after=check.stdout.split('\n').filter(l=>/error TS\d+:/.test(l));const hash=sha(Buffer.from(after.join('\n')+'\n'))
  const added=[...new Set(after)].filter(l=>!new Set(before).has(l));const removed=[...new Set(before)].filter(l=>!new Set(after).has(l))
  const touched=after.filter(l=>inputs.sourceRows.some(r=>l.includes(r.path.replace('apps/ai-hero/','')+'(')))
  diagnostics={count:after.length,sha256:hash,encoding:'Exact native order, LF after each line including final; no sorting/normalization',addedCount:added.length,removedCount:removed.length,touchedCount:touched.length,notWholeAppGreen:true}
  qualified=check.exit===1&&check.signal===null&&after.length===44&&hash===inputs.baselineDiagnosticSha256&&added.length===0&&removed.length===0&&touched.length===0
 }
 return {...base,completedAt:new Date().toISOString(),parity,check,counts,databaseAudit,diagnostics,qualified,safeClass:qualified?(phase==='full'?'full15-qualified':'exact44-qualified-not-app-green'):'STOP-first-check-outcome',testInvocations:phase==='full'?1:0,compilerInvocations:phase==='candidate'?1:0}
})
let result
try{result=await Effect.runPromise(program)}catch(e){result={schema:'aih.newsletter.e64.remote.v1',phase,qualified:false,safeClass:'STOP-wrapper-boundary',detail:String(e),node:process.version,platform:process.platform}}
await Effect.runPromise(save('result-'+phase+'.json',result))
// Transport all exact logs/receipts before kit successful-work cleanup. No remote fetch/replay.
console.log('AIH_CA68_REMOTE_RESULT '+JSON.stringify(result))
process.exitCode=result.qualified?(phase==='candidate'?1:0):2

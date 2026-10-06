import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
const app=fileURLToPath(new URL('../../../../',import.meta.url))
const scratch=fileURLToPath(new URL('.',import.meta.url))
export default defineConfig({
 root:app, envDir:scratch+'home', cacheDir:scratch+'vite-cache',
 plugins:[{name:'deny-real-db-source',enforce:'pre',load(id){if(id.split('?')[0].startsWith(app+'src/db/'))throw new Error('REAL_DB_SOURCE_LOAD_DENIED: '+id)}}],
 resolve:{alias:[
  {find:/^@\/db(?:\/index(?:\.ts)?)?$/,replacement:scratch+'database-stub.ts'},
  {find:/^@\/db\/(?:schema|.+-schema)(?:\.ts)?$/,replacement:scratch+'schema-stub.ts'},
  {find:'@',replacement:app+'src'},
 ]},
 test:{environment:'node',globals:true,setupFiles:[scratch+'full-guards.ts'],
  pool:'threads',poolOptions:{threads:{singleThread:true}},include:[
  "src/lib/subscriber-marketing/drovr-evergreen-sender.test.ts",
  "src/lib/subscriber-marketing/drovr-evergreen.test.ts",
  "src/inngest/functions/drovr-evergreen-sender.newsletter-pacing.test.ts",
  "src/inngest/functions/newsletter-provider-pause.test.ts",
  "src/inngest/functions/newsletter-sender-config.test.ts",
  "src/inngest/functions/evergreen-sender-pacing.test.ts",
  "src/lib/subscriber-marketing/drovr-executor.test.ts",
  "src/lib/subscriber-marketing/drovr-list-subscribe.test.ts",
  "src/lib/subscriber-marketing/drovr-list-unsubscribe.test.ts",
  "src/lib/subscriber-marketing/drovr-evergreen-coupon.test.ts",
  "src/lib/subscriber-marketing/drovr-evergreen-claim.test.ts",
  "src/lib/subscriber-marketing/drovr-shadow-newsletter.test.ts",
  "src/lib/subscriber-marketing/drovr-sync-send.test.ts",
  "src/app/api/drovr/intents/route.test.ts",
  "src/app/api/drovr/intents/route.dedupe-contract.test.ts"
],
 },
})

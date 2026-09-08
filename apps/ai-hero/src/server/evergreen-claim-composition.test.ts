import {describe,it,expect,vi} from 'vitest'
import {composeEvergreenClaim,EVERGREEN_CLAIM_ENABLED,EVERGREEN_CLAIM_PRODUCT_PATH} from './evergreen-claim-composition'
import {GET,POST} from '@/app/api/evergreen/claim/route'
describe('dormant claim route composition',()=>{
 it('GET and POST refuse without a session/database/provider composition',async()=>{
  expect(EVERGREEN_CLAIM_ENABLED).toBe(false);expect(EVERGREEN_CLAIM_PRODUCT_PATH).toBe(null)
  for(const handler of [GET,POST,composeEvergreenClaim({enabled:false})]){
   const response=await handler(new Request('https://example.test/api/evergreen/claim'))
   expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toContain('no-store')
  }
 })
})

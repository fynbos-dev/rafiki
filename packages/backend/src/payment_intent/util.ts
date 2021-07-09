// XXX: this isn't needed...

import * as assert from 'assert'
import { URL } from 'url'
import axios from 'axios'
import uuid from 'uuid'

interface SPSPResponse {
  destination_account: string
  shared_secret: Buffer
  receipts_enabled: boolean
}

export async function resolvePaymentPointer(
  pointer: string
): Promise<SPSPResponse> {
  const url = paymentPointerToUrl(pointer)
  const response = await axios({
    url,
    method: 'GET',
    headers: {
      Accept: 'application/spsp4+json',
      'Web-Monetization-Id': uuid()
    }
  })

  assert.equal(typeof response.destination_account, 'string')
  assert.equal(typeof response.shared_secret, 'string')

  response.data = Buffer.from(response.data, 'base64')
  assert.equal(response.data.length, 32)

  return response.data
}

export function paymentPointerToUrl(pointer: string): string {
  const pointerBaseUrl = pointer.startsWith('$')
    ? 'https://' + pointer.substring(1)
    : pointer

  const pointerParsedUrl = new URL(pointerBaseUrl)
  pointerParsedUrl.pathname =
    pointerParsedUrl.pathname === '/'
      ? pointerParsedUrl.pathname + '/.well-known/pay'
      : pointerParsedUrl.pathname

  return pointerParsedUrl.href
}

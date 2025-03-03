import { BaseModel } from '../../../shared/baseModel'

import { JWK } from 'http-signature-utils'
import { Pojo } from 'objection'

export class PaymentPointerKey extends BaseModel {
  public static get tableName(): string {
    return 'paymentPointerKeys'
  }

  public id!: string
  public paymentPointerId!: string

  public jwk!: JWK
  public revoked!: boolean

  $formatDatabaseJson(json: Pojo): Pojo {
    if (json.jwk) {
      json.kid = json.jwk.kid
      json.x = json.jwk.x
      delete json.jwk
    }
    return super.$formatDatabaseJson(json)
  }

  $parseDatabaseJson(json: Pojo): Pojo {
    const formattedJson = super.$parseDatabaseJson(json)
    formattedJson.jwk = {
      kid: formattedJson.kid,
      x: formattedJson.x,
      alg: 'EdDSA',
      kty: 'OKP',
      crv: 'Ed25519'
    }
    delete formattedJson.kid
    delete formattedJson.x
    return formattedJson
  }
}

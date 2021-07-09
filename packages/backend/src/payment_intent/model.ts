import { BaseModel } from '../shared/baseModel'

export class PaymentIntent extends BaseModel {
  public static tableName = 'paymentIntents'
  //public static get tableName(): string {
  //  return 'paymentIntents'
  //}

  public paymentPointer?: string
  public invoiceUrl?: string
  public amountToSend?: BigInt
}

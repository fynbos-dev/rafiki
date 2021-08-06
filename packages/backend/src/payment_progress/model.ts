import { BaseModel } from '../shared/baseModel'

export class PaymentProgress extends BaseModel {
  public static get tableName(): string {
    return 'paymentProgress'
  }

  public readonly amountSent!: bigint
  public readonly amountDelivered!: bigint
}

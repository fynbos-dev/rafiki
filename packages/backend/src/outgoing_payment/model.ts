import { BaseModel } from '../shared/baseModel'
import { Model, Pojo } from 'objection'
import { PaymentIntent } from '../payment_intent/model'

const prefixes = ['quote', 'sourceAccount', 'destinationAccount', 'outcome']

export class OutgoingPayment extends BaseModel {
  public static tableName = 'outgoingPayments'
  //public static get tableName(): string {
  //  return 'outgoingPayments'
  //}

  static relationMappings = {
    incomingTokens: {
      relation: Model.BelongsToOneRelation,
      modelClass: PaymentIntent,
      join: {
        from: 'outgoingPayments.paymentIntentId',
        to: 'paymentIntents.id'
      }
    }
  }

  public paymentIntentId!: string
  public state!: PaymentState
  public error?: string

  public quote?: {
    timestamp: Date
    activationDeadline: Date
    targetType: PaymentTargetType
    minDeliveryAmount: BigInt
    maxSourceAmount: BigInt
    minExchangeRate: number
    lowExchangeRateEstimate: number
    highExchangeRateEstimate: number
    estimatedDuration: number // milliseconds
  }
  public sourceAccount!: {
    scale: number
    code: string
  }
  public destinationAccount!: {
    scale: number
    code: string
    url: string
    paymentPointer: string
  }
  public outcome?: {
    amountSent: bigint
    sourceAmountInFlight: bigint
    amountDelivered: bigint
    destinationAmountInFlight: bigint
  }

  $formatDatabaseJson(json: Pojo): Pojo {
    for (const group in prefixes) {
      if (!json[group]) continue
      for (const key in json[group]) {
        json[group + key.charAt(0).toUpperCase() + key.slice(1)] =
          json[group][key]
      }
      delete json[group]
    }

    /*
    if (this.quote) {
      json.quoteTimestamp = this.quote.timestamp
      json.quoteActivationDeadline = this.quote.activationDeadline
      json.quoteTargetType = this.quote.targetType
      json.quoteMinDeliveryAmount = this.quote.minDeliveryAmount
      json.quoteMaxSourceAmount = this.quote.maxSourceAmount
      json.quoteMinExchangeRate = this.quote.minExchangeRate
      json.quoteLowExchangeRateEstimate = this.quote.lowExchangeRateEstimate
      json.quoteHighExchangeRateEstimate = this.quote.highExchangeRateEstimate
      json.quoteEstimatedDuration = this.quote.estimatedDuration
    }
    json.sourceAccountCode = this.sourceAccount.code
    json.sourceAccountScale = this.sourceAccount.scale
    json.destinationAccountScale = this.destinationAccount.scale
    json.destinationAccountCode = this.destinationAccount.code
    json.destinationAccountUrl = this.destinationAccount.url
    json.destinationAccountPaymentPointer = this.destinationAccount.paymentPointer
    if (this.outcome) {
      json.outcomeAmountSent = this.outcome.amountSent
      json.outcomeSourceAmountInFlight = this.outcome.sourceAmountInFlight
      json.outcomeAmountDelivered = this.outcome.amountDelivered
      json.outcomeDestinationAmountInFlight = this.outcome.destinationAmountInFlight
    }
    */
    return super.$formatDatabaseJson(json)
  }

  $parseDatabaseJson(json: Pojo): Pojo {
    json = super.$parseDatabaseJson(json)

    for (const key in json) {
      for (const prefix of prefixes) {
        if (key.startsWith(prefix)) {
          if (!json[prefix]) json[prefix] = {}
          json[prefix][
            key.charAt(0).toLowerCase() + key.slice(key.length + 1)
          ] = json[key]
          delete json[key]
        }
      }
    }

    /*
    this.quote = {
      timestamp: json.quoteTimestamp,
      activationDeadline: json.quoteActivationDeadline,
      targetType: json.quoteTargetType,
      minDeliveryAmount: json.quoteMinDeliveryAmount,
      maxSourceAmount: json.quoteMaxSourceAmount,
      minExchangeRate: json.quoteMinExchangeRate,
      lowExchangeRateEstimate: json.quoteLowExchangeRateEstimate,
      highExchangeRateEstimate: json.quoteHighExchangeRateEstimate,
      estimatedDuration: json.quoteEstimatedDuration,
    }
    if (Object.values(this.quote).all((v) => v === null)) this.quote = undefined
    this.sourceAccount = {
      code: json.sourceAccountCode,
      scale: json.sourceAccountScale
    }
    this.destinationAccount = {
      scale: json.destinationAccountScale,
      code: json.destinationAccountCode,
      url: json.destinationAccountUrl,
      paymentPointer: json.destinationAccountPaymentPointer,
    }
    */
    return json
  }
}

export enum PaymentState {
  Inactive = 'Inactive',
  Quoting = 'Quoting',
  Ready = 'Ready',
  ErrorQuote = 'ErrorQuote',
  Activated = 'Activated',
  Cancelled = 'Cancelled',
  Sending = 'Sending',
  Completed = 'Completed',
  ErrorAuto = 'ErrorAuto',
  ErrorManual = 'ErrorManual'
}

export enum PaymentTargetType {
  FixedSend = 'fixed-send',
  FixedDelivery = 'fixed-delivery'
}

import { Pojo, Model, ModelOptions, QueryContext } from 'objection'
import * as Pay from '@interledger/pay'
import { BaseModel } from '../shared/baseModel'
import { PaymentProgress } from '../payment_progress/model'

const prefixes = [
  'intent',
  'quote',
  'sourceAccount',
  'destinationAccount',
  'outcome'
]

export type PaymentIntent = {
  paymentPointer?: string
  invoiceUrl?: string
  amountToSend?: bigint
  autoApprove: boolean
}

export class OutgoingPayment extends BaseModel {
  public static tableName = 'outgoingPayments'
  //public static get tableName(): string {
  //  return 'outgoingPayments'
  //}

  //static relationMappings = {
  //  incomingTokens: {
  //    relation: Model.BelongsToOneRelation,
  //    modelClass: PaymentIntent,
  //    join: {
  //      from: 'outgoingPayments.paymentIntentId',
  //      to: 'paymentIntents.id'
  //    }
  //  }
  //}

  static relationMappings = {
    progress: {
      relation: Model.HasOneRelation,
      modelClass: PaymentProgress,
      join: {
        from: 'outgoingPayments.id',
        to: 'paymentProgress.id'
      }
    }
  }

  public state!: PaymentState
  public error?: string
  public attempts!: number

  public intent!: PaymentIntent

  public quote?: {
    timestamp: Date
    activationDeadline: Date
    targetType: Pay.PaymentType
    minDeliveryAmount: bigint
    maxSourceAmount: bigint
    maxPacketAmount: bigint
    minExchangeRate: number
    lowExchangeRateEstimate: number
    highExchangeRateEstimate: number
    //estimatedDuration: number // milliseconds
  }
  public sourceAccount!: {
    id: string
    scale: number
    code: string
  }
  public destinationAccount!: {
    scale: number
    code: string
    url?: string
    // TODO: why even store this in addition to url? it doesn't always exist (url does); from spec:
    // Payment pointer, prefixed with "$", corresponding to the recipient Open Payments/SPSP account. Each payment pointer and its corresponding account URL identifies a unique payment recipient.
    paymentPointer?: string
  }
  public outcome?: {
    amountSent: bigint
    amountDelivered: bigint
  }

  $beforeUpdate(opts: ModelOptions, queryContext: QueryContext): void {
    super.$beforeUpdate(opts, queryContext)
    if (
      this.state !== PaymentState.Cancelling &&
      this.state !== PaymentState.Cancelled
    ) {
      this.error = undefined
    }
    if (opts.old && opts.old['state'] !== this.state) {
      this.attempts = 0
    }
  }

  $formatDatabaseJson(json: Pojo): Pojo {
    for (const group of prefixes) {
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
      const prefix = prefixes.find((prefix) => key.startsWith(prefix))
      if (!prefix) continue
      if (json[key] !== null) {
        if (!json[prefix]) json[prefix] = {}
        json[prefix][
          key.charAt(prefix.length).toLowerCase() + key.slice(prefix.length + 1)
        ] = json[key]
      }
      delete json[key]
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
  // Initial state. In this state, an empty trustline account is generated, and the payment is automatically resolved & quoted.
  // On success, transition to `Ready`.
  // On failure, transition to `Cancelled`.
  Inactive = 'Inactive',
  //Quoting = 'Quoting', // XXX
  // Awaiting user approval. Approval is automatic if `autoApprove` is set.
  // Once approved, transitions to `Activated`.
  Ready = 'Ready',
  // During activation, money from the user's (parent) account is moved to the trustline to reserve it for the payment.
  // On success, transition to `Sending`.
  Activated = 'Activated',
  // Pay from the trustline account to the destination.
  Sending = 'Sending',

  // Transitions to Cancelled once leftover reserved money is refunded to the parent account.
  Cancelling = 'Cancelling',
  // The payment failed. (Possibly some money was delivered, but not the fully payment).
  // Requoting transitions to `Inactive`.
  Cancelled = 'Cancelled',
  // Successful completion.
  Completed = 'Completed'
}

import { setupPayment } from '@interledger/pay'
import { BaseService } from '../shared/baseService'
import { OutgoingPayment, PaymentIntent, PaymentState, PaymentTargetType } from './model'
import { AccountService } from '../account/service'
import { RatesService } from 'rates'
import { IlpPlugin } from './plugin'

// TODO where does this come from? constant? config? what is a reasonable default?
const QUOTE_LIFESPAN = 5_000 // milliseconds

export interface OutgoingPaymentService {
  get(id: string): Promise<OutgoingPayment>
  create(paymentIntent: PaymentIntent): Promise<OutgoingPayment>
  activate(id: string): Promise<void>
  cancel(id: string): Promise<void>
  requote(id: string): Promise<void>
}

export interface ServiceDependencies extends BaseService {
  accountService: AccountService
  ratesService: RatesService
  ilpPlugin: IlpPlugin
}

export async function createOutgoingPaymentService(deps_: ServiceDependencies): Promise<OutgoingPaymentService> {
  const deps = Object.assign({}, deps_, { logger: deps.logger.child({ service: 'OutgoingPaymentService' }) })
  return {
    get: (id) => getOutgoingPayment(deps, id),
    create: (paymentIntent: PaymentIntent) => createOutgoingPayment(deps, paymentIntent),
    activate: (id) => activatePayment(deps, id),
    cancel: (id) => cancelPayment(deps, id),
    requote: (id) => requotePayment(deps, id)
  }
}

async function getOutgoingPayment (deps: ServiceDependencies, id: string): Promise<OutgoingPayment> {
  return OutgoingPayment.query(deps.knex).findById(id)
}

// TODO create state=Inactive OutgoingPayment in same transaction as PaymentIntent?
async function createOutgoingPayment (deps: ServiceDependencies, paymentIntent: PaymentIntent): Promise<OutgoingPayment> {
  const parentAccountId = // TODO
  const sourceAccount = await deps.accountService.createSubAccount(parentAccountId)
  const prices = await rates.prices()

  const { startQuote, destinationAsset, accountUrl, paymentPointer } = await setupPayment({
    plugin: deps.ilpPlugin,
    paymentPointer: paymentIntent.paymentPointer,
    invoiceUrl: paymentIntent.invoiceUrl
  })

  const payment = await OutgoingPayment.query(deps.knex).insertAndFetch({
    state: PaymentState.Inactive,
    intentPaymentPointer: paymentIntent.paymentPointer,
    intentInvoiceUrl: paymentIntent.invoiceUrl,
    intentAmountToSend: paymentIntent.amountToSend,
    intentAutoApprove: paymentIntent.autoApprove,
    parentAccountId,
    //quoteTimestamp: new Date(),
    //quoteActivationDeadline: new Date(Date.now() + QUOTE_LIFESPAN),
    //quoteTargetType: paymentIntent.invoiceUrl ? PaymentTargetType.FixedDelivery : PaymentTargetType.FixedSend,
    //quoteMinDeliveryAmount: quote.minDeliveryAmount,
    //quoteMaxSourceAmount: quote.maxSourceAmount,
    //quoteMinExchangeRate: quote.minExchangeRate,
    //quoteLowExchangeRateEstimate: +quote.estimatedExchangeRate[0].toString(),
    //quoteHighExchangeRateEstimate: +quote.estimatedExchangeRate[1].toString(),
    //quoteEstimatedDuration: quote.estimatedDuration,
    sourceAccountId: sourceAccount.id, // TODO add to model/migration
    sourceAccountCode: sourceAccount.code,
    sourceAccountScale: sourceAccount.scale,
    destinationAccountScale: destinationAsset.scale,
    destinationAccountCode: destinationAsset.code,
    destinationAccountUrl: accountUrl,
    destinationAccountPaymentPointer: paymentPointer
  })

  return payment
  /*
  return OutgoingPayment.query(deps.knex).insertAndFetch({
    paymentIntentId: paymentIntent.id,
    state: PaymentState.Ready,
    quoteTimestamp: new Date(),
    quoteActivationDeadline: new Date(Date.now() + QUOTE_LIFESPAN),
    quoteTargetType: paymentIntent.invoiceUrl ? PaymentTargetType.FixedDelivery : PaymentTargetType.FixedSend,
    quoteMinDeliveryAmount: quote.minDeliveryAmount,
    quoteMaxSourceAmount: quote.maxSourceAmount,
    quoteMinExchangeRate: quote.minExchangeRate,
    quoteLowExchangeRateEstimate: +quote.estimatedExchangeRate[0].toString(),
    quoteHighExchangeRateEstimate: +quote.estimatedExchangeRate[1].toString(),
    quoteEstimatedDuration: quote.estimatedDuration,
    sourceAccountCode: sourceAccount.code,
    sourceAccountScale: sourceAccount.scale,
    destinationAccountScale: destinationAsset.scale,
    destinationAccountCode: destinationAsset.code,
    destinationAccountUrl: accountUrl,
    destinationAccountPaymentPointer: paymentPointer
  })
  */
}

function requotePayment(deps: ServiceDependencies, id: string): Promise<void> {
  return deps.knex.transaction(async () => {
    // "SELECT … FOR UPDATE" ensures that another simultaneous requote
    // (or other operation) on this payment will wait.
    // TODO maybe "SKIP LOCKED" also?
    const payment = await OutgoingPayment.query(trx).forUpdate().findById(id)
    if (
      payment.state !== PaymentState.Inactive &&
      payment.state !== PaymentState.ErrorQuote &&
      payment.state !== PaymentState.ErrorManual
    ) {
      throw new Error(`Cannot quote; payment is in state=${payment.state}`)
    }

    const quote = await startQuote({
      //slippage: // TODO on config or PaymentIntent
      prices,
      amountToSend: payment.intent.amountToSend,
      sourceAsset: {
        scale: sourceAccount.scale,
        code: sourceAccount.code
      }
    }).catch(async (err) => {
      await payment.patch({ state: PaymentState.ErrorQuote }) // TODO increment attempts?
      return null
    })
    if (!quote) return payment

    await deps.accountService.transferFunds({ // TODO trustlines?
      sourceAccountId: payment.parentAccountId,
      destinationAccountId: payment.sourceAccount.id,
      sourceAmount: quote.maxSourceAmount,
      destinationAmount: quote.maxSourceAmount,
    })

    await payment.patch({
      state: PaymentState.Ready,
      quoteTimestamp: new Date(),
      quoteActivationDeadline: new Date(Date.now() + QUOTE_LIFESPAN),
      quoteTargetType: payment.intent.invoiceUrl ? PaymentTargetType.FixedDelivery : PaymentTargetType.FixedSend,
      quoteMinDeliveryAmount: quote.minDeliveryAmount,
      quoteMaxSourceAmount: quote.maxSourceAmount,
      quoteMinExchangeRate: quote.minExchangeRate,
      quoteLowExchangeRateEstimate: +quote.estimatedExchangeRate[0].toString(),
      quoteHighExchangeRateEstimate: +quote.estimatedExchangeRate[1].toString(),
      quoteEstimatedDuration: quote.estimatedDuration,
    })
  }, { isolationLevel: 'repeatable read' })
}

async function activatePayment(_deps: ServiceDependencies, _id: string): Promise<void> {
  // TODO
}

async function cancelPayment(_deps: ServiceDependencies, _id: string): Promise<void> {
  // TODO
}

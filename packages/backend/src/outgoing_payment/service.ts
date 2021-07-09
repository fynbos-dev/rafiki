import { setupPayment } from '@interledger/pay'
import { BaseService } from '../shared/baseService'
import { PaymentIntent } from '../payment_intent/model'
import { OutgoingPayment, PaymentState, PaymentTargetType } from './model'
import { AccountService } from '../account/service'

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
  //ilpPlugin: IlpPlugin // XXX?
}

// TODO import this from somewhere… maybe @interledger/pay should export it?
/*
interface IlpPlugin {
  connect: () => Promise<void>,
  disconnect: () => Promise<void>,
  isConnected: () => boolean,
  sendData: (data: Buffer) => Promise<Buffer>,
  registerDataHandler: (handler: (data: Buffer) => Promise<Buffer>) => void,
  deregisterDataHandler: () => void
}
*/

export async function createOutgoingPaymentService(
  deps_: ServiceDependencies
): Promise<OutgoingPaymentService> {
  const deps = Object.assign({}, deps_, {
    logger: deps.logger.child({ service: 'OutgoingPaymentService' })
  })
  return {
    get: (id) => getOutgoingPayment(deps, id),
    create: (paymentIntent: PaymentIntent) =>
      createOutgoingPayment(deps, paymentIntent),
    activate: (id) => activatePayment(deps, id),
    cancel: (id) => cancelPayment(deps, id),
    requote: (id) => requotePayment(deps, id)
  }
}

async function getOutgoingPayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment> {
  return OutgoingPayment.query(deps.knex).findById(id)
}

// TODO create state=Inactive OutgoingPayment in same transaction as PaymentIntent?
async function createOutgoingPayment(
  deps: ServiceDependencies,
  paymentIntent: PaymentIntent
): Promise<OutgoingPayment> {
  const sourceAccount = await deps.accountService.get(/*TODO*/)

  const ilpPlugin = new PluginHttp({
    // btp?
    // TODO ???
    // TODO how does Backend authenticate to Connector when sending packets?
  })
  const {
    startQuote,
    destinationAsset,
    accountUrl,
    paymentPointer
  } = await setupPayment({
    plugin: ilpPlugin,
    paymentPointer: paymentIntent.paymentPointer,
    invoiceUrl: paymentIntent.invoiceUrl
  })
  // TODO catch error; initialize in state=Error(??)
  const quote = await startQuote({
    //slippage: // TODO
    //prices: // TODO
    amountToSend: paymentIntent.amountToSend,
    sourceAsset: {
      scale: sourceAccount.scale,
      code: sourceAccount.code
    }
  })
  // TODO catch error; initialize in state=Error(Quote)
  // TODO create subaccount (before creating OutgoingPayment), reserve money (but only once the account id is saved in the OutgoingPayment so it can't be lost): deps.accountService.createSubAccount

  return OutgoingPayment.query(deps.knex).insertAndFetch({
    paymentIntentId: paymentIntent.id,
    state: PaymentState.Ready,
    quoteTimestamp: new Date(),
    quoteActivationDeadline: new Date(Date.now() + QUOTE_LIFESPAN),
    quoteTargetType: paymentIntent.invoiceUrl
      ? PaymentTargetType.FixedDelivery
      : PaymentTargetType.FixedSend,
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
}

async function activatePayment(
  _deps: ServiceDependencies,
  _id: string
): Promise<void> {
  // TODO
}

async function cancelPayment(
  _deps: ServiceDependencies,
  _id: string
): Promise<void> {
  // TODO
}

async function requotePayment(
  _deps: ServiceDependencies,
  _id: string
): Promise<void> {
  // TODO
}

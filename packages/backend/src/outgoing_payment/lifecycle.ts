import * as assert from 'assert'
import * as Pay from '@interledger/pay'
import { debounce } from 'debounce'
import { OutgoingPayment, PaymentState } from './model'
import { ServiceDependencies } from './service'

const QUOTE_LIFESPAN = 5 * 60_000 // milliseconds
const SLIPPAGE = 0.01
// Minimum interval between progress updates.
const PROGRESS_UPDATE_INTERVAL = 200 // milliseconds

export type PaymentError = LifecycleError | Pay.PaymentError
export enum LifecycleError {
  QuoteExpired = 'QuoteExpired',
  // Rate fetch failed.
  PricesUnavailable = 'PricesUnavailable',
  // Payment aborted via "cancel payment" API call.
  CancelledByAPI = 'CancelledByAPI',
  // Not enough money in the super-account.
  InsufficientBalance = 'InsufficientBalance',
  // Error from the account service, except an InsufficientBalance. (see: CreditError)
  AccountServiceError = 'AccountServiceError',
  // This error shouldn't ever trigger, it is just to satisfy types.
  MissingQuote = 'MissingQuote',
  // This error shouldn't ever trigger, it is just to satisfy types.
  InvalidRatio = 'InvalidRatio'
}

export async function handleQuoting(
  deps: ServiceDependencies,
  payment: OutgoingPayment
): Promise<void> {
  const prices = await deps.ratesService.prices().catch((_err: Error) => {
    throw LifecycleError.PricesUnavailable
  })

  const destination = await Pay.setupPayment({
    plugin: deps.ilpPlugin,
    paymentPointer: payment.intent.paymentPointer,
    invoiceUrl: payment.intent.invoiceUrl
  })

  assert.equal(
    destination.destinationAsset.scale,
    payment.destinationAccount.scale,
    'destination scale mismatch'
  )
  assert.equal(
    destination.destinationAsset.code,
    payment.destinationAccount.code,
    'destination code mismatch'
  )

  const quote = await Pay.startQuote({
    plugin: deps.ilpPlugin,
    destination,
    sourceAsset: {
      scale: payment.sourceAccount.scale,
      code: payment.sourceAccount.code
    },
    // This is always the full payment amount, even when part of that amount has already successfully been delivered.
    // The quote's amounts are adjusted `handleSending` to reflect the actual payment state.
    amountToSend: payment.intent.amountToSend,
    slippage: SLIPPAGE,
    prices
  }).finally(() => {
    return Pay.closeConnection(deps.ilpPlugin, destination).catch((err) => {
      deps.logger.warn(
        {
          destination: destination.destinationAddress,
          error: err.message
        },
        'close quote connection failed'
      )
    })
  })

  await payment.$query().patch({
    state: PaymentState.Ready,
    quote: {
      timestamp: new Date(),
      activationDeadline: new Date(Date.now() + QUOTE_LIFESPAN),
      targetType: quote.paymentType,
      minDeliveryAmount: quote.minDeliveryAmount,
      maxSourceAmount: quote.maxSourceAmount,
      maxPacketAmount: quote.maxPacketAmount,
      minExchangeRate: quote.minExchangeRate.valueOf(),
      lowExchangeRateEstimate: quote.lowEstimatedExchangeRate.valueOf(),
      highExchangeRateEstimate: quote.highEstimatedExchangeRate.valueOf()
    }
    //quoteEstimatedDuration: quote.estimatedDuration,
  })
}

export async function handleReady(
  deps: ServiceDependencies,
  payment: OutgoingPayment
): Promise<void> {
  if (!payment.quote) throw LifecycleError.MissingQuote
  if (payment.quote.activationDeadline < new Date()) {
    throw LifecycleError.QuoteExpired
  }
  if (payment.intent.autoApprove) {
    await payment.$query().patch({ state: PaymentState.Activated })
    deps.logger.debug('auto-approve')
  }
}

export async function handleActivation(
  deps: ServiceDependencies,
  payment: OutgoingPayment
): Promise<void> {
  if (!payment.quote) throw LifecycleError.MissingQuote
  if (payment.quote.activationDeadline < new Date()) {
    throw LifecycleError.QuoteExpired
  }

  await refundLeftoverBalance(deps, payment)
  const res = await deps.accountService.extendCredit(
    payment.sourceAccount.id,
    payment.quote.maxSourceAmount
  )
  //const res = await deps.accountService.extendCredit({
  //  accountId: payment.sourceAccount.id,
  //  amount: payment.quote.maxSourceAmount,
  //  autoApply: true
  //})
  if (res === 'InsufficientBalance') {
    throw LifecycleError.InsufficientBalance
  } else if (res) {
    // Unexpected account service errors: the money was not reserved.
    deps.logger.warn({ error: res }, 'extend credit error')
    throw LifecycleError.AccountServiceError
  }
  await payment.$query().patch({ state: PaymentState.Sending })
}

export async function handleSending(
  deps: ServiceDependencies,
  payment: OutgoingPayment
): Promise<void> {
  if (!payment.quote) throw LifecycleError.MissingQuote
  const progress =
    (await deps.paymentProgressService.get(payment.id)) ||
    (await deps.paymentProgressService.create(payment.id))
  const baseAmountSent = progress.amountSent
  const baseAmountDelivered = progress.amountDelivered

  const destination = await Pay.setupPayment({
    plugin: deps.ilpPlugin,
    paymentPointer: payment.intent.paymentPointer,
    invoiceUrl: payment.intent.invoiceUrl
  })

  // Debounce progress updates so that a tiny max-packet-amount doesn't trigger a flood of updates.
  const progressHandler = debounce((receipt: Pay.PaymentProgress): void => {
    // These updates occur in a separate transaction from the OutgoingPayment, so they commit immediately.
    // They are still implicitly protected from race conditions via the OutgoingPayment's SELECT FOR UPDATE.
    updateProgress = updateProgress.finally(() =>
      progress.$query().patch({
        amountSent: baseAmountSent + receipt.amountSent,
        amountDelivered: baseAmountDelivered + receipt.amountDelivered
      })
    )
  }, PROGRESS_UPDATE_INTERVAL)

  const lowEstimatedExchangeRate = Pay.Ratio.from(
    payment.quote.lowExchangeRateEstimate
  )
  const highEstimatedExchangeRate = Pay.Ratio.from(
    payment.quote.highExchangeRateEstimate
  )
  const minExchangeRate = Pay.Ratio.from(payment.quote.minExchangeRate)
  if (
    !lowEstimatedExchangeRate ||
    !highEstimatedExchangeRate ||
    !highEstimatedExchangeRate.isPositive() ||
    !minExchangeRate
  ) {
    // This shouldn't ever happen, since the rates are correct when they are stored during the quoting stage.
    deps.logger.error(
      {
        lowEstimatedExchangeRate,
        highEstimatedExchangeRate,
        minExchangeRate
      },
      'invalid estimated rate'
    )
    throw LifecycleError.InvalidRatio
  }
  const quote = {
    //...payment.quote,
    paymentType: payment.quote.targetType,
    // Adjust quoted amounts to account for prior partial payment.
    maxSourceAmount: payment.quote.maxSourceAmount - baseAmountSent,
    minDeliveryAmount: payment.quote.minDeliveryAmount - baseAmountDelivered,
    maxPacketAmount: payment.quote.maxPacketAmount,
    lowEstimatedExchangeRate,
    highEstimatedExchangeRate,
    minExchangeRate
  }

  let updateProgress = Promise.resolve()
  const receipt = await Pay.pay({
    plugin: deps.ilpPlugin,
    destination,
    quote,
    progressHandler
  })
    .finally(async () => {
      progressHandler.flush()
      // Wait for updateProgress to finish to avoid a race where it could update
      // outside the protection of the locked payment.
      await updateProgress
    })
    .finally(() => {
      return Pay.closeConnection(deps.ilpPlugin, destination).catch((err) => {
        // Ignore connection close failures, all of the money was delivered.
        deps.logger.warn(
          {
            destination: destination.destinationAddress,
            error: err.message
          },
          'close pay connection failed'
        )
      })
    })

  const outcomeAmountSent = baseAmountSent + receipt.amountSent
  const outcomeAmountDelivered = baseAmountDelivered + receipt.amountDelivered
  deps.logger.debug(
    {
      destination: destination.destinationAddress,
      error: receipt.error,
      outcomeAmountSent,
      outcomeAmountDelivered,
      receiptAmountSent: receipt.amountSent,
      receiptAmountDelivered: receipt.amountDelivered
    },
    'payed'
  )

  if (receipt.error) throw receipt.error

  // Restore leftover reserved money to the parent account.
  await refundLeftoverBalance(deps, payment)
  await payment.$query().patch({
    state: PaymentState.Completed,
    outcome: {
      amountSent: outcomeAmountSent,
      amountDelivered: outcomeAmountDelivered
    }
  })
}

export async function handleCancelling(
  deps: ServiceDependencies,
  payment: OutgoingPayment
): Promise<void> {
  await refundLeftoverBalance(deps, payment)
  await payment.$query().patch({ state: PaymentState.Cancelled })
}

// Refund money in the subaccount to the parent account.
async function refundLeftoverBalance(
  deps: ServiceDependencies,
  payment: OutgoingPayment
): Promise<void> {
  const balance = await deps.accountService.getAccountBalance(
    payment.sourceAccount.id
  )
  if (!balance) throw LifecycleError.AccountServiceError
  if (balance.balance === BigInt(0)) return

  const res = await deps.accountService.revokeCredit(
    payment.sourceAccount.id,
    balance.balance
  )
  //const res = await deps.accountService.revokeCredit({
  //  accountId: payment.sourceAccount.id,
  //  amount: balance.balance,
  //  autoApprove: true
  //})
  if (res) {
    deps.logger.warn({ error: res }, 'revoke credit error')
    throw LifecycleError.AccountServiceError
  }
}

const retryablePaymentErrors: { [paymentError in PaymentError]?: boolean } = {
  // Lifecycle errors
  PricesUnavailable: true,
  // From @interledger/pay's PaymentError:
  QueryFailed: true,
  ConnectorError: true,
  EstablishmentFailed: true,
  InsufficientExchangeRate: true,
  RateProbeFailed: true,
  IdleTimeout: true,
  ClosedByReceiver: true
}

export function canRetryError(err: Error | PaymentError): boolean {
  return err instanceof Error || !!retryablePaymentErrors[err]
}

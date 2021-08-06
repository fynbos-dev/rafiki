import * as knex from 'knex'
import { ServiceDependencies } from './service'
import { OutgoingPayment, PaymentState } from './model'
import * as lifecycle from './lifecycle'

const maxAttempts: { [key in PaymentState]: number } = {
  Inactive: 5, // quoting
  Ready: Infinity, // autoapprove
  Activated: 5, // reserve funds
  Sending: 5, // send money
  Cancelling: Infinity, // refund money
  Cancelled: 0,
  Completed: 0
}

// Returns whether a pending payment was found.
export async function processPendingPayment(
  deps_: ServiceDependencies
): Promise<boolean> {
  return deps_.knex.transaction(async (trx) => {
    const payment = await getPendingPayment({ ...deps_, knex: trx })
    if (!payment) return false

    await handlePaymentLifecycle(
      {
        ...deps_,
        knex: trx,
        logger: deps_.logger.child({
          payment: payment.id,
          from_state: payment.state
        })
      },
      payment
    )
    return true
  })
  //}, { isolationLevel: 'repeatable read' })
}

// Exported for testing.
export async function getPendingPayment(
  deps: ServiceDependencies
): Promise<OutgoingPayment | undefined> {
  const payments = await OutgoingPayment.query(deps.knex)
    .select('id')
    .limit(1)
    // Don't wait for a payment that is already busy.
    .skipLocked()
    // Ensure the payment cannot be processed concurrently by multiple workers.
    .forUpdate()
    .whereIn('state', [
      PaymentState.Inactive,
      PaymentState.Activated,
      PaymentState.Sending,
      PaymentState.Cancelling
    ])
    .orWhere((builder: knex.QueryBuilder) => {
      builder
        .where('state', PaymentState.Ready)
        .andWhere((builder: knex.QueryBuilder) => {
          builder
            .where('intentAutoApprove', true)
            .orWhere('quoteActivationDeadline', '<', new Date().toISOString())
        })
    })
  if (payments.length === 0) return
  return payments[0]
}

// Exported for testing.
export async function handlePaymentLifecycle(
  deps: ServiceDependencies,
  payment: OutgoingPayment
): Promise<void> {
  //const payment = await OutgoingPayment.query(deps.knex).forUpdate().findById(paymentId)

  const onError = async (
    err: Error | lifecycle.PaymentError
  ): Promise<void> => {
    const error = typeof err === 'string' ? err : err.message
    const attempts = payment.attempts + 1
    if (payment.state === PaymentState.Cancelling) {
      // The payment was explicitly cancelled, so don't retry.
      deps.logger.warn({ error }, 'payment lifecycle failed while cancelling')
    } else if (
      attempts < maxAttempts[payment.state] &&
      lifecycle.canRetryError(err)
    ) {
      // TODO backoff between attempts?
      deps.logger.warn(
        { state: payment.state, error, attempts },
        'payment lifecycle failed; retrying'
      )
      await payment.$query().patch({ attempts })
    } else {
      // Too many attempts; cancel payment.
      deps.logger.warn(
        { state: payment.state, error, attempts },
        'payment lifecycle failed; cancelling'
      )
      await payment.$query().patch({ state: PaymentState.Cancelling, error })
    }
  }

  switch (payment.state) {
    case PaymentState.Inactive:
      return lifecycle.handleQuoting(deps, payment).catch(onError)
    case PaymentState.Ready:
      return lifecycle.handleReady(deps, payment).catch(onError)
    case PaymentState.Activated:
      return lifecycle.handleActivation(deps, payment).catch(onError)
    case PaymentState.Sending:
      return lifecycle.handleSending(deps, payment).catch(onError)
    case PaymentState.Cancelling:
      return lifecycle.handleCancelling(deps, payment).catch(onError)
    default:
      deps.logger.warn('unexpected payment in lifecycle')
      break
  }
}

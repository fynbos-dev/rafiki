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

// Returns the id of the proceed payment (if any).
export async function processPendingPayment(
  deps_: ServiceDependencies
): Promise<string | undefined> {
  return deps_.knex.transaction(async (trx) => {
    const payment = await getPendingPayment({ ...deps_, knex: trx })
    if (!payment) return

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
    return payment.id
  })
  //}, { isolationLevel: 'repeatable read' })
}

// Exported for testing.
export async function getPendingPayment(
  deps: ServiceDependencies
): Promise<OutgoingPayment | undefined> {
  const payments = await OutgoingPayment.query(deps.knex)
    .limit(1)
    // Ensure the payment cannot be processed concurrently by multiple workers.
    .forUpdate()
    // Don't wait for a payment that is already busy.
    .skipLocked()
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
  const onError = async (
    err: Error | lifecycle.PaymentError
  ): Promise<void> => {
    console.log(
      'ON_ERROR',
      err,
      payment.state,
      'canRetryError:',
      lifecycle.canRetryError(err)
    ) // XXX
    const error = typeof err === 'string' ? err : err.message
    const attempts = payment.attempts + 1

    if (
      payment.state === PaymentState.Cancelling ||
      (attempts < maxAttempts[payment.state] && lifecycle.canRetryError(err))
    ) {
      // TODO backoff between attempts?
      deps.logger.warn(
        { state: payment.state, error, attempts },
        'payment lifecycle failed; retrying'
      )
      await payment.$query(deps.knex).patch({ attempts })
    } else {
      // Too many attempts; cancel payment.
      deps.logger.warn(
        { state: payment.state, error, attempts },
        'payment lifecycle failed; cancelling'
      )
      await payment
        .$query(deps.knex)
        .patch({ state: PaymentState.Cancelling, error })
    }
  }

  // Plugins are cleaned up in `finally` to avoid leaking http2 connections.
  let plugin: IlpPlugin
  switch (payment.state) {
    case PaymentState.Inactive:
      plugin = deps.makeIlpPlugin(payment.sourceAccount.id)
      return lifecycle
        .handleQuoting(deps, payment, plugin)
        .catch(onError)
        .finally(() => {
          plugin.disconnect().catch((err: Error) => {
            deps.logger.warn(
              { error: err.message },
              'error disconnecting plugin'
            )
          })
        })
    case PaymentState.Ready:
      return lifecycle.handleReady(deps, payment).catch(onError)
    case PaymentState.Activated:
      return lifecycle.handleActivation(deps, payment).catch(onError)
    case PaymentState.Sending:
      plugin = deps.makeIlpPlugin(payment.sourceAccount.id)
      return lifecycle
        .handleSending(deps, payment, plugin)
        .catch(onError)
        .finally(() => {
          plugin.disconnect().catch((err: Error) => {
            deps.logger.warn(
              { error: err.message },
              'error disconnecting plugin'
            )
          })
        })
    case PaymentState.Cancelling:
      return lifecycle.handleCancelling(deps, payment).catch(onError)
    default:
      deps.logger.warn('unexpected payment in lifecycle')
      break
  }
}

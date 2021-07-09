import { BaseService } from '../shared/baseService'
import { PaymentIntent } from './model'

export interface PaymentIntentService {
  get(id: string): Promise<PaymentIntent>
  create(params: PaymentIntentParameters): Promise<PaymentIntent>
}

export type ServiceDependencies = BaseService

type PaymentIntentParameters =
  | {
      paymentPointer: string
      amountToSend: BigInt
    }
  | {
      invoiceUrl: string
    }

export async function createPaymentIntentService(
  deps_: ServiceDependencies
): Promise<PaymentIntentService> {
  const deps = Object.assign({}, deps_, {
    logger: deps.logger.child({ service: 'PaymentIntentService' })
  })
  return {
    get: (id) => getPaymentIntent(deps, id),
    create: (params: PaymentIntentParameters) =>
      createPaymentIntent(deps, params)
  }
}

async function getPaymentIntent(
  deps: ServiceDependencies,
  id: string
): Promise<PaymentIntent> {
  return PaymentIntent.query(deps.knex).findById(id)
}

async function createPaymentIntent(
  deps: ServiceDependencies,
  params: PaymentIntentParameters
): Promise<PaymentIntent> {
  return PaymentIntent.query(deps.knex).insertAndFetch(params)
}

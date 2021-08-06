import { PaymentProgress } from './model'
import { BaseService } from '../shared/baseService'

export interface PaymentProgressService {
  get(paymentId: string): Promise<PaymentProgress | undefined>
  create(paymentId: string): Promise<PaymentProgress>
}

type ServiceDependencies = BaseService

export async function createPaymentProgressService(
  deps_: ServiceDependencies
): Promise<PaymentProgressService> {
  const deps: ServiceDependencies = {
    ...deps_,
    logger: deps_.logger.child({
      service: 'PaymentProgressService'
    })
  }
  return {
    get: (paymentId: string) => getPaymentProgress(deps, paymentId),
    create: (paymentId: string) => createPaymentProgress(deps, paymentId)
  }
}

async function getPaymentProgress(
  deps: ServiceDependencies,
  paymentId: string
): Promise<PaymentProgress | undefined> {
  return PaymentProgress.query(deps.knex).findById(paymentId)
}

async function createPaymentProgress(
  deps: ServiceDependencies,
  paymentId: string
): Promise<PaymentProgress> {
  return PaymentProgress.query(deps.knex).insertAndFetch({
    id: paymentId,
    amountSent: BigInt(0),
    amountDelivered: BigInt(0)
  })
}

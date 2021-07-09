import { BaseService } from '../shared/baseService'

export interface LockService {
  get(id: string): Promise<Lock>
  create(): Promise<Lock>
}

export type ServiceDependencies = BaseService

export async function createLockService(
  deps_: ServiceDependencies
): Promise<LockService> {
  const deps = Object.assign({}, deps_, {
    logger: deps.logger.child({ service: 'LockService' })
  })
  return {
    get: (id) => getLock(deps, id),
    create: () => createLock(deps)
  }
}

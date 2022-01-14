import axios, { AxiosResponse } from 'axios'
import { BaseService } from '../shared/baseService'

export interface HydraService {
  introspectToken: (token: string) => Promise<AxiosResponse['data']>
  getLoginRequest: (challenge: string) => Promise<AxiosResponse['data']>
  acceptLoginRequest: (
    challenge: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    body: any
  ) => Promise<AxiosResponse['data']>
  rejectLoginRequest: (
    challenge: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    body: any
  ) => Promise<AxiosResponse['data']>
  getConsentRequest: (challenge: string) => Promise<AxiosResponse['data']>
  acceptConsentRequest: (
    challenge: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    body: any
  ) => Promise<AxiosResponse['data']>
  rejectConsentRequest: (
    challenge: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    body: any
  ) => Promise<AxiosResponse['data']>
  getLogoutRequest: (challenge: string) => Promise<AxiosResponse['data']>
  acceptLogoutRequest: (challenge: string) => Promise<AxiosResponse['data']>
  rejectLogoutRequest: (challenge: string) => Promise<AxiosResponse['data']>
  createOauthClient: (
    clientDetails: Oauth2ClientDetails
  ) => Promise<AxiosResponse['data']>
}

type Oauth2ClientDetails = {
  client_id: string
  client_name: string
  scope: string
  response_types: string[]
  grant_types: string[]
  redirect_uris: string[]
  logo_uri: string
}

interface ServiceDependencies extends BaseService {
  hydraAdminUrl: string
  mockTlsTermination: Record<string, string | boolean>
}

type Flow = 'login' | 'consent' | 'logout'
type Action = 'accept' | 'reject'

export async function createHydraService({
  logger,
  knex,
  hydraAdminUrl,
  mockTlsTermination
}: ServiceDependencies): Promise<HydraService> {
  const log = logger.child({
    service: 'HydraService'
  })
  const deps: ServiceDependencies = {
    logger: log,
    knex,
    hydraAdminUrl,
    mockTlsTermination
  }
  return {
    getLoginRequest: (challenge: string) => get(deps, 'login', challenge),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    acceptLoginRequest: (challenge: string, body: any) =>
      put(deps, 'login', 'accept', challenge, body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    rejectLoginRequest: (challenge: string, body: any) =>
      put(deps, 'login', 'reject', challenge, body),
    getConsentRequest: (challenge: string) => get(deps, 'consent', challenge),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    acceptConsentRequest: (challenge: string, body: any) =>
      put(deps, 'consent', 'accept', challenge, body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    rejectConsentRequest: (challenge: string, body: any) =>
      put(deps, 'consent', 'reject', challenge, body),
    getLogoutRequest: (challenge: string) => get(deps, 'logout', challenge),
    acceptLogoutRequest: (challenge: string) =>
      put(deps, 'logout', 'accept', challenge, {}),
    rejectLogoutRequest: (challenge: string) =>
      put(deps, 'logout', 'reject', challenge, {}),
    introspectToken: (token) => introspectToken(deps, token),
    createOauthClient: (clientDetails: Oauth2ClientDetails) =>
      createOauthClient(deps, clientDetails)
  }
}

// A little helper that takes type (can be "login" or "consent") and a challenge and returns the response from ORY Hydra.
async function get(
  deps: ServiceDependencies,
  flow: Flow,
  challenge: string
): Promise<AxiosResponse['data']> {
  const url = new URL('/oauth2/auth/requests/' + flow, deps.hydraAdminUrl)
  url.searchParams.set(`${flow}_challenge`, challenge)
  const res = await axios.get(url.toString(), {
    headers: deps.mockTlsTermination,
    timeout: 5000
  })
  return res.data
}

// A little helper that takes type (can be "login" or "consent"), the action (can be "accept" or "reject") and a challenge and returns the response from ORY Hydra.
async function put(
  deps: ServiceDependencies,
  flow: Flow,
  action: Action,
  challenge: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  body: any
): Promise<AxiosResponse['data']> {
  const url = new URL(
    '/oauth2/auth/requests/' + flow + '/' + action,
    deps.hydraAdminUrl
  )
  url.searchParams.set(`${flow}_challenge`, challenge)
  const headers = deps.mockTlsTermination
  headers['Content-Type'] = 'application/json'
  const res = await axios.put(url.toString(), body, {
    headers,
    timeout: 5000
  })
  return res.data
}

async function createOauthClient(
  deps: ServiceDependencies,
  clientDetails: Oauth2ClientDetails
): Promise<AxiosResponse['data']> {
  const url = new URL('/clients', deps.hydraAdminUrl)
  const headers = deps.mockTlsTermination
  headers['Content-Type'] = 'application/json'
  const res = await axios.post(url.toString(), clientDetails, { headers })
  return res.data
}

async function introspectToken(
  deps: ServiceDependencies,
  token: string
): Promise<AxiosResponse['data']> {
  const url = new URL('/oauth2/introspect', deps.hydraAdminUrl)
  const headers = deps.mockTlsTermination
  headers['Content-Type'] = 'application/x-www-form-urlencoded'
  const body = new URLSearchParams({ token }).toString()
  const res = await axios.post(url.toString(), body, { headers })
  return res.data
}

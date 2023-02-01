import type { LinksFunction, MetaFunction } from '@remix-run/node'
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData
} from '@remix-run/react'
import { CONFIG } from './lib/parse_config.server'

export const loader = () => {
  return CONFIG
}

export const meta: MetaFunction = ({ data }) => {
  return {
    charset: 'utf-8',
    title: data.seed.meta.name,
    viewport: 'width=device-width,initial-scale=1'
  }
}

export const links: LinksFunction = () => {
  return [
    {
      rel: 'stylesheet',
      href: 'https://cdn.jsdelivr.net/npm/bootstrap@5.2.0/dist/css/bootstrap.min.css'
    },
    {
      rel: 'stylesheet',
      href: 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.9.1/font/bootstrap-icons.css'
    }
  ]
}


export default function App() {
  const data = useLoaderData()

  return (
    <html lang='en'>
      <head>
        <Meta />
        <Links />
        <link
          rel='icon'
          href={data.seed.self.hostname + '.ico'}
          type='image/png'
        />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
        <LiveReload />
      </body>
    </html>
  )
}

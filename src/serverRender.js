import React, { Fragment } from 'react'
import ReactDOMServer from 'react-dom/server'
import StaticRouter from 'react-router-dom/StaticRouter'
const Q = require('q')
const url = require('url')
const debug = require('debug')('react-ssr:serverRender')
const { matchRoutes, renderRoutes } = require('react-router-config')
const DefaultTemplate = require('./components/DefaultTemplate')
const findAllDataCalls = require('./helpers/findAllDataCalls')
const { SSRProvider } = require('./ssrContext')
require('regenerator-runtime/runtime.js')

const fetchPageFromCache = async (redisClient, key) => {
  let data

  try {
    data = await redisClient.get(key)
  } catch (e) {
    console.warn(`Failed to get cached page for ${key}`)
  }

  return data
}

const storePageInCache = async (redisClient, key, data, cacheExpiry) => {
  try {
    await redisClient.set(key, data, 'ex', cacheExpiry)
  } catch (e) {
    console.warn(`Failed to set cached page for ${key}`)
  }
}

const serverRender = async ({
  Html = DefaultTemplate,
  Providers = ({ children }) => <Fragment>{children}</Fragment>,
  routes,
  disable,
  ignore = [],
  cache = {
    mode: 'none',
    duration: 1800,
    redisClient: null,
    keyPrefix: ''
  }
}, req, res) => {
  const urlWithoutQuery = req.url.split('?')[0]

  if (disable || ignore.includes(urlWithoutQuery)) {
    const html = ReactDOMServer.renderToString(<Html />)
    return res.send(`<!DOCTYPE html>${html}`)
  }

  const { redisClient } = cache || {}
  const extensionRegex = /(?:\.([^.]+))?$/
  const extension = extensionRegex.exec(urlWithoutQuery)[1]
  const hasRedis = redisClient && typeof redisClient.exists === 'function' && typeof redisClient.get === 'function'
  const cacheActive = hasRedis && cache && cache.mode === 'full'
  const readCache = cacheActive && (req.useCacheForRequest || req.readCache)
  const writeCache = cacheActive && (req.useCacheForRequest || req.writeCache)

  if (extension) {
    return res.sendStatus(404)
  }

  // does req.url include query parameters? do we want to cache routes with query parameters?
  if (readCache) {
    const key = `${cache.keyPrefix}${req.url}`

    if (await redisClient.exists(key)) {
      const cachedPage = await fetchPageFromCache(redisClient, key)

      if (cachedPage) {
        if (cache.keyPrefix) {
          res.set('X-Cache-Prefix', cache.keyPrefix)
        }

        return res.status(200).send(cachedPage)
      }
    }
  }

  const context = {}
  const state = {}
  // const component = props => renderRoutes(props.route.routes)
  // const cleansedRoutes = [{ component, routes }]
  const matchedRoutes = matchRoutes(routes, urlWithoutQuery)
  const lastRoute = matchedRoutes[matchedRoutes.length - 1] || {}
  const parsedUrl = url.parse(req.url) || {}
  const dataCalls = findAllDataCalls(matchedRoutes, { req, res, url: parsedUrl.pathname })
  const statusCode = (lastRoute && lastRoute.route && lastRoute.route.path && lastRoute.route.path.includes('*')) ? 404 : 200

  if (!parsedUrl.pathname) {
    debug('Parsed URL has no path name.')
  }

  debug('Routes? ', routes)

  Q.allSettled(dataCalls)
    .then(async fetchedProps => {
      debug('Fetched props... ', fetchedProps)

      const filteredProps = {}
      let preventCaching = false

      fetchedProps.forEach(props => {
        const fetchedObject = props.value
        const keyOfFetchedObject = Object.keys(fetchedObject)[0]
        const objectOfFetchedValues = fetchedObject[keyOfFetchedObject]
        if (!objectOfFetchedValues._excludeFromHydration) {
          filteredProps[keyOfFetchedObject] = objectOfFetchedValues
        }
        if (objectOfFetchedValues._preventCaching) preventCaching = true
      })

      state._dataFromServerRender = filteredProps

      const app = ReactDOMServer.renderToString((
        <SSRProvider value={filteredProps}>
          <Providers>
            <StaticRouter location={req.url} context={context}>
              {renderRoutes(routes)}
            </StaticRouter>
          </Providers>
        </SSRProvider>
      ))

      const wrapper = ReactDOMServer.renderToString(<Html state={state}>{app}</Html>)
      const page = `<!DOCTYPE html>${wrapper}`
      const status = req.status || statusCode

      if (!preventCaching && writeCache && status >= 200 && status < 300) {
        const { duration = 1800, keyPrefix = '' } = cache
        const key = `${keyPrefix}${req.url}`
        await storePageInCache(redisClient, key, page, duration)
      }

      res.status(status).send(page)
    })
    .catch(err => {
      res.status(400).send(`400: An error has occurred: ${err}`)
    })
}

export default serverRender
